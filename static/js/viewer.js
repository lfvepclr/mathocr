/* ============================================================
   Viewer — Page comparison: annotated image + rendered markdown
   Features: zoom, fullscreen, sync scroll, page navigation, export
   ============================================================ */

const Viewer = {
  currentPageData: null,
  totalPages: 1,
  scrollSyncLock: false,

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
      this.totalPages = fileInfo?.pages?.length || data.page_id + 1 || 1;

      // Update page indicator
      document.getElementById('page-indicator').textContent =
        `${pageId + 1} / ${this.totalPages}`;

      // Update nav button states
      document.getElementById('prev-page').disabled = pageId <= 0;
      document.getElementById('next-page').disabled = pageId >= this.totalPages - 1;

      // Render image
      this.updateImage();

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
  },

  // ---- Markdown Rendering ----
  renderMarkdown(text) {
    const container = document.getElementById('markdown-content');

    // Use marked.js to parse markdown
    if (window.marked) {
      // Configure marked to allow HTML (for tables, images, divs)
      window.marked.setOptions({
        breaks: true,
        gfm: true,
      });
      container.innerHTML = window.marked.parse(text);
    } else {
      // Fallback: just set as text
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

  applyZoom() {
    const img = document.getElementById('page-image');
    img.style.transform = `scale(${App.state.zoom})`;
    if (App.state.zoom > 1) {
      // Zoomed in: anchor to top-left so the left edge stays reachable via scroll
      img.style.transformOrigin = 'top left';
      img.style.margin = '0';
    } else {
      // Fit / zoomed out: center horizontally
      img.style.transformOrigin = 'top center';
      img.style.margin = '0 auto';
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
