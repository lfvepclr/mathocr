/* ============================================================
   Uploader — Drag & drop, file upload, SSE real-time progress
   ============================================================ */

const Uploader = {
  eventSource: null,
  pollTimer: null,
  estimateTimer: null,

  init() {
    const zone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');

    zone.addEventListener('click', () => fileInput.click());

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

  async uploadFiles(fileList) {
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
        setTimeout(() => App.openBatch(batchId), 500);
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
          setTimeout(() => App.openBatch(batchId), 500);
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
