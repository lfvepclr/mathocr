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
  copyWordBtnHTML: '',
  // Result panel mode: 'flow' (reflowed markdown) or 'layout' (bbox-faithful)
  viewMode: localStorage.getItem('ocr_view_mode') || 'flow',

  // Lasso selection state (rubber-band multi-block copy on the image panel)
  selectMode: false,
  selectedBlocks: new Set(),
  _band: null,          // {x1,y1,x2,y2,moved} client coords while dragging
  _selCopyHTML: '',

  // Zoom: the image panel fits width by default (fitZoom); the layout
  // canvas zooms independently so fitting a large image never shrinks it.
  fitZoom: 1.0,
  layoutZoom: 1.0,
  _userZoomed: false,   // true after manual zoom — resize keeps user zoom

  // block_label -> Chinese display name (covers the 27 Baidu layout types
  // plus the local engine's labels)
  LABEL_MAP: {
    doc_title: '文档标题', paragraph_title: '标题', text: '正文',
    table: '表格', formula: '公式', image: '图片',
    figure_title: '图题', table_title: '表题', header: '页眉',
    footer: '页脚', footnote: '脚注', chart: '图表',
    seal: '印章', abstract: '摘要', reference: '参考文献',
    contents: '目录', algorithm: '算法',
    aside_text: '旁注', vertical_text: '竖排文本',
    inline_formula: '行内公式', formula_number: '公式编号',
    number: '页码', reference_content: '文献内容',
    header_image: '页眉图片', footer_image: '页脚图片',
  },

  // block_label -> overlay CSS class, used when the engine reports no
  // confidence score (online engines). Mirrors image_annotator.LABEL_COLORS.
  LABEL_CLASS_MAP: {
    text: 't-text', aside_text: 't-text', vertical_text: 't-text',
    doc_title: 't-title', paragraph_title: 't-title',
    table: 't-table',
    formula: 't-formula', inline_formula: 't-formula',
    formula_number: 't-formula',
    image: 't-image', chart: 't-image',
    header_image: 't-image', footer_image: 't-image',
    seal: 't-seal',
    figure_title: 't-caption', table_title: 't-caption',
    header: 't-header', footer: 't-header', number: 't-header',
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

    // Lasso select mode + rubber band + selection bar (both panels share
    // the same selectMode and selection set)
    document.getElementById('select-mode-btn').addEventListener('click', () => this.toggleSelectMode());
    document.getElementById('select-mode-btn-r').addEventListener('click', () => this.toggleSelectMode());
    imgContainer.addEventListener('mousedown', (e) => this.bandStart(e, 'img'));
    imgContainer.addEventListener('mousemove', (e) => this.bandMove(e, 'img'));
    const mdPanel = document.getElementById('markdown-container');
    mdPanel.addEventListener('mousedown', (e) => this.bandStart(e, 'result'));
    mdPanel.addEventListener('mousemove', (e) => this.bandMove(e, 'result'));
    document.addEventListener('mouseup', (e) => this.bandEnd(e));
    const selCopy = document.getElementById('selection-copy');
    this._selCopyHTML = selCopy.innerHTML;
    selCopy.addEventListener('click', () => this.copySelection());
    document.getElementById('selection-clear').addEventListener('click', () => this.clearSelection());

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

    // Layout block hover — same linkage as markdown blocks
    const layoutContainer = document.getElementById('layout-content');
    layoutContainer.addEventListener('mouseover', (e) => {
      const block = e.target.closest('.layout-block');
      if (!block) return;
      const idx = parseInt(block.dataset.blockIdx, 10);
      if (idx !== this.hoverIdx) this.setHover(idx, 'md');
    });
    layoutContainer.addEventListener('mouseleave', () => this.scheduleClearHover());

    // Wheel / pinch zoom over the layout canvas mirrors the image panel
    const mdWrap = document.getElementById('markdown-container');
    mdWrap.addEventListener('wheel', (e) => {
      if (this.viewMode !== 'layout') return;
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomAt(e, Math.exp(-e.deltaY * 0.002), 'layout');
    }, { passive: false });
    mdWrap.addEventListener('gesturestart', (e) => {
      if (this.viewMode !== 'layout') return;
      e.preventDefault();
      this._gestureZoom = App.state.zoom;
    });
    mdWrap.addEventListener('gesturechange', (e) => {
      if (this.viewMode !== 'layout') return;
      e.preventDefault();
      if (this._gestureZoom) {
        this.zoomAt(e, (this._gestureZoom * e.scale) / App.state.zoom, 'layout');
      }
    });

    // Fullscreen toggles
    document.getElementById('left-fullscreen').addEventListener('click', () => this.toggleFullscreen('left-panel'));
    document.getElementById('right-fullscreen').addEventListener('click', () => this.toggleFullscreen('right-panel'));
    document.getElementById('fullscreen-close').addEventListener('click', () => this.closeFullscreen());

    // Sync scroll toggle
    document.getElementById('sync-scroll').addEventListener('click', (e) => {
      App.state.syncScroll = !App.state.syncScroll;
      e.currentTarget.classList.toggle('active', App.state.syncScroll);
    });

    // Result view mode toggle (flow / layout)
    document.querySelectorAll('#result-view-toggle .btn-toggle').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.rmode === this.viewMode);
      btn.addEventListener('click', () => this.setViewMode(btn.dataset.rmode));
    });
    this.syncViewModeUI();

    // Copy whole page to Word (rich text: headings/tables/images survive)
    const copyWordBtn = document.getElementById('copy-word-btn');
    this.copyWordBtnHTML = copyWordBtn.innerHTML;
    copyWordBtn.addEventListener('click', () => this.copyPageToWord());

    // Sync scroll handlers
    const leftContainer = document.getElementById('image-container');
    const rightContainer = document.getElementById('markdown-container');
    leftContainer.addEventListener('scroll', () => this.handleScroll('left'));
    rightContainer.addEventListener('scroll', () => this.handleScroll('right'));

    // Export dropdown: toggle menu, close on outside click, run export
    const exportMenu = document.getElementById('export-menu');
    document.getElementById('export-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.style.display = exportMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#export-dropdown')) exportMenu.style.display = 'none';
    });
    exportMenu.querySelectorAll('.export-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        exportMenu.style.display = 'none';
        const [scope, format] = item.dataset.export.split('-');
        this.exportFile(format, scope);
      });
    });

    // Instant tooltips, resizable split divider, fit-width on resize
    this.initInstantTooltips();
    this.initSplitDivider();
    new ResizeObserver(() => {
      if (!this._userZoomed) this.refitImage();
    }).observe(document.getElementById('image-container'));

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('results-view').classList.contains('active')) {
        if (e.key === 'ArrowLeft') this.prevPage();
        if (e.key === 'ArrowRight') this.nextPage();
        if (e.key === 'Escape') {
          // Lasso state takes priority: clear selection, then exit mode
          if (this.selectedBlocks.size) this.clearSelection();
          else if (this.selectMode) this.toggleSelectMode();
          else this.closeFullscreen();
        }
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
      // Clear any lingering hover/selection state from the previous page
      clearTimeout(this._clearTimer);
      this.clearHover();
      this.clearSelection();

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

      // Export scope labels: show exactly what will be exported
      const fileName = fileInfo?.original_name || '';
      const batchFiles = App.state.batchData?.files || [];
      const scopeFileEl = document.getElementById('export-scope-file');
      const scopeBatchEl = document.getElementById('export-scope-batch');
      if (scopeFileEl) scopeFileEl.textContent = fileName ? `（${fileName}）` : '';
      if (scopeBatchEl) scopeBatchEl.textContent = batchFiles.length ? `（共 ${batchFiles.length} 个文件）` : '';
      const resultNameEl = document.getElementById('result-file-name');
      if (resultNameEl) resultNameEl.textContent = fileName ? `— ${fileName}` : '';

      // Render image (+ overlay on top of it)
      this.updateImage();
      this.renderOverlay();
      this.updateLegend();
      this.updateEngineInfo();

      // Render markdown (+ layout canvas when that mode is active)
      this.renderMarkdown(data.markdown || '*暂无内容*');
      if (this.viewMode === 'layout') this.renderLayout();

      // Reset zoom — the new page re-fits once its image loads
      this._userZoomed = false;
      this.layoutZoom = 1.0;
      this.refitImage();

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
    // Fit width once the (possibly new) image arrives; manual zoom survives
    img.onload = () => {
      if (!this._userZoomed) this.refitImage();
    };
    if (mode === 'original') {
      img.src = this.currentPageData.original_image_url;
    } else {
      img.src = this.currentPageData.annotated_image_url;
    }
    // Annotated image already carries drawn boxes — hide our overlay there
    this.updateOverlayVisibility();
  },

  // Fit-width zoom: image width matches the container's content width.
  // Called on image load, on container resize (unless the user zoomed
  // manually), on zoom-reset and after a split-divider drag.
  refitImage() {
    const img = document.getElementById('page-image');
    const container = document.getElementById('image-container');
    if (!img || !img.naturalWidth || !container.clientWidth) return;
    const fit = (container.clientWidth - 32) / img.naturalWidth;  // 16px padding ×2
    this.fitZoom = Math.min(5.0, Math.max(0.1, fit));
    App.state.zoom = this.fitZoom;
    this.applyZoom();
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
    // Engines without confidence tag their result has_score=false; colour by
    // block type instead of painting everything as one confidence band.
    const hasScore = data?.has_score !== false;

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
      this.blockScores[idx] = hasScore ? score : undefined;
      let cls;
      if (!hasScore) {
        cls = this.LABEL_CLASS_MAP[block.block_label] || 't-other';
      } else {
        cls = (score === undefined || score === null) ? 'c1'
          : score >= 0.9 ? 'c0'
          : score >= 0.75 ? 'c1'
          : score >= 0.6 ? 'c2' : 'c3';
      }

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

  // ---- Legend / engine badge ----
  updateLegend() {
    const hasScore = this.currentPageData?.has_score !== false;
    document.getElementById('confidence-legend')
      .classList.toggle('visible', hasScore);
    document.getElementById('label-legend')
      .classList.toggle('visible', !hasScore);
  },

  updateEngineInfo() {
    const el = document.getElementById('batch-engine-info');
    if (!el) return;
    const batch = App.state.batchData;
    const engineId = batch?.engine || this.currentPageData?.engine || 'local';
    const name = typeof Settings !== 'undefined'
      ? Settings.engineName(engineId) : engineId;
    const cost = Number(batch?.cost || 0);
    const calls = Number(batch?.api_calls || 0);
    if (engineId === 'local') {
      el.innerHTML = `<span class="engine-badge local">${name}</span>`;
    } else {
      const costText = typeof Settings !== 'undefined'
        ? Settings.formatCost(cost) : `¥${cost.toFixed(4)}`;
      el.innerHTML = `<span class="engine-badge online">${name}</span>`
        + `<span class="engine-cost">${calls} 次 · ${costText}</span>`;
    }
    el.style.display = 'inline-flex';
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
    const layoutBlock = document.querySelector(`#layout-content .layout-block[data-block-idx="${idx}"]`);
    if (poly) poly.classList.add('hl');
    if (mdBlock) mdBlock.classList.add('hl');
    if (layoutBlock) layoutBlock.classList.add('hl');

    if (source === 'img') {
      // Image -> text: bring the linked block into view + show tooltip
      const linked = mdBlock || layoutBlock;
      if (linked) linked.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      this.showTooltip(idx, evt);
      if (poly && !this.selectMode) this.showCopyBtn(poly);
    } else {
      // Text -> image: highlight only, never auto-scroll the image panel
      if (this.selectMode) return;
      if (mdBlock) this.showCopyBtn(mdBlock);
      else if (layoutBlock) this.showCopyBtn(layoutBlock);
    }
  },

  // ---- Lasso Selection (rubber-band multi-block copy, both panels) ----
  toggleSelectMode() {
    this.selectMode = !this.selectMode;
    document.getElementById('select-mode-btn').classList.toggle('active', this.selectMode);
    document.getElementById('select-mode-btn-r').classList.toggle('active', this.selectMode);
    document.getElementById('image-container').classList.toggle('select-mode', this.selectMode);
    document.getElementById('markdown-container').classList.toggle('select-mode', this.selectMode);
    if (this.selectMode) {
      // Polygons (hit targets for the lasso) only show in original mode
      if (App.state.imageMode !== 'original') App.toggleImageMode();
      this.hideCopyBtn();
    }
    this.updateSelectionBar();
  },

  // panel: 'img' (left, original image) or 'result' (right, parsed blocks)
  bandStart(e, panel = 'img') {
    if (!this.selectMode || e.button !== 0) return;
    const el = panel === 'img'
      ? document.getElementById('page-image')
      : document.getElementById('markdown-container');
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right
        || e.clientY < rect.top || e.clientY > rect.bottom) return;
    e.preventDefault();
    this._band = { panel, x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY, moved: false };
  },

  bandMove(e, panel) {
    if (!this._band || this._band.panel !== panel) return;
    const band = this._band;
    band.x2 = e.clientX;
    band.y2 = e.clientY;
    if (Math.abs(band.x2 - band.x1) > 5 || Math.abs(band.y2 - band.y1) > 5) {
      band.moved = true;
    }
    if (panel === 'img') {
      // Position the band div in % of the image so it follows zoom/scroll
      const rect = document.getElementById('page-image').getBoundingClientRect();
      const l = Math.max(0, Math.min(band.x1, band.x2) - rect.left);
      const t = Math.max(0, Math.min(band.y1, band.y2) - rect.top);
      const r = Math.min(rect.width, Math.max(band.x1, band.x2) - rect.left);
      const b = Math.min(rect.height, Math.max(band.y1, band.y2) - rect.top);
      const el = document.getElementById('select-band');
      el.style.display = 'block';
      el.style.left = (l / rect.width * 100) + '%';
      el.style.top = (t / rect.height * 100) + '%';
      el.style.width = ((r - l) / rect.width * 100) + '%';
      el.style.height = ((b - t) / rect.height * 100) + '%';
    } else {
      // Position the band div in px of container content coordinates so it
      // scrolls together with the blocks
      const container = document.getElementById('markdown-container');
      const rect = container.getBoundingClientRect();
      const x1 = Math.max(rect.left, Math.min(band.x1, band.x2));
      const y1 = Math.max(rect.top, Math.min(band.y1, band.y2));
      const x2 = Math.min(rect.right, Math.max(band.x1, band.x2));
      const y2 = Math.min(rect.bottom, Math.max(band.y1, band.y2));
      const el = document.getElementById('select-band-r');
      el.style.display = 'block';
      el.style.left = (x1 - rect.left + container.scrollLeft) + 'px';
      el.style.top = (y1 - rect.top + container.scrollTop) + 'px';
      el.style.width = (x2 - x1) + 'px';
      el.style.height = (y2 - y1) + 'px';
    }
  },

  bandEnd(e) {
    if (!this._band) return;
    const band = this._band;
    this._band = null;
    document.getElementById(band.panel === 'img' ? 'select-band' : 'select-band-r')
      .style.display = 'none';
    if (!this.selectMode) return;

    if (band.panel === 'result') {
      if (!band.moved) {
        // Click: toggle the block under the cursor
        const blockEl = e.target.closest?.('.md-block, .layout-block');
        if (blockEl && blockEl.dataset.blockIdx !== undefined) {
          const idx = Number(blockEl.dataset.blockIdx);
          if (this.selectedBlocks.has(idx)) this.selectedBlocks.delete(idx);
          else this.selectedBlocks.add(idx);
        }
      } else {
        // Rubber band: add every visible block whose client rect intersects
        const x1 = Math.min(band.x1, band.x2), y1 = Math.min(band.y1, band.y2);
        const x2 = Math.max(band.x1, band.x2), y2 = Math.max(band.y1, band.y2);
        document.querySelectorAll(this._rightBlockSelector()).forEach(el => {
          if (el.dataset.blockIdx === undefined) return;
          const r = el.getBoundingClientRect();
          if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) {
            this.selectedBlocks.add(Number(el.dataset.blockIdx));
          }
        });
      }
      this.renderSelection();
      return;
    }

    const res = this.currentPageData?.json?.res || this.currentPageData?.json || {};
    const coordW = res.width || res.page_width;
    const coordH = res.height || res.page_height;
    if (!coordW || !coordH) return;
    const rect = document.getElementById('page-image').getBoundingClientRect();

    if (!band.moved) {
      // Click: toggle the smallest block whose bbox contains the point
      const px = (e.clientX - rect.left) / rect.width * coordW;
      const py = (e.clientY - rect.top) / rect.height * coordH;
      const idx = this.blockAtPoint(px, py);
      if (idx !== null) {
        if (this.selectedBlocks.has(idx)) this.selectedBlocks.delete(idx);
        else this.selectedBlocks.add(idx);
      }
    } else {
      // Rubber band: add every block whose bbox intersects the band rect
      const x1 = Math.max(0, (Math.min(band.x1, band.x2) - rect.left) / rect.width * coordW);
      const y1 = Math.max(0, (Math.min(band.y1, band.y2) - rect.top) / rect.height * coordH);
      const x2 = Math.min(coordW, (Math.max(band.x1, band.x2) - rect.left) / rect.width * coordW);
      const y2 = Math.min(coordH, (Math.max(band.y1, band.y2) - rect.top) / rect.height * coordH);
      this.currentBlocks.forEach((block, idx) => {
        const bb = block.block_bbox;
        if (!bb || bb.length !== 4) return;
        if (bb[0] < x2 && bb[2] > x1 && bb[1] < y2 && bb[3] > y1) {
          this.selectedBlocks.add(idx);
        }
      });
    }
    this.renderSelection();
  },

  blockAtPoint(px, py) {
    // Smallest containing bbox wins (titles often wrap body text lines)
    let best = null, bestArea = Infinity;
    this.currentBlocks.forEach((block, idx) => {
      const bb = block.block_bbox;
      if (!bb || bb.length !== 4) return;
      if (px >= bb[0] && px <= bb[2] && py >= bb[1] && py <= bb[3]) {
        const area = (bb[2] - bb[0]) * (bb[3] - bb[1]);
        if (area < bestArea) { bestArea = area; best = idx; }
      }
    });
    return best;
  },

  renderSelection() {
    document.querySelectorAll('#overlay-svg polygon.sel').forEach(p => p.classList.remove('sel'));
    document.querySelectorAll('#markdown-content .md-block.sel, #layout-content .layout-block.sel')
      .forEach(b => b.classList.remove('sel'));
    this.selectedBlocks.forEach(idx => {
      const poly = document.querySelector(`#overlay-svg polygon[data-block-idx="${idx}"]`);
      if (poly) poly.classList.add('sel');
      const md = document.querySelector(`#markdown-content .md-block[data-block-idx="${idx}"]`);
      if (md) md.classList.add('sel');
      const lb = document.querySelector(`#layout-content .layout-block[data-block-idx="${idx}"]`);
      if (lb) lb.classList.add('sel');
    });
    this.updateSelectionBar();
  },

  updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    const n = this.selectedBlocks.size;
    bar.style.display = (this.selectMode || n > 0) ? 'flex' : 'none';
    document.getElementById('selection-count').textContent = `已选 ${n} 块`;
    document.getElementById('selection-copy').disabled = n === 0;
  },

  clearSelection() {
    this.selectedBlocks.clear();
    this.renderSelection();
  },

  // Copy the lassoed blocks to Word as one rich-text fragment (reading order
  // is restored server-side via ?blocks=)
  async copySelection() {
    const idxs = [...this.selectedBlocks];
    if (!idxs.length) return;
    const btn = document.getElementById('selection-copy');
    let done = false;
    try {
      const batchId = App.state.currentBatch;
      const fileId = App.state.currentFile;
      const pageId = App.state.currentPage;
      const resp = await fetch(`/api/page_richtext/${batchId}/${fileId}/${pageId}?blocks=${idxs.join(',')}`);
      const data = await resp.json();
      if (!data.error && data.html) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([data.html], { type: 'text/html' }),
          'text/plain': new Blob([data.text || ''], { type: 'text/plain' }),
        })]);
        done = true;
      }
    } catch (e) {
      console.warn('Selection rich copy failed, using plain text:', e);
    }
    if (!done) {
      const text = idxs.sort((a, b) => a - b)
        .map(i => this.currentBlocks[i]?.block_content || '')
        .filter(Boolean).join('\n\n');
      try { await navigator.clipboard.writeText(text); } catch (_) { /* ignore */ }
    }
    this.flashCopied(btn, this._selCopyHTML);
  },

  scheduleClearHover() {
    clearTimeout(this._clearTimer);
    this._clearTimer = setTimeout(() => this.clearHover(), 120);
  },

  clearHover() {
    this.hoverIdx = null;
    document.querySelectorAll('#overlay-svg polygon.hl').forEach(p => p.classList.remove('hl'));
    document.querySelectorAll('#markdown-content .md-block.hl').forEach(b => b.classList.remove('hl'));
    document.querySelectorAll('#layout-content .layout-block.hl').forEach(b => b.classList.remove('hl'));
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

    // Prefer Word-friendly rich text (headings/tables/images survive);
    // fall back to the plain block text on any failure.
    let done = false;
    try {
      done = await this.copyRichText(idx);
    } catch (e) {
      console.warn('Rich block copy failed, using plain text:', e);
    }
    if (!done) {
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
    }

    const btn = document.getElementById('block-copy-btn');
    this.flashCopied(btn, this.copyBtnHTML);
  },

  // ---- Copy to Word (rich text via /api/page_richtext) ----
  async copyPageToWord() {
    const btn = document.getElementById('copy-word-btn');
    try {
      await this.copyRichText(null);
    } catch (e) {
      console.warn('Rich page copy failed, using plain markdown:', e);
      try {
        await navigator.clipboard.writeText(this.currentPageData?.markdown || '');
      } catch (_) { /* ignore */ }
    }
    this.flashCopied(btn, this.copyWordBtnHTML, '✓');
  },

  // Fetch richtext for the page (or a single block) and write both
  // text/html and text/plain to the clipboard so Word keeps formatting.
  async copyRichText(blockIdx) {
    const batchId = App.state.currentBatch;
    const fileId = App.state.currentFile;
    const pageId = App.state.currentPage;
    if (!batchId || fileId === null || fileId === undefined
        || pageId === null || pageId === undefined) return false;
    let url = `/api/page_richtext/${batchId}/${fileId}/${pageId}`;
    if (blockIdx !== null && blockIdx !== undefined) url += `?block=${blockIdx}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error || !data.html) return false;
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([data.html], { type: 'text/html' }),
      'text/plain': new Blob([data.text || ''], { type: 'text/plain' }),
    })]);
    return true;
  },

  flashCopied(btn, originalHTML, label = '✓ 已复制') {
    btn.classList.add('copied');
    btn.innerHTML = label;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = originalHTML;
    }, 1200);
  },

  // ---- Result View Mode (flow / layout) ----
  setViewMode(mode) {
    this.viewMode = mode;
    localStorage.setItem('ocr_view_mode', mode);
    document.querySelectorAll('#result-view-toggle .btn-toggle').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.rmode === mode);
    });
    this.syncViewModeUI();
    if (mode === 'layout') {
      this.renderLayout();
      this.applyZoom();
    }
  },

  syncViewModeUI() {
    document.getElementById('markdown-content').style.display =
      this.viewMode === 'flow' ? '' : 'none';
    document.getElementById('layout-content').style.display =
      this.viewMode === 'layout' ? '' : 'none';
  },

  // marked swallows the backslash in `\(` as a CommonMark escape before
  // KaTeX ever sees it (siliconflow blocks use \(...\) delimiters) —
  // rewrite \(...\) / \[...\] to $...$ / $$...$$ before marked.parse.
  normalizeLatexDelims(md) {
    return md
      .replace(/\\\[(.+?)\\\]/gs, (_, t) => `$$${t}$$`)
      .replace(/\\\((.+?)\\\)/gs, (_, t) => `$${t}$`);
  },

  // marked parses a leading "3. " as an ordered list (<ol start=3>) whose
  // marker box sits outside the content box — the global CSS reset removes
  // the ol padding, so the number vanishes (clipped by overflow:hidden in
  // the layout view). Single-line blocks are headings/captions, never real
  // lists: escape the enumerator dot/paren so it renders literally.
  protectLeadingEnum(md) {
    if (md.includes('\n')) return md;
    return md.replace(/^(\s*\d{1,9})([.)])(\s)/, '$1\\$2$3');
  },

  // Block markdown -> HTML shared by the flow and layout views.
  parseBlockMd(content) {
    return window.marked.parse(
      this.protectLeadingEnum(this.normalizeLatexDelims(content)));
  },

  // A block is a pure image when its label says so, or its whole content
  // is a single <img> tag. Tables EMBED <img> cells — checking a bare
  // includes('<img') would misroute them and dump raw pipe markdown.
  isPureImageBlock(label, content) {
    const IMG_LABELS = ['image', 'chart', 'seal', 'header_image', 'footer_image'];
    if (IMG_LABELS.includes(label)) return true;
    return /^<img[^>]*\/?>$/.test(content.trim());
  },

  // ---- Layout (position-faithful) Rendering ----
  // Every block is absolutely positioned by its bbox percentages on a
  // canvas with the page's aspect ratio — a visual facsimile of the
  // original document. Block data, markdown and the flow view stay
  // untouched; this is purely a presentation layer.
  renderLayout() {
    const container = document.getElementById('layout-content');
    const data = this.currentPageData;
    const res = data?.json?.res || data?.json || {};
    const blocks = res.parsing_res_list || [];
    const coordW = res.width || res.page_width;
    const coordH = res.height || res.page_height;

    if (!blocks.length || !coordW || !coordH) {
      container.innerHTML = '<div class="layout-empty">该页无版面数据，无法还原原始布局</div>';
      return;
    }

    // Image-like blocks with empty block_content get their <img> from the
    // full-page markdown in reading order (same rule as the flow view).
    const imgTags = (data.markdown || '').match(/<img[^>]*>/g) || [];
    let imgCursor = 0;
    
    const html = blocks.map((block, idx) => {
      const [x1, y1, x2, y2] = block.block_bbox || [0, 0, coordW, coordH];
      const label = block.block_label || '';
      const content = block.block_content || '';
      const style = `left:${(x1 / coordW * 100).toFixed(3)}%;`
        + `top:${(y1 / coordH * 100).toFixed(3)}%;`
        + `width:${((x2 - x1) / coordW * 100).toFixed(3)}%;`
        + `height:${((y2 - y1) / coordH * 100).toFixed(3)}%;`;

      let body = '';
      if (this.isPureImageBlock(label, content)) {
        const tag = content.includes('<img') ? content : (imgTags[imgCursor++] || '');
        if (tag) {
          body = tag.replace(/^<img/, '<img style="width:100%;height:100%;object-fit:fill;"');
        }
      } else if (window.marked) {
        body = this.parseBlockMd(content);
      } else {
        body = content.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      }
      return `<div class="layout-block" data-block-idx="${idx}" data-label="${label}" style="${style}"><div class="lb-body">${body}</div></div>`;
    }).join('');

    container.innerHTML =
      `<div class="layout-canvas" style="aspect-ratio:${coordW}/${coordH}">${html}</div>`;

    // LaTeX, then fix relative image paths to the page-image API
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
    container.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src && !src.startsWith('/') && !src.startsWith('http') && !src.startsWith('data:')) {
        img.src = '/api/page_image/' +
          App.state.currentBatch + '/' +
          App.state.currentFile + '/' +
          App.state.currentPage + '/' + src;
      }
    });

    this.fitLayoutBlocks(container);
  },

  // Shrink-to-fit: estimate font size from the block box, then shrink in
  // small steps until the content fits (hard floor at 6px; overflow hidden
  // guarantees no spill even when the floor is reached). Only pure image
  // blocks skip fitting — tables embed images but their text must fit.
  fitLayoutBlocks(container) {
    container.querySelectorAll('.layout-block').forEach(block => {
      const body = block.querySelector('.lb-body');
      if (!body) return;
      const label = block.dataset.label || '';
      const onlyChild = body.children.length === 1 ? body.children[0] : null;
      if (onlyChild && onlyChild.tagName === 'IMG'
          && this.isPureImageBlock(label, '')) return;   // image blocks need no fitting
      const W = block.clientWidth, H = block.clientHeight;
      if (!W || !H) return;
      const len = Math.max((body.textContent || '').length, 1);
      let fs = Math.min(H * 0.8, Math.sqrt(W * H * 1.9 / len));
      fs = Math.max(6, Math.min(fs, 28));
      body.style.fontSize = fs + 'px';
      for (let i = 0; i < 15 && fs > 6
           && (body.scrollHeight > H || body.scrollWidth > W); i++) {
        fs = Math.max(6, fs * 0.92);
        body.style.fontSize = fs + 'px';
      }
    });
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
      //
      // Image/chart blocks have EMPTY block_content in the JSON — the actual
      // <img> tags live only in the full-page markdown. Extract them in
      // reading order and inject one into each image-like block.
      const imgTags = text.match(/<img[^>]*>/g) || [];
      let imgCursor = 0;
      container.innerHTML = blocks.map((block, idx) => {
        const label = block.block_label || '';
        const labelZh = this.LABEL_MAP[label] || label;
        let content = block.block_content || '';
        if (!content.includes('<img') &&
            (label === 'image' || label === 'chart' || label === 'seal')) {
          const tag = imgTags[imgCursor] || '';
          imgCursor++;
          if (tag) content = `<div style="text-align:center">${tag}</div>`;
        }
        const body = this.parseBlockMd(content);
        return `<div class="md-block" data-block-idx="${idx}" data-label="${label}">
          <span class="md-block-tag">${labelZh}</span>
          <div class="md-block-body">${body}</div>
        </div>`;
      }).join('');
    } else if (window.marked) {
      // Fallback for legacy results without parsing_res_list
      container.innerHTML = window.marked.parse(this.normalizeLatexDelims(text));
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
    this._userZoomed = true;
    this.applyZoom();
  },

  zoomOut() {
    App.state.zoom = Math.max(App.state.zoom - 0.25, 0.1);
    this._userZoomed = true;
    this.applyZoom();
  },

  zoomReset() {
    // Back to fit-width; resize tracking resumes
    this._userZoomed = false;
    this.refitImage();
  },

  // Zoom around a specific pointer position (wheel / pinch).
  // target: 'image' panel (default) or 'layout' canvas in the right panel.
  zoomAt(e, factor, target) {
    const isLayout = target === 'layout';
    const oldZoom = isLayout ? this.layoutZoom : App.state.zoom;
    const newZoom = Math.min(Math.max(oldZoom * factor, 0.1), 5.0);
    if (newZoom === oldZoom) return;

    if (isLayout) {
      const canvas = document.querySelector('#layout-content .layout-canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
      const py = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
      this.layoutZoom = newZoom;
      this.applyZoom(`${px}% ${py}%`);
      return;
    }

    // Image panel: size-based zoom — anchor the pixel under the pointer by
    // measuring before/after and correcting the scroll position.
    const img = document.getElementById('page-image');
    const container = document.getElementById('image-container');
    if (!img || !img.naturalWidth) return;
    const r1 = img.getBoundingClientRect();
    const fx = (e.clientX - r1.left) / Math.max(r1.width, 1);
    const fy = (e.clientY - r1.top) / Math.max(r1.height, 1);
    App.state.zoom = newZoom;
    this._userZoomed = true;
    this.applyZoom();
    const r2 = img.getBoundingClientRect();
    container.scrollLeft += (r2.left + fx * r2.width) - e.clientX;
    container.scrollTop += (r2.top + fy * r2.height) - e.clientY;
  },

  applyZoom(origin) {
    // Image panel: size-based zoom — the img display width IS naturalWidth
    // × zoom, so the wrapper's fit-content layout box always equals the
    // visual size: margin:auto centres at fit width and the two panels'
    // midlines align. (transform:scale() never shrinks the layout box —
    // the oversized natural-width box broke margin:auto centring and the
    // top-center origin pushed the scaled image off to the right.)
    const img = document.getElementById('page-image');
    if (img && img.naturalWidth) {
      img.style.width = (img.naturalWidth * App.state.zoom) + 'px';
    }
    // The layout canvas zooms independently of the image panel; its layout
    // width already equals the container's, so transform is safe there.
    const canvas = document.querySelector('#layout-content .layout-canvas');
    if (canvas) {
      canvas.style.transform = `scale(${this.layoutZoom})`;
      if (this.layoutZoom > 1) {
        canvas.style.transformOrigin = origin || 'top left';
        canvas.style.margin = '0';
      } else {
        canvas.style.transformOrigin = origin || 'top center';
        canvas.style.margin = '0 auto';
      }
    }
  },

  // ---- Instant tooltips ----
  // Native title tooltips lag ~1s; move title -> data-tip on toolbar
  // buttons and show our own bubble immediately on hover.
  initInstantTooltips() {
    const scopes = document.querySelectorAll(
      '#left-panel .panel-controls, #right-panel .panel-controls,'
      + ' #top-bar .top-bar-controls');
    scopes.forEach(scope => {
      scope.querySelectorAll('[title]').forEach(el => {
        el.dataset.tip = el.getAttribute('title');
        el.removeAttribute('title');
      });
    });

    const tip = document.createElement('div');
    tip.className = 'instant-tooltip';
    tip.style.display = 'none';
    document.body.appendChild(tip);
    this._tipEl = tip;

    document.addEventListener('mouseover', (e) => {
      const host = e.target.closest('[data-tip]');
      if (!host) {
        tip.style.display = 'none';
        return;
      }
      tip.textContent = host.dataset.tip;
      tip.style.display = 'block';
      const r = host.getBoundingClientRect();
      tip.style.left = `${r.left + r.width / 2}px`;
      tip.style.top = `${r.bottom + 6}px`;
    });
    document.addEventListener('click', () => { tip.style.display = 'none'; });
    window.addEventListener('scroll', () => { tip.style.display = 'none'; }, true);
  },

  // ---- Resizable split divider ----
  // Dragging sets the left panel to a fixed pixel width (right stays
  // flex:1); persisted so the comparison layout survives reloads.
  initSplitDivider() {
    const divider = document.getElementById('split-divider');
    const left = document.getElementById('left-panel');
    const split = document.getElementById('split-view');
    if (!divider || !left || !split) return;

    const clampW = (w) => {
      const total = split.getBoundingClientRect().width;
      return Math.max(280, Math.min(w, total - 280));
    };
    const saved = parseInt(localStorage.getItem('ocr_split_left') || '0', 10);
    if (saved > 0) {
      const apply = () => { left.style.flex = `0 0 ${clampW(saved)}px`; };
      if (split.getBoundingClientRect().width >= 600) {
        apply();
      } else {
        // The split view is still hidden (zero width) — clampW would
        // collapse the saved width to the 280px floor. Apply once the
        // container gets laid out instead.
        const ro = new ResizeObserver(() => {
          if (split.getBoundingClientRect().width < 600) return;
          ro.disconnect();
          apply();
        });
        ro.observe(split);
      }
    }

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      divider.classList.add('dragging');
      const startX = e.clientX;
      const startW = left.getBoundingClientRect().width;
      let lastW = startW;
      const onMove = (ev) => {
        lastW = clampW(startW + (ev.clientX - startX));
        left.style.flex = `0 0 ${lastW}px`;
      };
      const onUp = () => {
        divider.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('ocr_split_left', String(Math.round(lastW)));
        // The wider/narrower panel deserves a fresh fit unless user-zoomed
        if (!this._userZoomed) this.refitImage();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
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

  // ---- Synchronized Scrolling (anchor-block based) ----
  // Both panels share block indices (polygon / md-block / layout-block all
  // carry data-block-idx). The anchor line sits at 25% of the source panel's
  // height; the last block above that line is aligned to the same relative
  // position on the other side. Falls back to proportional scrolling when
  // no block data (or an unusable target) is available.

  // Anchor line ratio within the panel viewport
  ANCHOR_RATIO: 0.25,

  _anchorLeft() {
    const container = document.getElementById('image-container');
    const img = document.getElementById('page-image');
    if (!img || !img.naturalWidth || !this.currentBlocks.length) return null;
    const res = this.currentPageData?.json?.res || this.currentPageData?.json || {};
    const coordW = res.width || res.page_width;
    if (!coordW) return null;
    const imgRect = img.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const scale = imgRect.width / coordW;
    const imgTop = imgRect.top - cRect.top + container.scrollTop;  // content coords
    const anchorY = container.scrollTop + container.clientHeight * this.ANCHOR_RATIO;
    let best = null;
    this.currentBlocks.forEach((block, idx) => {
      const bb = block.block_bbox;
      if (!bb || bb.length !== 4) return;
      const top = imgTop + bb[1] * scale;
      if (top <= anchorY) best = { idx, offset: anchorY - top };
    });
    return best;
  },

  _rightBlockSelector() {
    return this.viewMode === 'layout'
      ? '#layout-content .layout-block'
      : '#markdown-content .md-block';
  },

  _anchorRight() {
    // Under layout zoom (CSS transform) client rects no longer map linearly
    // to content coordinates — bail out so the caller falls back.
    if (this.viewMode === 'layout' && this.layoutZoom !== 1) return null;
    const container = document.getElementById('markdown-container');
    const blocks = container.querySelectorAll(this._rightBlockSelector());
    if (!blocks.length) return null;
    const cRect = container.getBoundingClientRect();
    const anchorY = container.scrollTop + container.clientHeight * this.ANCHOR_RATIO;
    let best = null;
    blocks.forEach(el => {
      if (el.dataset.blockIdx === undefined) return;
      const top = el.getBoundingClientRect().top - cRect.top + container.scrollTop;
      if (top <= anchorY) best = { idx: Number(el.dataset.blockIdx), offset: anchorY - top };
    });
    return best;
  },

  _scrollLeftTo(idx, offset) {
    const container = document.getElementById('image-container');
    const img = document.getElementById('page-image');
    const block = this.currentBlocks[idx];
    if (!img || !img.naturalWidth || !block) return false;
    const bb = block.block_bbox;
    if (!bb || bb.length !== 4) return false;
    const res = this.currentPageData?.json?.res || this.currentPageData?.json || {};
    const coordW = res.width || res.page_width;
    if (!coordW) return false;
    const imgRect = img.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const scale = imgRect.width / coordW;
    const imgTop = imgRect.top - cRect.top + container.scrollTop;
    const blockTop = imgTop + bb[1] * scale;
    container.scrollTop = blockTop + offset - container.clientHeight * this.ANCHOR_RATIO;
    return true;
  },

  _scrollRightTo(idx, offset) {
    if (this.viewMode === 'layout' && this.layoutZoom !== 1) return false;
    const container = document.getElementById('markdown-container');
    const el = container.querySelector(`${this._rightBlockSelector()}[data-block-idx="${idx}"]`);
    if (!el) return false;
    const cRect = container.getBoundingClientRect();
    const top = el.getBoundingClientRect().top - cRect.top + container.scrollTop;
    container.scrollTop = top + offset - container.clientHeight * this.ANCHOR_RATIO;
    return true;
  },

  handleScroll(source) {
    if (!App.state.syncScroll || this.scrollSyncLock) return;
    this.scrollSyncLock = true;

    const left = document.getElementById('image-container');
    const right = document.getElementById('markdown-container');

    if (source === 'left') {
      const a = this._anchorLeft();
      const synced = a ? this._scrollRightTo(a.idx, a.offset) : false;
      if (!synced && left.scrollHeight > left.clientHeight) {
        const pct = left.scrollTop / (left.scrollHeight - left.clientHeight);
        right.scrollTop = pct * (right.scrollHeight - right.clientHeight);
      }
    } else {
      const a = this._anchorRight();
      const synced = a ? this._scrollLeftTo(a.idx, a.offset) : false;
      if (!synced && right.scrollHeight > right.clientHeight) {
        const pct = right.scrollTop / (right.scrollHeight - right.clientHeight);
        left.scrollTop = pct * (left.scrollHeight - left.clientHeight);
      }
    }

    setTimeout(() => { this.scrollSyncLock = false; }, 50);
  },

  // ---- Export ----
  // scope: 'file' (current file only) or 'batch' (all files, with separators)
  exportFile(format, scope = 'file') {
    const batchId = App.state.currentBatch;
    if (!batchId) return;

    let url = `/api/export/${batchId}?format=${format}`;
    if (scope === 'file') {
      const fileId = App.state.currentFile;
      if (!fileId) return;
      url += `&file_id=${fileId}`;
    }
    window.open(url, '_blank');
  },
};
