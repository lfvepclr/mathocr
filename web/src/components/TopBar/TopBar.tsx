/** TopBar — view mode toggle, export dropdown, settings. */
import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';

function ExportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function TopBar() {
  const route = useAppStore((s) => s.route);
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const showUploadView = useAppStore((s) => s.showUploadView);
  const currentBatch = useAppStore((s) => s.currentBatch);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // Close the export dropdown on outside click
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [exportOpen]);

  const doExport = (format: 'md' | 'docx' | 'html') => {
    if (!currentBatch) return;
    window.open(`/api/export/${currentBatch}?format=${format}`, '_blank');
    setExportOpen(false);
  };

  return (
    <div id="top-bar" className="top-bar">
      <div className="top-bar-left">
        <button id="home-btn" className="btn-icon" onClick={() => showUploadView()} title="返回首页">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
        </button>
      </div>
      {route === 'batch' && (
        <div className="top-bar-center">
          <div className="view-mode-toggle" title="视图模式">
            {(['split', 'original', 'markdown'] as const).map((mode) => (
              <button
                key={mode}
                className={`btn-toggle ${viewMode === mode ? 'active' : ''}`}
                onClick={() => setViewMode(mode)}
              >
                {mode === 'split' ? '对比' : mode === 'original' ? '原图' : '结果'}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="top-bar-controls">
        {currentBatch && (
          <div className="export-dropdown" ref={exportRef} style={{ position: 'relative' }}>
            <button id="export-menu-btn" className="btn-secondary" onClick={() => setExportOpen(!exportOpen)} title="导出解析结果">
              <ExportIcon /><span>导出</span>
            </button>
            {exportOpen && (
              <div className="export-menu" style={{ display: 'block', position: 'absolute', top: '100%', right: 0, marginTop: 4 }}>
                <div className="export-menu-label">整批导出</div>
                <button className="export-menu-item" onClick={() => doExport('md')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                  Markdown <span className="export-item-desc">.md 纯文本，自包含图片</span>
                </button>
                <button className="export-menu-item" onClick={() => doExport('docx')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="15" y2="17" /></svg>
                  Word <span className="export-item-desc">.docx 文档</span>
                </button>
                <button className="export-menu-item" onClick={() => doExport('html')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" /></svg>
                  版面 HTML <span className="export-item-desc">还原原始布局，可打印</span>
                </button>
              </div>
            )}
          </div>
        )}
        <button id="settings-btn" className="btn-icon" onClick={() => setShowSettings(!showSettings)} title="引擎与费用设置">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        </button>
      </div>
    </div>
  );
}
