/**
 * Sidebar — batch list with time grouping, engine badge, alias, expand.
 *
 * Restores the legacy vanilla-JS sidebar behaviour: batch rows carry
 * export/alias/delete buttons, the engine shows as a coloured Chinese
 * badge, status is localised, multi-file batches expand in place, and the
 * collapsed state exposes a three-segment FAB (new + divider + expand).
 */
import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useQueueStore } from '@/stores/queueStore';
import { batchesApi, type BatchSummary, type FileInfo } from '@/api/batches';
import { settingsApi, type EngineInfo } from '@/api/settings';

const STATUS_ZH: Record<string, string> = {
  completed: '完成',
  processing: '处理中',
  error: '错误',
  queued: '排队',
};

const FILE_STATUS_ICON: Record<string, string> = {
  completed: '\u2713',
  processing: '\u23F3',
  pending: '\u23F3',
  error: '\u2717',
};

function groupLabel(date: string): string {
  const d = new Date(date.replace(' ', 'T') + 'Z');
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days < 1) return '今天';
  if (days < 2) return '昨天';
  if (days < 7) return '近 7 天';
  if (days < 30) return '近 30 天';
  return '更早';
}

function formatTime(ts: string): string {
  if (!ts) return '';
  const parts = ts.split(' ');
  if (parts.length < 2) return ts;
  return `${parts[0].slice(5)} ${parts[1].slice(0, 5)}`;
}

function fileStatusText(f: FileInfo): string {
  const icon = FILE_STATUS_ICON[f.status] || '\u25CB';
  if (f.status === 'completed') {
    return `${icon} ${f.page_count || 0} 页`;
  }
  if (f.status === 'processing' && (f.total_pages || 0) > 0) {
    return `${icon} 解析中 ${f.page_count || 0}/${f.total_pages} 页`;
  }
  if (f.status === 'error') {
    return `${icon} ${f.error_message || '错误'}`;
  }
  return `${icon} 等待中`;
}

export function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const currentBatch = useAppStore((s) => s.currentBatch);
  const openBatch = useAppStore((s) => s.openBatch);
  const showUploadView = useAppStore((s) => s.showUploadView);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [engineNames, setEngineNames] = useState<Map<string, string>>(new Map());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<FileInfo[]>([]);
  const refresh = useQueueStore((s) => s.refresh);

  const loadBatches = useCallback(async () => {
    try {
      const data = await batchesApi.list();
      setBatches(data as BatchSummary[]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadBatches();
    // Load engine id -> Chinese name map for the coloured engine badge
    settingsApi.engines().then(({ engines }) => {
      setEngineNames(new Map(engines.map((e: EngineInfo) => [e.id, e.name])));
    }).catch(() => {});
    const interval = setInterval(loadBatches, 5000);
    return () => clearInterval(interval);
  }, [loadBatches]);

  const engineMeta = (b: BatchSummary) => {
    const id = b.engine || 'local';
    if (id === 'local') return null;
    const name = engineNames.get(id) || id;
    const cost = Number(b.cost || 0);
    const costText = cost > 0 ? ` · ¥${cost.toFixed(4)}` : '';
    return <> · <span className="engine-badge online tiny">{name}</span>{costText}</>;
  };

  const expandBatch = useCallback(async (batchId: string) => {
    try {
      const data = await batchesApi.get(batchId);
      setExpandedFiles(data.files || []);
    } catch {
      setExpandedFiles([]);
    }
  }, []);

  const handleClick = (e: React.MouseEvent, b: BatchSummary) => {
    const target = e.target as HTMLElement;
    if (target.closest('.batch-delete-btn') || target.closest('.batch-alias-btn') || target.closest('.batch-export-btn')) return;
    if (expandedId === b.batch_id) {
      openBatch(b.batch_id);
    } else {
      setExpandedId(b.batch_id);
      setExpandedFiles([]);
      expandBatch(b.batch_id);
      // Finished batch opens straight to its first result on first click
      if (b.status === 'completed' && (b.file_count || 0) > 0) {
        openBatch(b.batch_id);
      }
    }
  };

  const handleExport = (e: React.MouseEvent, batchId: string) => {
    e.stopPropagation();
    window.open(`/api/export/${batchId}?format=md`, '_blank');
  };

  const handleAlias = async (e: React.MouseEvent, b: BatchSummary) => {
    e.stopPropagation();
    const alias = prompt('设置批次别名:', b.alias || '');
    if (alias !== null) {
      await batchesApi.setAlias(b.batch_id, alias);
      loadBatches();
    }
  };

  const handleDelete = async (e: React.MouseEvent, batchId: string) => {
    e.stopPropagation();
    if (confirm('确定删除此批次?')) {
      await batchesApi.delete(batchId);
      loadBatches();
    }
  };

  const handleFileClick = (e: React.MouseEvent, batchId: string, fileId: string) => {
    e.stopPropagation();
    // Drive through the hash router so currentBatch is set before openFile
    window.location.hash = `#batch/${batchId}/file/${fileId}/page/0`;
  };

  // Group batches by time
  const groups: Record<string, BatchSummary[]> = {};
  for (const b of batches) {
    const label = groupLabel(b.created_at);
    if (!groups[label]) groups[label] = [];
    groups[label].push(b);
  }

  if (collapsed) {
    // Three-segment FAB: [new] | [expand]  — expand sits on the right edge
    return (
      <button id="sidebar-fab" className="sidebar-fab" onClick={() => toggleSidebar()} title="展开侧边栏">
        <span className="fab-btn fab-new" title="新建解析">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </span>
        <span className="fab-divider"></span>
        <span className="fab-btn fab-expand" title="展开侧边栏">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </span>
      </button>
    );
  }

  return (
    <aside id="sidebar" className="sidebar">
      <div className="sidebar-header">
        <button id="sidebar-toggle" className="sidebar-toggle" onClick={toggleSidebar} title="收起侧边栏">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <div className="logo" onClick={() => showUploadView()} style={{ cursor: 'pointer' }} title="返回首页">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="9" y1="13" x2="15" y2="13"/>
            <line x1="9" y1="17" x2="15" y2="17"/>
          </svg>
          <span>MathOCR</span>
        </div>
      </div>
      <div className="sidebar-section">
        <div className="batch-list" id="batch-list">
          {Object.entries(groups).map(([label, items]) => (
            <div key={label} className="batch-group">
              <div className="batch-group-title">{label}</div>
              {items.map((b) => (
                <div
                  key={b.batch_id}
                  className={`batch-item ${expandedId === b.batch_id ? 'expanded' : ''} ${currentBatch === b.batch_id ? 'active' : ''}`}
                >
                  <div className="batch-item-header" onClick={(e) => handleClick(e, b)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="batch-item-name">{b.alias || b.batch_id}</div>
                      <div className="batch-item-meta">
                        {formatTime(b.created_at)} · {b.file_count} 个文件{engineMeta(b)}
                      </div>
                    </div>
                    <span className={`batch-status ${b.status}`}>{STATUS_ZH[b.status] || b.status}</span>
                    {b.status === 'completed' && (
                      <button className="batch-export-btn" title="导出整批 Markdown" onClick={(e) => handleExport(e, b.batch_id)}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      </button>
                    )}
                    <button className="batch-alias-btn" title="设置别名" style={{ opacity: 0.4, padding: 2 }} onClick={(e) => handleAlias(e, b)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button className="batch-delete-btn" title="删除" onClick={(e) => handleDelete(e, b.batch_id)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                  {(b.status === 'processing' || b.status === 'queued') && b.progress && (
                    <div className="batch-progress">
                      <div className="batch-progress-text">{b.progress.completed_pages}/{b.progress.total_pages} 页</div>
                      <div className="file-progress-bar"><div className="file-progress-fill batch-progress-fill" style={{ width: `${b.progress.percent}%` }}></div></div>
                    </div>
                  )}
                  {expandedId === b.batch_id && (
                    <div className="batch-files">
                      {expandedFiles.length === 0 ? (
                        <div className="loading-hint">加载中...</div>
                      ) : expandedFiles.map((f) => (
                        <div key={f.file_id} className="batch-file-item" onClick={(e) => handleFileClick(e, b.batch_id, f.file_id)}>
                          <span style={{ fontWeight: 600, color: '#6366f1' }}>{f.file_type === 'pdf' ? 'PDF' : 'IMG'}</span>
                          {' '}{f.original_name}
                          <div className="file-progress">{fileStatusText(f)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {batches.length === 0 && (
            <div className="loading-hint">暂无历史批次</div>
          )}
        </div>
      </div>
    </aside>
  );
}
