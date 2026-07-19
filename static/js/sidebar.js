/* ============================================================
   Sidebar — Batch history list, progress, alias, navigation
   ============================================================ */

const Sidebar = {
  // Live per-batch progress cache for the global SSE channel:
  // {batchId: {totalFiles, doneFiles, curDone, curTotal, fileName, text, pct}}
  batchProgress: {},
  _throttleTimers: {},
  _refreshTimer: null,

  init() {
    this.loadBatches();
  },

  async loadBatches() {
    const container = document.getElementById('batch-list');
    try {
      const resp = await fetch('/api/batches');
      const batches = await resp.json();

      if (!batches || batches.length === 0) {
        container.innerHTML = '<div class="loading-hint">暂无历史批次</div>';
        return;
      }

      // Drop cached progress for batches no longer active
      const activeIds = new Set(
        batches.filter(b => b.status === 'processing' || b.status === 'queued')
          .map(b => b.batch_id)
      );
      Object.keys(this.batchProgress).forEach(id => {
        if (!activeIds.has(id)) delete this.batchProgress[id];
      });

      container.innerHTML = batches.map(b => this.renderBatchItem(b)).join('');

      container.querySelectorAll('.batch-item-header').forEach(header => {
        header.addEventListener('click', (e) => {
          if (e.target.closest('.batch-delete-btn') || e.target.closest('.batch-alias-btn') || e.target.closest('.batch-export-btn')) return;
          const item = header.closest('.batch-item');
          const batchId = item.dataset.batchId;

          if (item.classList.contains('expanded')) {
            App.openBatch(batchId);
          } else {
            this.expandBatch(item, batchId);
          }
        });
      });

      // Batch-level export: download the whole batch as one Markdown file
      container.querySelectorAll('.batch-export-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const batchId = btn.closest('.batch-item').dataset.batchId;
          window.open(`/api/export/${batchId}?format=md`, '_blank');
        });
      });

      container.querySelectorAll('.batch-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const item = btn.closest('.batch-item');
          const batchId = item.dataset.batchId;
          if (confirm('确定删除此批次?')) {
            await this.deleteBatch(batchId);
            this.loadBatches();
          }
        });
      });

      container.querySelectorAll('.batch-alias-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const item = btn.closest('.batch-item');
          const batchId = item.dataset.batchId;
          const currentAlias = item.dataset.alias || '';
          const alias = prompt('设置批次别名:', currentAlias);
          if (alias !== null) {
            this.setAlias(batchId, alias);
          }
        });
      });

    } catch (err) {
      container.innerHTML = '<div class="loading-hint">加载失败</div>';
      console.error('Failed to load batches:', err);
    }
  },

  renderBatchItem(batch) {
    const statusClass = batch.status || 'processing';
    const statusText = {
      'completed': '完成',
      'processing': '处理中',
      'error': '错误',
      'queued': '排队',
    }[batch.status] || batch.status;

    const displayName = batch.alias || batch.batch_id;
    const timeInfo = batch.processing_time
      ? `耗时 ${App.formatDuration(batch.processing_time)}`
      : App.formatTime(batch.created_at);

    // Batch-level live progress row (visible even when not expanded)
    const isActive = batch.status === 'processing' || batch.status === 'queued';
    // Seed the live cache from the server-side progress snapshot (survives
    // page refresh); keep any fresher event-driven cache entry.
    const snap = batch.progress;
    if (isActive && snap && !this.batchProgress[batch.batch_id]) {
      this.batchProgress[batch.batch_id] = {
        totalFiles: snap.total_files, doneFiles: snap.done_files,
        curDone: snap.cur_done, curTotal: snap.cur_total,
        fileName: snap.file_name, text: '', pct: snap.pct || 0,
      };
    }
    const cached = this.batchProgress[batch.batch_id];
    let progressText = cached?.text || '';
    if (!progressText) {
      if (batch.status === 'queued') {
        progressText = '排队中...';
      } else if (cached && cached.curTotal > 0) {
        const curFileNum = Math.min(cached.doneFiles + 1, cached.totalFiles);
        progressText = `解析中 ${cached.curDone}/${cached.curTotal} 页 · 文件 ${curFileNum}/${cached.totalFiles}`;
      } else if (cached?.fileName) {
        progressText = `解析中: ${cached.fileName}`;
      } else {
        progressText = '准备中...';
      }
    }
    // Elapsed-time ticker for long-running batches (created_at is UTC)
    const elapsedHtml = batch.status === 'processing'
      ? `<span class="live-elapsed batch-elapsed" data-started="${batch.created_at}"></span>`
      : '';
    const progressHtml = isActive ? `
        <div class="batch-progress">
          <div class="batch-progress-text">${progressText}</div>
          ${elapsedHtml}
          <div class="file-progress-bar"><div class="file-progress-fill batch-progress-fill" style="width:${cached?.pct || 0}%"></div></div>
        </div>` : '';

    return `
      <div class="batch-item" data-batch-id="${batch.batch_id}" data-alias="${batch.alias || ''}" data-file-count="${batch.file_count || 1}" data-created-at="${batch.created_at || ''}">
        <div class="batch-item-header">
          <div style="flex:1; min-width:0;">
            <div class="batch-item-name">${displayName}</div>
            <div class="batch-item-meta">
              ${App.formatTime(batch.created_at)} · ${batch.file_count} 个文件
            </div>
            ${batch.processing_time ? `<div class="batch-time-info">${timeInfo}</div>` : ''}
          </div>
          <span class="batch-status ${statusClass}">${statusText}</span>
          ${batch.status === 'completed' ? `
          <button class="batch-export-btn" title="导出整批 Markdown（含文件分隔）">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>` : ''}
          <button class="batch-alias-btn" title="设置别名" style="opacity:0.4; padding:2px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="batch-delete-btn" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
        ${progressHtml}
        <div class="batch-files"></div>
      </div>
    `;
  },

  async expandBatch(item, batchId) {
    document.querySelectorAll('.batch-item.expanded').forEach(el => {
      if (el !== item) el.classList.remove('expanded');
    });

    item.classList.add('expanded');
    const filesContainer = item.querySelector('.batch-files');
    filesContainer.innerHTML = '<div class="loading-hint">加载中...</div>';

    try {
      const resp = await fetch(`/api/batch/${batchId}`);
      const data = await resp.json();

      if (data.error || !data.files) {
        filesContainer.innerHTML = '<div class="loading-hint">无文件</div>';
        return;
      }

      filesContainer.innerHTML = data.files.map(f => {
        const icon = f.file_type === 'pdf' ? 'PDF' : 'IMG';
        const pages = f.page_count || 0;
        const totalPages = f.total_pages || 0;
        const statusIcon = {
          'completed': '\u2713',
          'processing': '\u23F3',
          'pending': '\u23F3',
          'error': '\u2717',
        }[f.status] || '\u25CB';

        let progressInfo = '';
        if (f.status === 'processing' && totalPages > 0) {
          const pct = Math.round(pages / totalPages * 100);
          progressInfo = `
            <div class="file-progress">${statusIcon} 解析中 ${pages}/${totalPages} 页</div>
            <div class="file-progress-bar"><div class="file-progress-fill" style="width:${pct}%"></div></div>
          `;
        } else if (f.status === 'completed') {
          const time = f.processing_time ? ` \u00B7 ${App.formatDuration(f.processing_time)}` : '';
          progressInfo = `<div class="file-progress">${statusIcon} ${pages} 页${time}</div>`;
        } else if (f.status === 'error') {
          progressInfo = `<div class="file-progress">${statusIcon} ${f.error_message || '错误'}</div>`;
        } else {
          progressInfo = `<div class="file-progress">${statusIcon} 等待中</div>`;
        }

        return `
          <div class="batch-file-item" data-file-id="${f.file_id}">
            <span style="font-weight:600; color:#6366f1;">${icon}</span>
            ${f.original_name}
            ${progressInfo}
          </div>
        `;
      }).join('');

      filesContainer.querySelectorAll('.batch-file-item').forEach(fileEl => {
        fileEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const fileId = fileEl.dataset.fileId;
          document.querySelectorAll('.batch-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          App.state.currentBatch = batchId;
          App.openFile(fileId, 0);
          App.showResultsView();
        });
      });

    } catch (err) {
      filesContainer.innerHTML = '<div class="loading-hint">加载失败</div>';
    }
  },

  // ---- Global SSE events (all batches; dispatched from App.init) ----
  handleGlobalEvent(type, data) {
    const batchId = data.batch_id;
    if (!batchId) return;

    if (type === 'batch_completed') {
      delete this.batchProgress[batchId];
      this.loadBatches();
      return;
    }

    const item = document.querySelector(`.batch-item[data-batch-id="${batchId}"]`);
    if (!item) {
      // Batch row not rendered yet (e.g. freshly queued) — refresh list
      this.throttledRefresh();
      return;
    }

    if (type === 'batch_queued') {
      this.ensureProgressRow(item);
      const p = this.batchProgress[batchId] = this.batchProgress[batchId] || {
        totalFiles: parseInt(item.dataset.fileCount || '1', 10) || 1,
        doneFiles: 0, curDone: 0, curTotal: 0, fileName: '', text: '排队中...', pct: 0,
      };
      if (!p.text) p.text = '排队中...';
      this.updateProgressUI(batchId);
      return;
    }

    // Progress events (file_started / page_started / page_completed / file_completed)
    const p = this.batchProgress[batchId] = this.batchProgress[batchId] || {
      totalFiles: parseInt(item.dataset.fileCount || '1', 10) || 1,
      doneFiles: 0, curDone: 0, curTotal: 0, fileName: '', text: '', pct: 0,
    };

    if (type === 'file_started') {
      p.fileName = data.original_name || '';
      p.curDone = 0;
      p.curTotal = 0;
      // Flip badge from queued to processing in place
      const badge = item.querySelector('.batch-status');
      if (badge && badge.classList.contains('queued')) {
        badge.className = 'batch-status processing';
        badge.textContent = '处理中';
      }
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

    const filePct = p.curTotal > 0 ? p.curDone / p.curTotal : 0;
    p.pct = Math.min((p.doneFiles + filePct) / p.totalFiles * 100, 100);
    const curFileNum = Math.min(p.doneFiles + 1, p.totalFiles);
    if (p.curTotal > 0) {
      p.text = `解析中 ${p.curDone}/${p.curTotal} 页 · 文件 ${curFileNum}/${p.totalFiles}`;
    } else if (p.fileName) {
      p.text = `解析中: ${p.fileName}`;
    } else {
      p.text = '准备中...';
    }

    this.ensureProgressRow(item);
    this.throttledUpdate(batchId);

    // Keep expanded file rows in sync as well (idempotent)
    this.handleProgressEvent(type, data);
  },

  ensureProgressRow(item) {
    let row = item.querySelector(':scope > .batch-progress');
    if (!row) {
      row = document.createElement('div');
      row.className = 'batch-progress';
      row.innerHTML = '<div class="batch-progress-text"></div>' +
        '<span class="live-elapsed batch-elapsed"></span>' +
        '<div class="file-progress-bar"><div class="file-progress-fill batch-progress-fill"></div></div>';
      item.insertBefore(row, item.querySelector('.batch-files'));
    }
    row.style.display = '';
    // Keep the elapsed ticker anchored to this batch's creation time
    const elapsed = row.querySelector('.live-elapsed');
    if (elapsed && !elapsed.dataset.started) {
      const started = item.dataset.createdAt;
      if (started) elapsed.dataset.started = started;
    }
  },

  updateProgressUI(batchId) {
    const item = document.querySelector(`.batch-item[data-batch-id="${batchId}"]`);
    const p = this.batchProgress[batchId];
    if (!item || !p) return;
    const row = item.querySelector(':scope > .batch-progress');
    if (!row) return;
    const textEl = row.querySelector('.batch-progress-text');
    const fillEl = row.querySelector('.batch-progress-fill');
    if (textEl) textEl.textContent = p.text;
    if (fillEl) fillEl.style.width = p.pct + '%';
  },

  throttledUpdate(batchId) {
    if (this._throttleTimers[batchId]) return;
    this._throttleTimers[batchId] = setTimeout(() => {
      delete this._throttleTimers[batchId];
      this.updateProgressUI(batchId);
    }, 300);
  },

  throttledRefresh() {
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.loadBatches();
    }, 500);
  },

  // ---- Real-time progress updates (called from Uploader SSE handlers) ----
  handleProgressEvent(type, data) {
    const fileEl = document.querySelector(
      `.batch-file-item[data-file-id="${data.file_id}"]`
    );
    if (!fileEl) return;
    const info = fileEl.querySelector('.file-progress');
    const bar = fileEl.querySelector('.file-progress-fill');
    if (!info) return;

    if (type === 'file_started') {
      info.innerHTML = '\u23F3 开始解析...';
    } else if (type === 'page_started') {
      const cur = data.page_id ?? 0;
      const total = data.total_pages || 0;
      info.innerHTML = `\u23F3 解析中 ${cur}/${total} 页`;
      if (bar && total > 0) bar.style.width = Math.round(cur / total * 100) + '%';
    } else if (type === 'page_completed') {
      const done = data.completed_pages ?? 0;
      const total = data.total_pages || 0;
      info.innerHTML = `\u23F3 解析中 ${done}/${total} 页`;
      if (bar && total > 0) bar.style.width = Math.round(done / total * 100) + '%';
    } else if (type === 'file_completed') {
      const time = data.processing_time
        ? ` \u00B7 ${App.formatDuration(data.processing_time)}`
        : '';
      info.innerHTML = `\u2713 ${data.page_count || ''} 页${time}`;
      if (bar) bar.style.width = '100%';
    }
  },

  async setAlias(batchId, alias) {
    try {
      await fetch(`/api/batch/${batchId}/alias`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: alias }),
      });
      this.loadBatches();
    } catch (err) {
      console.error('Failed to set alias:', err);
    }
  },

  async deleteBatch(batchId) {
    try {
      await fetch(`/api/batch/${batchId}`, { method: 'DELETE' });
      if (App.state.currentBatch === batchId) {
        App.showUploadView();
      }
    } catch (err) {
      console.error('Failed to delete batch:', err);
    }
  },
};
