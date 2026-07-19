/* ============================================================
   Uploader — Drag & drop, file upload, SSE real-time progress
   ============================================================ */

const Uploader = {
  eventSource: null,
  pollTimer: null,
  estimateTimer: null,
  _autoOpen: true,

  init() {
    const zone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');

    zone.addEventListener('click', () => fileInput.click());

    // Sidebar "new parsing" button doubles as a drop zone: create a task
    // without leaving the current results view.
    const npBtn = document.getElementById('new-parsing-btn');
    if (npBtn) {
      npBtn.title = '点击或拖拽文件到此处新建解析';
      npBtn.addEventListener('dragover', (e) => {
        e.preventDefault();
        npBtn.classList.add('dragover');
      });
      npBtn.addEventListener('dragleave', () => {
        npBtn.classList.remove('dragover');
      });
      npBtn.addEventListener('drop', (e) => {
        e.preventDefault();
        npBtn.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
          this.uploadFiles(e.dataTransfer.files, { autoOpen: false });
        }
      });
    }

    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.uploadFiles(e.target.files);
      }
    });

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        this.uploadFiles(e.dataTransfer.files);
      }
    });

    // ---- FAB (collapsed sidebar): new parsing + drag & drop target ----
    const fab = document.getElementById('sidebar-fab');
    if (fab) {
      document.getElementById('fab-new').addEventListener('click', () => {
        App.showUploadView();
      });
      document.getElementById('fab-expand').addEventListener('click', () => {
        App.toggleSidebar(false);
      });
      fab.addEventListener('dragover', (e) => {
        e.preventDefault();
        fab.classList.add('dragover');
      });
      fab.addEventListener('dragleave', () => {
        fab.classList.remove('dragover');
      });
      fab.addEventListener('drop', (e) => {
        e.preventDefault();
        fab.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
          App.showUploadView();
          this.uploadFiles(e.dataTransfer.files);
        }
      });
    }
  },

  async uploadFiles(fileList, opts = {}) {
    // autoOpen: jump to the new batch when it finishes (home-page uploads).
    // Sidebar drops pass autoOpen:false so the user is not yanked away from
    // the document they are currently reading.
    this._autoOpen = opts.autoOpen !== false;
    const files = Array.from(fileList);
    const progress = document.getElementById('upload-progress');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');

    progress.style.display = 'block';
    progressFill.style.width = '10%';
    progressText.textContent = '上传中...';

    const formData = new FormData();
    files.forEach(f => formData.append('files', f, f.name));

    try {
      progressFill.style.width = '30%';
      progressText.textContent = '上传完成,等待解析...';

      const resp = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();

      if (data.error) {
        progressText.textContent = '上传失败: ' + data.error;
        return;
      }

      progressFill.style.width = '40%';
      progressText.textContent = `批次 ${data.batch_id} 已排队,OCR 处理中...`;

      // Reflect the new task in sidebar & queue panel immediately
      Sidebar.loadBatches();
      QueuePanel.refresh();

      // Start SSE for real-time updates
      this.startSSE(data.batch_id, progressFill, progressText);
    } catch (err) {
      progressText.textContent = '上传失败: ' + err.message;
      console.error('Upload error:', err);
    }
  },

  stopEstimate() {
    if (this.estimateTimer) {
      clearInterval(this.estimateTimer);
      this.estimateTimer = null;
    }
  },

  startEstimate(progressFill, progressText, pageNum, totalPages, avgPageTime, priorPages) {
    this.stopEstimate();
    const startTime = Date.now();
    const avg = (avgPageTime > 0 ? avgPageTime : 60) * 1000;

    const render = () => {
      const elapsed = Date.now() - startTime;
      const sec = Math.round(elapsed / 1000);
      const estPct = Math.min(elapsed / avg, 0.95) * 100;
      if (progressText) {
        progressText.textContent =
          `正在解析第 ${pageNum}/${totalPages} 页 · 约 ${Math.round(estPct)}% · 已用 ${sec}s`;
      }
      if (progressFill && totalPages > 0) {
        const overall = 40 + (priorPages + estPct / 100) / totalPages * 55;
        progressFill.style.width = Math.min(overall, 95) + '%';
      }
    };
    render();
    this.estimateTimer = setInterval(render, 500);
  },

  startSSE(batchId, progressFill, progressText) {
    // Resolve progress elements when not provided (e.g. opened from a batch link)
    progressFill = progressFill || document.getElementById('progress-fill');
    progressText = progressText || document.getElementById('progress-text');
    const progressBox = document.getElementById('upload-progress');
    if (progressBox) progressBox.style.display = 'block';

    // Close any existing connection
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopEstimate();

    let fileStats = { total: 0, completed: 0, pages: 0 };

    // Try SSE first
    try {
      const es = new EventSource(`/api/events/${batchId}`);
      this.eventSource = es;

      es.addEventListener('file_started', (e) => {
        const data = JSON.parse(e.data);
        if (progressText) progressText.textContent = `正在解析: ${data.original_name || ''}`;
        if (progressFill) {
          progressFill.style.width = `${40 + fileStats.completed * 50 / Math.max(fileStats.total, 1)}%`;
        }
        if (window.Sidebar) Sidebar.handleProgressEvent('file_started', data);
      });

      es.addEventListener('page_started', (e) => {
        const data = JSON.parse(e.data);
        const totalPages = data.total_pages || 0;
        const pageNum = (data.page_id ?? 0) + 1;
        this.startEstimate(
          progressFill, progressText, pageNum, totalPages,
          data.avg_page_time || 60, data.page_id ?? 0
        );
        if (window.Sidebar) Sidebar.handleProgressEvent('page_started', data);
      });

      es.addEventListener('page_completed', (e) => {
        const data = JSON.parse(e.data);
        this.stopEstimate();
        fileStats.pages++;
        const totalPages = data.total_pages || 0;
        const done = data.completed_pages ?? fileStats.pages;
        if (progressText) {
          progressText.textContent = totalPages > 0
            ? `第 ${done}/${totalPages} 页完成 | ${data.block_count} 个文本块 (置信度: ${(data.avg_score * 100).toFixed(0)}%)`
            : `已解析 ${fileStats.pages} 页 | ${data.block_count} 个文本块 (置信度: ${(data.avg_score * 100).toFixed(0)}%)`;
        }
        if (progressFill && totalPages > 0) {
          progressFill.style.width = `${40 + done / totalPages * 55}%`;
        }
        if (window.Sidebar) Sidebar.handleProgressEvent('page_completed', data);
      });

      es.addEventListener('file_completed', (e) => {
        const data = JSON.parse(e.data);
        this.stopEstimate();
        fileStats.completed++;
        const pct = 40 + Math.round(fileStats.completed * 50 / Math.max(fileStats.total, 1));
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText && data.processing_time) {
          progressText.textContent = `已完成 ${fileStats.completed} 个文件 | 耗时 ${App.formatDuration(data.processing_time)}`;
        }
        if (window.Sidebar) Sidebar.handleProgressEvent('file_completed', data);
      });

      es.addEventListener('batch_completed', (e) => {
        const data = JSON.parse(e.data);
        es.close();
        this.eventSource = null;
        this.stopEstimate();

        if (progressFill) progressFill.style.width = '100%';
        if (progressText) {
          progressText.textContent = data.status === 'completed'
            ? `解析完成! 总耗时 ${App.formatDuration(data.processing_time)}`
            : `处理完成 (含错误) | 耗时 ${App.formatDuration(data.processing_time)}`;
        }

        Sidebar.loadBatches();
        if (this._autoOpen) setTimeout(() => App.openBatch(batchId), 500);
      });

      es.addEventListener('ping', () => {
        // Keepalive, do nothing
      });

      es.onerror = () => {
        // SSE failed, fall back to polling
        console.warn('SSE connection failed, falling back to polling');
        es.close();
        this.eventSource = null;
        this.stopEstimate();
        this.startPolling(batchId, progressFill, progressText);
      };

      // Get total file count for progress calculation
      fetch(`/api/batch/${batchId}`).then(r => r.json()).then(data => {
        fileStats.total = (data.files || []).length;
      }).catch(() => {});

    } catch (err) {
      console.warn('SSE not available, using polling:', err);
      this.startPolling(batchId, progressFill, progressText);
    }
  },

  startPolling(batchId, progressFill, progressText) {
    // Resolve progress elements when not provided
    progressFill = progressFill || document.getElementById('progress-fill');
    progressText = progressText || document.getElementById('progress-text');

    let pollCount = 0;
    this.pollTimer = setInterval(async () => {
      pollCount++;
      try {
        const resp = await fetch(`/api/batch/${batchId}`);
        const data = await resp.json();

        if (data.error) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
          if (progressText) progressText.textContent = '批次不存在';
          return;
        }

        const files = data.files || [];
        const completed = files.filter(f => f.status === 'completed').length;
        const errors = files.filter(f => f.status === 'error').length;
        const total = files.length;
        const pct = total > 0 ? 40 + Math.round((completed + errors) / total * 60) : 40;

        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText) progressText.textContent = `处理中... ${completed}/${total} 文件完成`;

        if (data.status === 'completed' || data.status === 'error') {
          clearInterval(this.pollTimer);
          this.pollTimer = null;

          if (progressFill) progressFill.style.width = '100%';
          if (progressText) {
            progressText.textContent = data.processing_time
              ? `解析完成! 总耗时 ${App.formatDuration(data.processing_time)}`
              : '解析完成!';
          }

          Sidebar.loadBatches();
          if (this._autoOpen) setTimeout(() => App.openBatch(batchId), 500);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }

      if (pollCount > 600) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
        if (progressText) progressText.textContent = '处理超时,请刷新查看状态';
      }
    }, 2000);
  },
};

/* ============================================================
   QueuePanel — Home-page task queue: lists queued/processing
   batches with live progress, driven by the global SSE channel.
   Restores itself on page load (survives refresh).
   ============================================================ */
const QueuePanel = {
  // Per-batch progress cache: {batchId: {totalFiles, doneFiles, curDone, curTotal, fileName}}
  progress: {},

  async refresh() {
    try {
      const resp = await fetch('/api/batches');
      const batches = await resp.json();
      const active = (batches || []).filter(
        b => b.status === 'queued' || b.status === 'processing'
      );
      this.render(active);
    } catch (err) {
      console.warn('QueuePanel refresh failed:', err);
    }
  },

  render(activeBatches) {
    const box = document.getElementById('task-queue');
    const list = document.getElementById('task-queue-list');
    if (!box || !list) return;
    if (!activeBatches.length) {
      box.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    box.style.display = 'block';
    list.innerHTML = activeBatches.map(b => this.renderCard(b)).join('');
    list.querySelectorAll('.task-card').forEach(card => {
      card.addEventListener('click', () => App.openBatch(card.dataset.batchId));
    });
    // Re-apply cached live progress onto freshly rendered cards
    Object.keys(this.progress).forEach(bid => this.applyToCard(bid));
  },

  renderCard(b) {
    const statusText = b.status === 'queued' ? '排队' : '处理中';
    const name = b.alias || b.batch_id;
    return `<div class="task-card" data-batch-id="${b.batch_id}" data-file-count="${b.file_count || 1}">
      <div class="task-card-head">
        <span class="task-card-name" title="${name}">${name}</span>
        <span class="batch-status ${b.status}">${statusText}</span>
      </div>
      <div class="task-card-progress">${b.status === 'queued' ? '排队中...' : '准备中...'}</div>
      <div class="file-progress-bar"><div class="file-progress-fill task-card-fill" style="width:0%"></div></div>
    </div>`;
  },

  handleEvent(type, data) {
    const batchId = data.batch_id;
    if (!batchId) return;

    if (type === 'batch_queued') {
      this.refresh();
      return;
    }

    if (type === 'batch_completed') {
      const card = document.querySelector(`.task-card[data-batch-id="${batchId}"]`);
      if (card) {
        const badge = card.querySelector('.batch-status');
        if (badge) { badge.className = 'batch-status completed'; badge.textContent = '完成'; }
        const textEl = card.querySelector('.task-card-progress');
        if (textEl) textEl.textContent = '已完成';
        const fill = card.querySelector('.task-card-fill');
        if (fill) fill.style.width = '100%';
        // Briefly show the completed card, then drop it from the queue
        setTimeout(() => this.refresh(), 1500);
      } else {
        this.refresh();
      }
      delete this.progress[batchId];
      return;
    }

    // Progress events (file_started / page_started / page_completed / file_completed)
    const card = document.querySelector(`.task-card[data-batch-id="${batchId}"]`);
    if (!card) {
      // Card not rendered yet (e.g. page loaded mid-batch) — rebuild list
      this.refresh();
      return;
    }

    const p = this.progress[batchId] = this.progress[batchId] || {
      totalFiles: parseInt(card.dataset.fileCount || '1', 10) || 1,
      doneFiles: 0, curDone: 0, curTotal: 0, fileName: '',
    };

    if (type === 'file_started') {
      p.fileName = data.original_name || '';
      p.curDone = 0;
      p.curTotal = 0;
    } else if (type === 'page_started') {
      p.curTotal = data.total_pages || p.curTotal;
    } else if (type === 'page_completed') {
      p.curDone = data.completed_pages ?? p.curDone;
      p.curTotal = data.total_pages || p.curTotal;
    } else if (type === 'file_completed') {
      p.doneFiles++;
      p.curDone = 0;
      p.curTotal = 0;
    }

    // Flip badge from queued to processing on first activity
    const badge = card.querySelector('.batch-status');
    if (badge && badge.textContent === '排队') {
      badge.className = 'batch-status processing';
      badge.textContent = '处理中';
    }
    this.applyToCard(batchId);
  },

  applyToCard(batchId) {
    const card = document.querySelector(`.task-card[data-batch-id="${batchId}"]`);
    const p = this.progress[batchId];
    if (!card || !p) return;

    const filePct = p.curTotal > 0 ? p.curDone / p.curTotal : 0;
    const overall = Math.min((p.doneFiles + filePct) / p.totalFiles * 100, 100);
    const curFileNum = Math.min(p.doneFiles + 1, p.totalFiles);

    let text;
    if (p.curTotal > 0) {
      text = `解析中 ${p.curDone}/${p.curTotal} 页 · 文件 ${curFileNum}/${p.totalFiles}`;
    } else if (p.fileName) {
      text = `解析中: ${p.fileName} · 文件 ${curFileNum}/${p.totalFiles}`;
    } else {
      text = '准备中...';
    }

    const textEl = card.querySelector('.task-card-progress');
    const fillEl = card.querySelector('.task-card-fill');
    if (textEl) textEl.textContent = text;
    if (fillEl) fillEl.style.width = overall + '%';
  },
};
