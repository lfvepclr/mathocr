/** Rich-text clipboard helpers — fetch Word-friendly HTML from the
 *  /api/page_richtext endpoint and write both text/html and text/plain
 *  to the clipboard so Word keeps formatting. Falls back to plain text. */
import { getJSON } from '@/api/client';

/** Fetch richtext for the page (or a single block / lasso selection) and
 *  write it to the clipboard. Returns true on success. */
export async function copyRichText(
  batchId: string, fileId: string, pageId: number,
  blockIdx?: number | null, blockIdxs?: number[] | null,
): Promise<boolean> {
  if (!batchId || fileId == null || pageId == null) return false;
  let url = `/api/page_richtext/${batchId}/${fileId}/${pageId}`;
  if (blockIdxs && blockIdxs.length > 0) {
    url += `?blocks=${blockIdxs.join(',')}`;
  } else if (blockIdx != null) {
    url += `?block=${blockIdx}`;
  }
  const data = await getJSON<{ html?: string; text?: string; error?: string }>(url);
  if (data.error || !data.html) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([data.html], { type: 'text/html' }),
      'text/plain': new Blob([data.text || ''], { type: 'text/plain' }),
    })]);
    return true;
  } catch {
    // Fallback: execCommand copy of the plain text
    const ta = document.createElement('textarea');
    ta.value = data.text || data.html;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return true;
  }
}

/** Copy plain text as a last resort. */
export async function copyPlainText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
}
