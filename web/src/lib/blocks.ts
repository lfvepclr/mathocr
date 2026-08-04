/** Block label maps and pure-function utilities for OCR block processing. */

export const LABEL_MAP: Record<string, string> = {
  doc_title: '文档标题', paragraph_title: '标题', text: '正文',
  table: '表格', formula: '公式', image: '图片',
  figure_title: '图题', table_title: '表题', header: '页眉',
  footer: '页脚', footnote: '脚注', chart: '图表',
  seal: '印章', abstract: '摘要', reference: '参考文献',
  contents: '目录', algorithm: '算法',
};

export const LABEL_CLASS_MAP: Record<string, string> = {
  text: 't-text', aside_text: 't-text', vertical_text: 't-text',
  doc_title: 't-title', paragraph_title: 't-title',
  table: 't-table',
  formula: 't-formula', inline_formula: 't-formula', formula_number: 't-formula',
  image: 't-image', chart: 't-image', header_image: 't-image', footer_image: 't-image',
  seal: 't-seal',
  figure_title: 't-caption', table_title: 't-caption',
  header: 't-header', footer: 't-header', number: 't-header',
};

const IMG_LABELS = ['image', 'chart', 'seal', 'header_image', 'footer_image'];

/** A block is a pure image when its label says so, or its whole content
 *  is a single <img> tag. Tables embed <img> cells — checking a bare
 *  includes('<img') would misroute them and dump raw pipe markdown. */
export function isPureImageBlock(label: string, content: string): boolean {
  if (IMG_LABELS.includes(label)) return true;
  return /^<img[^>]*\/?>$/.test(content.trim());
}

/** Find the smallest block whose bbox contains (px, py) in coord space. */
export function blockAtPoint(
  blocks: any[], px: number, py: number,
): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  blocks.forEach((block, idx) => {
    const bb = block.block_bbox;
    if (!bb || bb.length !== 4) return;
    if (px >= bb[0] && px <= bb[2] && py >= bb[1] && py <= bb[3]) {
      const area = (bb[2] - bb[0]) * (bb[3] - bb[1]);
      if (area < bestArea) { bestArea = area; best = idx; }
    }
  });
  return best;
}

/** Build the polygon points attribute from block_polygon_points or block_bbox. */
export function blockPoints(block: any): string | null {
  const pts = block.block_polygon_points || [];
  if (pts.length >= 3) return pts.map((p: number[]) => p.join(',')).join(' ');
  if (Array.isArray(block.block_bbox) && block.block_bbox.length === 4) {
    const [x1, y1, x2, y2] = block.block_bbox;
    return `${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2}`;
  }
  return null;
}

/** Confidence class for a block (c0–c3) or label class (t-*) when no score. */
export function blockClass(
  hasScore: boolean, score: number | undefined,
  label: string,
): string {
  if (!hasScore) return LABEL_CLASS_MAP[label] || 't-other';
  if (score === undefined || score === null) return 'c1';
  if (score >= 0.9) return 'c0';
  if (score >= 0.75) return 'c1';
  if (score >= 0.6) return 'c2';
  return 'c3';
}
