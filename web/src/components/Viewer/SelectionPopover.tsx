/**
 * SelectionPopover — Popover anchored under the right-panel lasso button.
 * Consolidates all selection actions (count, copy to Word, clear, close) so
 * the legacy bottom SelectionBar is no longer needed.
 */
import { useViewerStore } from '@/stores/viewerStore';
import { useAppStore } from '@/stores/appStore';
import { copyRichText, copyPlainText } from '@/lib/richtext';

function LassoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="9" r="6" strokeDasharray="3 2" />
      <line x1="14.2" y1="13.2" x2="20" y2="19" />
    </svg>
  );
}

export function SelectionPopover() {
  const selectMode = useViewerStore((s) => s.selectMode);
  const selectedBlocks = useViewerStore((s) => s.selectedBlocks);
  const currentBlocks = useViewerStore((s) => s.currentBlocks);
  const toggleSelectMode = useViewerStore((s) => s.toggleSelectMode);
  const clearSelection = useViewerStore((s) => s.clearSelection);
  const currentBatch = useAppStore((s) => s.currentBatch);
  const currentFile = useAppStore((s) => s.currentFile);
  const currentPage = useAppStore((s) => s.currentPage);
  const n = selectedBlocks.size;

  const handleCopy = async () => {
    const idxs = [...selectedBlocks];
    if (!idxs.length) return;
    let done = false;
    try {
      done = await copyRichText(currentBatch!, currentFile!, currentPage, null, idxs);
    } catch { /* fall back to plain text */ }
    if (!done) {
      const text = idxs.sort((a, b) => a - b)
        .map(i => currentBlocks[i]?.block_content || '')
        .filter(Boolean).join('\n\n');
      await copyPlainText(text);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className={`btn-icon ${selectMode ? 'active' : ''}`}
        onClick={toggleSelectMode}
        title="框选模式：拖框选择多个块，一键复制到 Word"
      >
        <LassoIcon />
      </button>
      {selectMode && (
        <div
          className="selection-popover"
          style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6 }}
        >
          <span className="selection-popover-count">已选 {n} 块</span>
          <button className="selection-popover-btn" onClick={handleCopy} disabled={n === 0}>
            复制到 Word
          </button>
          <button className="selection-popover-btn" onClick={clearSelection} disabled={n === 0}>
            清空选择
          </button>
          <button className="selection-popover-btn" onClick={toggleSelectMode}>
            关闭框选
          </button>
        </div>
      )}
    </div>
  );
}
