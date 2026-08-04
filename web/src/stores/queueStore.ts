/** Queue/SSE store: tracks active batches via the global event stream. */
import { create } from 'zustand';
import { batchesApi, type BatchSummary } from '@/api/batches';
import { subscribeGlobal, type SSEEventType } from '@/api/sse';

interface QueueItem {
  batch_id: string;
  status: string;
  engine: string;
  file_count: number;
  created_at: string;
  progress?: any;
}

interface QueueState {
  items: QueueItem[];
  loading: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  refresh: () => Promise<void>;
  handleEvent: (type: SSEEventType, data: any) => void;
  init: () => () => void;
}

export const useQueueStore = create<QueueState>((set, get) => ({
  items: [],
  loading: false,
  pollTimer: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const batches = await batchesApi.list();
      const active = (batches as BatchSummary[]).filter(
        (b) => b.status === 'processing' || b.status === 'queued',
      );
      set({ items: active as QueueItem[], loading: false });
    } catch {
      set({ loading: false });
    }
  },

  handleEvent: (_type, data) => {
    // Any SSE event means something changed — refresh the queue list
    get().refresh();
  },

  init: () => {
    get().refresh();
    const unsub = subscribeGlobal(
      (type, data) => get().handleEvent(type, data),
      // SSE error → poll fallback
      () => {
        if (!get().pollTimer) {
          const t = setInterval(() => get().refresh(), 5000);
          set({ pollTimer: t });
        }
      },
      // SSE reconnected → stop polling
      () => {
        const t = get().pollTimer;
        if (t) { clearInterval(t); set({ pollTimer: null }); }
      },
    );
    return () => { unsub(); const t = get().pollTimer; if (t) clearInterval(t); };
  },
}));
