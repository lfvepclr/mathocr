/* ============================================================
   Sidebar — Batch history list, progress, alias, navigation
   ============================================================ */

const Sidebar = {
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

      container.innerHTML = batches.map(b => this.renderBatchItem(b)).join('');

      container.querySelectorAll('.batch-item-header').forEach(header => {
        header.addEventListener('click', (e) => {
          if (e.target.closest('.batch-delete-btn') || e.target.closest('.batch-alias-btn')) return;
          const item = header.closest('.batch-item');
          const batchId = item.dataset.batchId;

          if (item.classList.contains('expanded')) {
            App.openBatch(batchId);
          } else {
            this.expandBatch(item, batchId);
          }
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

    return `
      <div class="batch-item" data-batch-id="${batch.batch_id}" data-alias="${batch.alias || ''}">
        <div class="batch-item-header">
          <div style="flex:1; min-width:0;">
            <div class="batch-item-name">${displayName}</div>
            <div class="batch-item-meta">
              ${App.formatTime(batch.created_at)} · ${batch.file_count} 个文件
            </div>
            ${batch.processing_time ? `<div class="batch-time-info">${timeInfo}</div>` : ''}
          </div>
          <span class="batch-status ${statusClass}">${statusText}</span>
          <button class="batch-alias-btn" title="设置别名" style="opacity:0.4; padding:2px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="batch-delete-btn" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
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
