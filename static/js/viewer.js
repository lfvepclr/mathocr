/* ============================================================
   Viewer — Page comparison: annotated image + rendered markdown
   Features: zoom, fullscreen, sync scroll, page navigation, export,
             SVG region overlay, bidirectional hover linkage, block copy
   ============================================================ */

const Viewer = {
  currentPageData: null,
  totalPages: 1,
  scrollSyncLock: false,

  // Region overlay state
  overlayVisible: localStorage.getItem('ocr_overlay') !== '0', // default ON
  currentBlocks: [],   // parsing_res_list of the current page
  blockScores: {},     // block idx -> confidence score
  hoverIdx: null,
  _clearTimer: null,
  copyBtnHTML: '',

  // block_label -> Chinese display name
  LABEL_MAP: {
    doc_title: '文档标题', paragraph_title: '标题', text: '正文',
    table: '表格', formula: '公式', image: '图片',
    figure_title: '图题', table_title: '表题', header: '页眉',
    footer: '页脚', footnote: '脚注', chart: '图表',
    seal: '印章', abstract: '摘要', reference: '参考文献',
    contents: '目录', algorithm: '算法',
  },

  init() {
    // Page navigation
    document.getElementById('prev-page').addEventListener('click', () => this.prevPage());
    document.getElementById('next-page').addEventListener('click', () => this.nextPage());

    // Image mode toggle
    document.getElementById('image-toggle').addEventListener('click', () => App.toggleImageMode());

    // Zoom controls
    document.getElementById('zoom-in').addEventListener('click', () => this.zoomIn());
    document.getElementById('zoom-out').addEventListener('click', () => this.zoomOut());
    document.getElementById('zoom-reset').addEventListener('click', () => this.zoomReset());

    // Wheel / pinch zoom on the image panel.
    // - Trackpad pinch reports as wheel with ctrlKey=true (Chrome/Edge/Safari)
    // - Mouse: Ctrl/Cmd + wheel
    // Plain wheel keeps its default scroll behaviour.
    const imgContainer = document.getElementById('image-container');
    imgContainer.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomAt(e, Math.exp(-e.deltaY * 0.002));
    }, { passive: false });

    // Safari trackpad pinch fires non-standard gesture events instead
    imgContainer.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      this._gestureZoom = App.state.zoom;
    });
    imgContainer.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (this._gestureZoom) {
        this.zoomAt(e, (this._gestureZoom * e.scale) / App.state.zoom);
      }
    });

    // Overlay toggle
    const ovlBtn = document.getElementById('overlay-toggle');
    ovlBtn.classList.toggle('active', this.overlayVisible);
    ovlBtn.addEventListener('click', () => this.toggleOverlay());

    // Block copy button (single floating button, repositioned on hover)
    const copyBtn = document.getElementById('block-copy-btn');
    this.copyBtnHTML = copyBtn.innerHTML;
    copyBtn.addEventListener('click', () => this.copyHoveredBlock());
    copyBtn.addEventListener('mouseenter', () => clearTimeout(this._clearTimer));
    copyBtn.addEventListener('mouseleave', () => this.scheduleClearHover());

    // Markdown block hover — event delegation so re-renders need no rebind
    const mdContainer = document.getElementById('markdown-content');
    mdContainer.addEventListener('mouseover', (e) => {
      const block = e.target.closest('.md-block');
      if (!block) return;
      const idx = parseInt(block.dataset.blockIdx, 10);
      if (idx !== this.hoverIdx) this.setHover(idx, 'md');
    });
    mdContainer.addEventListener('mouseleave', () => this.scheduleClearHover());

    // Fullscreen toggles
    document.getElementById('left-fullscreen').addEventListener('click', () => this.toggleFullscreen('left-panel'));
    document.getElementById('right-fullscreen').addEventListener('click', () => this.toggleFullscreen('right-panel'));
    document.getElementById('fullscreen-close').addEventListener('click', () => this.closeFullscreen());

    // Sync scroll toggle
    document.getElementById('sync-scroll').addEventListener('click', (e) => {
      App.state.syncScroll = !App.state.syncScroll;
      e.currentTarget.classList.toggle('active', App.state.syncScroll);
    });

    // Sync scroll handlers
    const leftContainer = document.getElementById('image-container');
    const rightContainer = document.getElementById('markdown-container');
    leftContainer.addEventListener('scroll', () => this.handleScroll('left'));
    rightContainer.addEventListener('scroll', () => this.handleScroll('right'));

    // Export buttons
    document.getElementById('export-md').addEventListener('click', () => this.exportFile('md'));
    document.getElementById('export-docx').addEventListener('click', () => this.exportFile('docx'));

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('results-view').classList.contains('active')) {
        if (e.key === 'ArrowLeft') this.prevPage();
        if (e.key === 'ArrowRight') this.nextPage();
        if (e.key === 'Escape') this.closeFullscreen();
      }
    });
  },

  // ---- File Tabs ----
  renderFileTabs(files) {
    const container = document.getElementById('file-tabs');
    if (!files || files.length === 0) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = files.map(f => {
      const icon = f.file_type === 'pdf' ? '📄' : '🖼';
      return `<div class="file-tab" data-file-id="${f.file_id}" title="${f.original_name}">
        ${icon} ${f.original_name}
      </div>`;
    }).join('');

    // Bind click
    container.querySelectorAll('.file-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const fileId = tab.dataset.fileId;
        App.openFile(fileId, 0);
      });
    });
  },

  // ---- Page Loading ----
  async loadPage(batchId, fileId, pageId) {
    try {
      // Clear any lingering hover state from the previous page
      clearTimeout(this._clearTimer);
      this.clearHover();

      const resp = await fetch(`/api/batch/${batchId}/file/${fileId}/page/${pageId}`);
      const data = await resp.json();

      if (data.error) {
        document.getElementById('markdown-content').innerHTML =
          `<p style="color:#ef4444;">${data.error}</p>`;
        return;
      }

      this.currentPageData = data;
      App.state.currentPage = pageId;

      // Get file info from batch data to determine total pages
      const fileInfo = (App.state.batchData?.files || []).find(f => f.file_id === fileId);
      this.totalPages = fileInfo?.pages?.length || fileInfo?.total_pages || data.page_id + 1 || 1;

      // Update page indicator
      document.getElementById('page-indicator').textContent =
        `${pageId + 1} / ${this.totalPages}`;

      // Update nav button states
      document.getElementById('prev-page').disabled = pageId <= 0;
      document.getElementById('next-page').disabled = pageId >= this.totalPages - 1;

      // Render image (+ overlay on top of it)
      this.updateImage();
      this.renderOverlay();

      // Render markdown
      this.renderMarkdown(data.markdown || '*暂无内容*');

      // Reset zoom
      App.state.zoom = 1.0;
      this.applyZoom();

      // Reset scroll positions
      document.getElementById('image-container').scrollTop = 0;
      document.getElementById('markdown-container').scrollTop = 0;

    } catch (err) {
      console.error('Failed to load page:', err);
      document.getElementById('markdown-content').innerHTML =
        '<p style="color:#ef4444;">加载失败</p>';
    }
  },

  // ---- Image Update ----
  updateImage() {
    if (!this.currentPageData) return;
    const img = document.getElementById('page-image');
    const mode = App.state.imageMode;
    if (mode === 'original') {
      img.src = this.currentPageData.original_image_url;
    } else {
      img.src = this.currentPageData.annotated_image_url;
    }
    // Annotated image already carries drawn boxes — hide our overlay there
    this.updateOverlayVisibility();
  },

  // ---- Region Overlay (SVG polygons over the original image) ----
  renderOverlay() {
    const svg = document.getElementById('overlay-svg');
    svg.innerHTML = '';
    this.currentBlocks = [];
    this.blockScores = {};

    const data = this.currentPageData;
    const res = data?.json?.res || data?.json || {};
    const blocks = res.parsing_res_list || [];
    const coordW = res.width || res.page_width;
    const coordH = res.height || res.page_height;

    this.currentBlocks = blocks;

    if (!blocks.length || !coordW || !coordH) {
      this.updateOverlayVisibility();
      return;
    }

    // Confidence per block: pair layout_det_res.boxes with blocks via order
    const detBoxes = res.layout_det_res?.boxes || [];
    const scoreByOrder = {};
    detBoxes.forEach(b => { scoreByOrder[b.order] = b.score; });

    svg.setAttribute('viewBox', `0 0 ${coordW} ${coordH}`);

    const SVG_NS = 'http://www.w3.org/2000/svg';
    blocks.forEach((block, idx) => {
      let pts = block.block_polygon_points || [];
      let pointsAttr = '';
      if (pts.length >= 3) {
        pointsAttr = pts.map(p => p.join(',')).join(' ');
      } else if (Array.isArray(block.block_bbox) && block.block_bbox.length === 4) {
        const [x1, y1, x2, y2] = block.block_bbox;
        pointsAttr = `${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2}`;
      } else {
        return;
      }

      const score = scoreByOrder[block.block_order];
      this.blockScores[idx] = score;
      const cls = (score === undefined || score === null) ? 'c1'
        : score >= 0.9 ? 'c0'
        : score >= 0.75 ? 'c1'
        : score >= 0.6 ? 'c2' : 'c3';

      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', pointsAttr);
      poly.setAttribute('class', `ovl ${cls}`);
      poly.dataset.blockIdx = idx;
      poly.addEventListener('mouseenter', (e) => this.setHover(idx, 'img', e));
      poly.addEventListener('mousemove', (e) => this.moveTooltip(e));
      poly.addEventListener('mouseleave', () => this.scheduleClearHover());
      svg.appendChild(poly);
    });

    this.updateOverlayVisibility();
  },

  updateOverlayVisibility() {
    const svg = document.getElementById('overlay-svg');
    const show = this.overlayVisible
      && App.state.imageMode === 'original'
      && svg.childElementCount > 0;
    svg.style.display = show ? '' : 'none';
  },

  toggleOverlay() {
    this.overlayVisible = !this.overlayVisible;
    localStorage.setItem('ocr_overlay', this.overlayVisible ? '1' : '0');
    document.getElementById('overlay-toggle').classList.toggle('active', this.overlayVisible);
    this.updateOverlayVisibility();
  },

  // ---- Bidirectional Hover Linkage ----
  setHover(idx, source, evt) {
    clearTimeout(this._clearTimer);
    this.clearHover();
    this.hoverIdx = idx;

    const poly = document.querySelector(`#overlay-svg polygon[data-block-idx="${idx}"]`);
    const mdBlock = document.querySelector(`#markdown-content .md-block[data-block-idx="${idx}"]`);
    if (poly) poly.classList.add('hl');
    if (mdBlock) mdBlock.classList.add('hl');

    if (source === 'img') {
      // Image -> text: bring the linked block into view + show tooltip
      if (mdBlock) mdBlock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      this.showTooltip(idx, evt);
      if (poly) this.showCopyBtn(poly);
    } else {
      // Text -> image: highlight only, never auto-scroll the image panel
      if (mdBlock) this.showCopyBtn(mdBlock);
    }
  },

  scheduleClearHover() {
    clearTimeout(this._clearTimer);
    this._clearTimer = setTimeout(() => this.clearHover(), 120);
  },

  clearHover() {
    this.hoverIdx = null;
    document.querySelectorAll('#overlay-svg polygon.hl').forEach(p => p.classList.remove('hl'));
    document.querySelectorAll('#markdown-content .md-block.hl').forEach(b => b.classList.remove('hl'));
    this.hideTooltip();
    this.hideCopyBtn();
  },

  // ---- Tooltip (label + confidence, follows cursor on overlay) ----
  showTooltip(idx, evt) {
    const block = this.currentBlocks[idx];
    if (!block || !evt) return;
    const tip = document.getElementById('overlay-tooltip');
    const label = this.LABEL_MAP[block.block_label] || block.block_label || '';
    const score = this.blockScores[idx];
    tip.textContent = (score !== undefined && score !== null)
      ? `${label} · ${Number(score).toFixed(2)}`
      : label;
    tip.style.display = 'block';
    this.moveTooltip(evt);
  },

  moveTooltip(evt) {
    const tip = document.getElementById('overlay-tooltip');
    if (tip.style.display === 'none') return;
    const x = Math.min(evt.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(evt.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  },

  hideTooltip() {
    document.getElementById('overlay-tooltip').style.display = 'none';
  },

  // ---- Block Copy ----
  showCopyBtn(el) {
    const btn = document.getElementById('block-copy-btn');
    const rect = el.getBoundingClientRect();
    btn.style.display = 'flex';
    const w = btn.offsetWidth;
    const h = btn.offsetHeight;
    let left = rect.right - w - 8;
    let top = rect.top + 2;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  },

  hideCopyBtn() {
    document.getElementById('block-copy-btn').style.display = 'none';
  },

  async copyHoveredBlock() {
    const idx = this.hoverIdx;
    if (idx === null || idx === undefined) return;
    const block = this.currentBlocks[idx];
    if (!block) return;
    const text = block.block_content || '';

    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
    }

    const btn = document.getElementById('block-copy-btn');
    btn.classList.add('copied');
    btn.innerHTML = '✓ 已复制';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = this.copyBtnHTML;
    }, 1200);
  },

  // ---- Markdown Rendering ----
  renderMarkdown(text) {
    const container = document.getElementById('markdown-content');

    const data = this.currentPageData;
    const res = data?.json?.res || data?.json || {};
    const blocks = res.parsing_res_list || [];

    if (window.marked) {
      // Configure marked to allow HTML (for tables, images, divs)
      window.marked.setOptions({
        breaks: true,
        gfm: true,
      });
    }

    if (blocks.length && window.marked) {
      // Per-block rendering: each recognition region becomes a .md-block so
      // it can be hover-linked with its overlay polygon and copied alone.
      // NOTE: title blocks carry no '#' prefix in block_content (paddlex adds
      // them only when concatenating the full-page markdown) — CSS styles
      // them via data-label instead.
      container.innerHTML = blocks.map((block, idx) => {
        const label = block.block_label || '';
        const labelZh = this.LABEL_MAP[label] || label;
        const body = window.marked.parse(block.block_content || '');
        return `<div class="md-block" data-block-idx="${idx}" data-label="${label}">
          <span class="md-block-tag">${labelZh}</span>
          <div class="md-block-body">${body}</div>
        </div>`;
      }).join('');
    } else if (window.marked) {
      // Fallback for legacy results without parsing_res_list
      container.innerHTML = window.marked.parse(text);
    } else {
      container.textContent = text;
    }

    // Render LaTeX with KaTeX
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(container, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      } catch (e) {
        console.warn('KaTeX render error:', e);
      }
    }

    // Fix image paths — ensure they point to API
    container.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      // If src is a relative path (not starting with / or http), prepend /api/
      if (src && !src.startsWith('/') && !src.startsWith('http') && !src.startsWith('data:')) {
        img.src = '/api/page_image/' +
          App.state.currentBatch + '/' +
          App.state.currentFile + '/' +
          App.state.currentPage + '/' + src;
      }
    });
  },

  // ---- Page Navigation ----
  prevPage() {
    if (App.state.currentPage > 0) {
      this.loadPage(App.state.currentBatch, App.state.currentFile, App.state.currentPage - 1);
    }
  },

  nextPage() {
    if (App.state.currentPage < this.totalPages - 1) {
      this.loadPage(App.state.currentBatch, App.state.currentFile, App.state.currentPage + 1);
    }
  },

  // ---- Zoom ----
  zoomIn() {
    App.state.zoom = Math.min(App.state.zoom + 0.25, 5.0);
    this.applyZoom();
  },

  zoomOut() {
    App.state.zoom = Math.max(App.state.zoom - 0.25, 0.25);
    this.applyZoom();
  },

  zoomReset() {
    App.state.zoom = 1.0;
    this.applyZoom();
  },

  // Zoom around a specific pointer position (wheel / pinch)
  zoomAt(e, factor) {
    const oldZoom = App.state.zoom;
    const newZoom = Math.min(Math.max(oldZoom * factor, 0.25), 5.0);
    if (newZoom === oldZoom) return;

    const wrapper = document.getElementById('image-wrapper');
    const rect = wrapper.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
    const py = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 100;

    App.state.zoom = newZoom;
    this.applyZoom(`${px}% ${py}%`);
  },

  applyZoom(origin) {
    // Scale the wrapper so the image and its SVG overlay zoom together
    const wrapper = document.getElementById('image-wrapper');
    wrapper.style.transform = `scale(${App.state.zoom})`;
    if (App.state.zoom > 1) {
      // Zoomed in: anchor to top-left so the left edge stays reachable via scroll
      wrapper.style.transformOrigin = origin || 'top left';
      wrapper.style.margin = '0';
    } else {
      // Fit / zoomed out: center horizontally
      wrapper.style.transformOrigin = origin || 'top center';
      wrapper.style.margin = '0 auto';
    }
  },

  // ---- Fullscreen ----
  toggleFullscreen(panelId) {
    const panel = document.getElementById(panelId);
    const closeBtn = document.getElementById('fullscreen-close');

    // Close any existing fullscreen
    document.querySelectorAll('.panel.fullscreen').forEach(p => {
      if (p !== panel) p.classList.remove('fullscreen');
    });

    panel.classList.toggle('fullscreen');
    closeBtn.style.display = panel.classList.contains('fullscreen') ? 'flex' : 'none';
  },

  closeFullscreen() {
    document.querySelectorAll('.panel.fullscreen').forEach(p => {
      p.classList.remove('fullscreen');
    });
    document.getElementById('fullscreen-close').style.display = 'none';
  },

  // ---- Synchronized Scrolling ----
  handleScroll(source) {
    if (!App.state.syncScroll || this.scrollSyncLock) return;
    this.scrollSyncLock = true;

    if (source === 'left') {
      const left = document.getElementById('image-container');
      const right = document.getElementById('markdown-container');
      if (left.scrollHeight > left.clientHeight) {
        const pct = left.scrollTop / (left.scrollHeight - left.clientHeight);
        right.scrollTop = pct * (right.scrollHeight - right.clientHeight);
      }
    } else {
      const left = document.getElementById('image-container');
      const right = document.getElementById('markdown-container');
      if (right.scrollHeight > right.clientHeight) {
        const pct = right.scrollTop / (right.scrollHeight - right.clientHeight);
        left.scrollTop = pct * (left.scrollHeight - left.clientHeight);
      }
    }

    setTimeout(() => { this.scrollSyncLock = false; }, 50);
  },

  // ---- Export ----
  exportFile(format) {
    const batchId = App.state.currentBatch;
    const fileId = App.state.currentFile;
    if (!batchId || !fileId) return;

    const url = `/api/export/${batchId}?format=${format}&file_id=${fileId}`;
    window.open(url, '_blank');
  },
};
