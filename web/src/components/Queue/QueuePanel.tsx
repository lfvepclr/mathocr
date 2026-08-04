/** QueuePanel — home page task queue (active batches with progress). */
import { useQueueStore } from '@/stores/queueStore';
import { useAppStore } from '@/stores/appStore';

function formatElapsed(ts: string): string {
  if (!ts) return '';
  const ms = Date.parse(ts.replace(' ', 'T') + 'Z');
  if (isNaN(ms)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function QueuePanel() {
  const items = useQueueStore((s) => s.items);
  const loading = useQueueStore((s) => s.loading);
  const openBatch = useAppStore((s) => s.openBatch);

  if (items.length === 0 && !loading) return null;

  return (
    <div className="queue-panel">
      <div className="queue-header">
        <span className="queue-title">任务队列</span>
        <span className="queue-count">{items.length} 个进行中</span>
      </div>
      <div className="queue-list">
        {items.map((item) => (
          <div
            key={item.batch_id}
            className="queue-item"
            onClick={() => openBatch(item.batch_id)}
          >
            <div className="queue-item-header">
              <span className="queue-name">{item.batch_id}</span>
              <span className={`queue-status status-${item.status}`}>{item.status}</span>
            </div>
            <div className="queue-meta">
              <span>{item.engine}</span>
              <span>{item.file_count} 文件</span>
              {item.created_at && <span className="live-elapsed">已耗时 {formatElapsed(item.created_at)}</span>}
            </div>
            {item.progress && (
              <div className="queue-progress">
                <div className="progress-bar" style={{ width: `${item.progress.percent}%` }} />
                <span className="progress-text">
                  {item.progress.completed_pages}/{item.progress.total_pages} 页
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
