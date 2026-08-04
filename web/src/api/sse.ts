/** SSE (Server-Sent Events) helper — global + per-batch streams. */

export type SSEEventType =
  | 'batch_queued' | 'batch_started' | 'file_started' | 'page_started'
  | 'page_completed' | 'file_completed' | 'batch_completed'
  | 'cost_estimated' | 'usage_recorded';

const ALL_TYPES: SSEEventType[] = [
  'batch_queued', 'batch_started', 'file_started', 'page_started',
  'page_completed', 'file_completed', 'batch_completed',
  'cost_estimated', 'usage_recorded',
];

/** Subscribe to the global SSE stream. Returns an unsubscribe function. */
export function subscribeGlobal(
  handler: (type: SSEEventType, data: any) => void,
  onError?: () => void,
  onOpen?: () => void,
): () => void {
  const es = new EventSource('/api/events');
  for (const type of ALL_TYPES) {
    es.addEventListener(type, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        handler(type, data);
      } catch { /* ignore malformed */ }
    });
  }
  es.onopen = () => onOpen?.();
  es.onerror = () => onError?.();
  return () => es.close();
}

/** Subscribe to a single-batch SSE stream. Returns an unsubscribe function. */
export function subscribeBatch(
  batchId: string,
  handler: (type: string, data: any) => void,
): () => void {
  const es = new EventSource(`/api/events/${batchId}`);
  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      handler('message', data);
    } catch { /* ignore */ }
  };
  for (const type of ALL_TYPES) {
    es.addEventListener(type, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        handler(type, data);
      } catch { /* ignore */ }
    });
  }
  return () => es.close();
}
