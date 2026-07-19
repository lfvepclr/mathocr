/* ============================================================
   App — Main coordinator: state, routing, view switching
   ============================================================ */

const App = {
  state: {
    currentBatch: null,
    currentFile: null,
    currentPage: 0,
    viewMode: 'split',
    imageMode: 'annotated',
    zoom: 1.0,
    syncScroll: true,
    batchData: null,
  },

  init() {
    // Initialize modules
    Sidebar.init();
    Uploader.init();
    Viewer.init();

    // Bind global events
    document.getElementById('new-parsing-btn').addEventListener('click', () => {
      App.showUploadView();
    });

    // Sidebar toggle (collapsed -> floating action button)
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    const fab = document.getElementById('sidebar-fab');

    App.toggleSidebar = function(collapsed) {
      const isCollapsed = collapsed !== undefined
        ? collapsed
        : !sidebar.classList.contains('collapsed');
      sidebar.classList.toggle('collapsed', isCollapsed);
      if (fab) fab.style.display = isCollapsed ? 'flex' : 'none';
      localStorage.setItem('sidebarCollapsed', isCollapsed);
    };

    // Restore collapsed state
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
      App.toggleSidebar(true);
    }
    toggleBtn.addEventListener('click', () => App.toggleSidebar());

    // View mode toggle
    document.querySelectorAll('.btn-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.target.dataset.mode;
        App.setViewMode(mode);
      });
    });

    // ---- Global SSE: one connection drives sidebar batch progress and
    // the home-page queue panel, regardless of which view is active ----
    App.initGlobalEvents();
    QueuePanel.refresh();
    App.startElapsedTicker();

    // Handle hash routing
    window.addEventListener('hashchange', () => App.handleRoute());
    App.handleRoute();
  },

  // ---- Global event channel ----
  initGlobalEvents() {
    let pollTimer = null;
    const startPollingFallback = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => QueuePanel.refresh(), 5000);
    };
    const stopPollingFallback = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const es = new EventSource('/api/events');
    App.globalEventSource = es;
    ['batch_queued', 'file_started', 'page_started', 'page_completed',
     'file_completed', 'batch_completed'].forEach(type => {
      es.addEventListener(type, (e) => {
        const data = JSON.parse(e.data);
        Sidebar.handleGlobalEvent(type, data);
        QueuePanel.handleEvent(type, data);
      });
    });
    // EventSource auto-reconnects; poll the queue panel while disconnected
    es.onopen = () => stopPollingFallback();
    es.onerror = () => startPollingFallback();
  },

  // ---- View switching ----
  showUploadView() {
    document.getElementById('upload-view').classList.add('active');
    document.getElementById('results-view').classList.remove('active');
    document.getElementById('confidence-legend').classList.remove('visible');
    // Deselect batch in sidebar
    document.querySelectorAll('.batch-item').forEach(el => el.classList.remove('active'));
  },

  showResultsView() {
    document.getElementById('upload-view').classList.remove('active');
    document.getElementById('results-view').classList.add('active');
    document.getElementById('confidence-legend').classList.add('visible');
  },

  // ---- Navigation ----
  async openBatch(batchId) {
    App.state.currentBatch = batchId;
    App.state.currentFile = null;
    App.state.currentPage = 0;

    // Fetch batch summary
    try {
      const resp = await fetch(`/api/batch/${batchId}`);
      const data = await resp.json();
      App.state.batchData = data;

      if (data.error) {
        alert('批次不存在');
        return;
      }

      // If still processing, subscribe to real-time progress
      if (data.status === 'processing' || data.status === 'queued') {
        Uploader.startSSE(batchId);
      }

      // Render file tabs
      Viewer.renderFileTabs(data.files || []);

      // Select first file
      if (data.files && data.files.length > 0) {
        App.openFile(data.files[0].file_id, 0);
      }

      App.showResultsView();
    } catch (err) {
      console.error('Failed to open batch:', err);
    }
  },

  async openFile(fileId, pageId = 0) {
    App.state.currentFile = fileId;
    App.state.currentPage = pageId;

    // Ensure batchData (page counts, file tabs) is available for ALL entry
    // paths — sidebar file clicks and deep links skip openBatch().
    if (!App.state.batchData || App.state.batchData.batch_id !== App.state.currentBatch) {
      try {
        const resp = await fetch(`/api/batch/${App.state.currentBatch}`);
        const data = await resp.json();
        if (!data.error) {
          App.state.batchData = data;
          Viewer.renderFileTabs(data.files || []);
        }
      } catch (err) {
        console.warn('batchData fetch failed:', err);
      }
    }

    // Update file tabs
    document.querySelectorAll('.file-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.fileId === fileId);
    });

    // Load page
    Viewer.loadPage(App.state.currentBatch, fileId, pageId);
  },

  // ---- View mode ----
  setViewMode(mode) {
    App.state.viewMode = mode;
    document.querySelectorAll('.btn-toggle').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');

    switch (mode) {
      case 'split':
        leftPanel.classList.remove('hidden');
        rightPanel.classList.remove('hidden');
        break;
      case 'original':
        leftPanel.classList.remove('hidden');
        rightPanel.classList.add('hidden');
        break;
      case 'markdown':
        leftPanel.classList.add('hidden');
        rightPanel.classList.remove('hidden');
        break;
    }
  },

  // ---- Image mode toggle ----
  toggleImageMode() {
    App.state.imageMode = App.state.imageMode === 'annotated' ? 'original' : 'annotated';
    document.getElementById('left-panel-title').textContent =
      App.state.imageMode === 'annotated' ? '标注原图' : '原始图片';
    Viewer.updateImage();
  },

  // ---- Routing ----
  handleRoute() {
    const hash = window.location.hash.slice(1); // remove #
    if (!hash || hash === '/upload') {
      App.showUploadView();
      return;
    }

    const parts = hash.split('/');
    // /batch/:batchId  or  /batch/:batchId/file/:fileId/page/:pageId
    if (parts[0] === 'batch' && parts[1]) {
      const batchId = parts[1];
      if (parts[2] === 'file' && parts[3]) {
        const fileId = parts[3];
        const pageId = parts[5] ? parseInt(parts[5]) : 0;
        App.state.currentBatch = batchId;
        App.openFile(fileId, pageId);
        App.showResultsView();
      } else {
        App.openBatch(batchId);
      }
    }
  },

  // ---- Elapsed-time ticker ----
  // Updates every .live-elapsed[data-started] element once per second.
  // data-started comes from SQLite CURRENT_TIMESTAMP (UTC, "YYYY-MM-DD HH:MM:SS").
  startElapsedTicker() {
    setInterval(() => {
      document.querySelectorAll('.live-elapsed[data-started]').forEach(el => {
        const sec = App.utcSeconds(el.dataset.started);
        if (sec !== null) el.textContent = `已耗时 ${App.formatElapsed(sec)}`;
      });
    }, 1000);
  },

  utcSeconds(ts) {
    if (!ts) return null;
    const ms = Date.parse(ts.replace(' ', 'T') + 'Z');
    if (isNaN(ms)) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 1000));
  },

  formatElapsed(sec) {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },

  // ---- Utility ----
  formatTime(timestamp) {
    if (!timestamp) return '';
    const parts = timestamp.split(' ');
    if (parts.length < 2) return timestamp;
    const datePart = parts[0].slice(5);
    const timePart = parts[1].slice(0, 5);
    return `${datePart} ${timePart}`;
  },

  formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '';
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const min = Math.floor(seconds / 60);
    const sec = Math.round(seconds % 60);
    return `${min}m${sec}s`;
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  },
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => App.init());
