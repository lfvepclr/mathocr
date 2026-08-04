/** Base fetch helpers shared by all API modules. */

const BASE = '';  // same origin; Vite dev server proxies /api → :7861

export async function getJSON<T = any>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  return r.json();
}

export async function postJSON<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

export async function uploadFiles(
  files: File[] | { name: string; content: string }[],
  engine?: string,
): Promise<{ batch_id: string; status: string; file_count: number; engine: string }> {
  const form = new FormData();
  for (const f of files as File[]) form.append('file', f);
  const qs = engine ? `?engine=${encodeURIComponent(engine)}` : '';
  const r = await fetch(`${BASE}/api/upload${qs}`, { method: 'POST', body: form });
  return r.json();
}
