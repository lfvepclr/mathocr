/** LaTeX delimiter normalisation and markdown parsing — shared by flow
 *  and layout views. Must run BEFORE marked.parse so KaTeX sees the
 *  rewritten delimiters (排查 16/18). */
import { marked } from 'marked';
import renderMathInElement from 'katex/contrib/auto-render';

marked.setOptions({ breaks: true, gfm: true });

/** Rewrite \[...\] → $$...$$ and \(...\) → $...$ (marked eats the
 *  backslash in \( as a CommonMark escape before KaTeX sees it). */
export function normalizeLatexDelims(md: string): string {
  return md
    .replace(/\\\[(.+?)\\\]/gs, (_, t) => `$$${t}$$`)
    .replace(/\\\((.+?)\\\)/gs, (_, t) => `$${t}$`);
}

/** Escape a leading "N." / "N)" on single-line blocks so marked does
 *  not parse it as <ol> (the global CSS reset strips ol padding, making
 *  the number vanish — 排查 18). */
export function protectLeadingEnum(md: string): string {
  if (md.includes('\n')) return md;
  return md.replace(/^(\s*\d{1,9})([.)])(\s)/, '$1\\$2$3');
}

/** Block markdown → HTML (normalizeLatexDelims + protectLeadingEnum + marked). */
export function parseBlockMd(content: string): string {
  return marked.parse(protectLeadingEnum(normalizeLatexDelims(content)), { async: false }) as string;
}

/** Render all LaTeX in a DOM element with KaTeX auto-render. */
export function renderMath(container: HTMLElement): void {
  try {
    renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      throwOnError: false,
    });
  } catch (e) {
    console.warn('KaTeX render error:', e);
  }
}

/** Fix relative image paths to the page-image API endpoint. */
export function fixImagePaths(
  container: HTMLElement,
  batchId: string, fileId: string, pageId: number,
): void {
  container.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src && !src.startsWith('/') && !src.startsWith('http') && !src.startsWith('data:')) {
      img.src = `/api/page_image/${batchId}/${fileId}/${pageId}/${src}`;
    }
  });
}
