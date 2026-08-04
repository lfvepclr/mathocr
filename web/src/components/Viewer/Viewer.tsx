/**
 * Viewer — the comparison view: annotated image + rendered markdown.
 *
 * Integrates: SVG overlay, bidirectional hover, size-based zoom, anchor
 * scroll sync, dual-panel lasso + floating selection bar, flow/layout
 * rendering with KaTeX, block/lasso/page copy to Word, export, divider.
 */
import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewerStore } from '@/stores/viewerStore';
import { batchesApi } from '@/api/batches';
import { blockPoints, blockClass, blockAtPoint, LABEL_MAP, isPureImageBlock } from '@/lib/blocks';
import { parseBlockMd, renderMath, fixImagePaths } from '@/lib/latex';
import { copyRichText, copyPlainText } from '@/lib/richtext';
import { SelectionPopover } from './SelectionPopover';

const ANCHOR_RATIO = 0.25;

export function Viewer() {
  const currentBatch = useAppStore((s) => s.currentBatch);
  const currentFile = useAppStore((s) => s.currentFile);
  const currentPage = useAppStore((s) => s.currentPage);
  const batchData = useAppStore((s) => s.batchData);
  const viewMode = useAppStore((s) => s.viewMode);
  const loadPage = useAppStore((s) => s.loadPage);

  const pageData = useViewerStore((s) => s.pageData);
  const currentBlocks = useViewerStore((s) => s.currentBlocks);
  const blockScores = useViewerStore((s) => s.blockScores);
  const setPageData = useViewerStore((s) => s.setPageData);
  const overlayVisible = useViewerStore((s) => s.overlayVisible);
  const toggleOverlay = useViewerStore((s) => s.toggleOverlay);
  const zoom = useViewerStore((s) => s.zoom);
  const setZoom = useViewerStore((s) => s.setZoom);
  const fitZoom = useViewerStore((s) => s.fitZoom);
  const setFitZoom = useViewerStore((s) => s.setFitZoom);
  const layoutZoom = useViewerStore((s) => s.layoutZoom);
  const setLayoutZoom = useViewerStore((s) => s.setLayoutZoom);
  const userZoomed = useViewerStore((s) => s.userZoomed);
  const setUserZoomed = useViewerStore((s) => s.setUserZoomed);
  const resultViewMode = useViewerStore((s) => s.resultViewMode);
  const setResultViewMode = useViewerStore((s) => s.setResultViewMode);
  const syncScroll = useViewerStore((s) => s.syncScroll);
  const toggleSyncScroll = useViewerStore((s) => s.toggleSyncScroll);
  const selectMode = useViewerStore((s) => s.selectMode);
  const toggleSelectMode = useViewerStore((s) => s.toggleSelectMode);
  const selectedBlocks = useViewerStore((s) => s.selectedBlocks);
  const selPanel = useViewerStore((s) => s.selPanel);
  const setSelPanel = useViewerStore((s) => s.setSelPanel);
  const hoverIdx = useViewerStore((s) => s.hoverIdx);
  const setHoverIdx = useViewerStore((s) => s.setHoverIdx);

  // Refs for imperative DOM operations
  const imgRef = useRef<HTMLImageElement>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const mdContentRef = useRef<HTMLDivElement>(null);
  const layoutContentRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const bandRightRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const splitViewRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const scrollSyncLock = useRef(false);
  const bandState = useRef<{ panel: 'img' | 'result'; x1: number; y1: number; x2: number; y2: number; moved: boolean } | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Load page data when batch/file/page changes ----
  useEffect(() => {
    if (currentBatch && currentFile != null) {
      loadPage(currentBatch, currentFile, currentPage).then(() => {
        // setPageData is called via the store; but we need to trigger it
        // from the pageData in appStore. Let's fetch directly.
      });
    }
  }, [currentBatch, currentFile, currentPage, loadPage]);

  // Sync pageData from appStore to viewerStore
  const appPageData = useAppStore((s) => s.pageData);
  useEffect(() => {
    if (appPageData) setPageData(appPageData);
  }, [appPageData, setPageData]);

  // ---- Apply zoom (size-based for image, transform for layout) ----
  const applyZoom = useCallback((origin?: string) => {
    const img = imgRef.current;
    if (img && img.naturalWidth) {
      img.style.width = (img.naturalWidth * zoom) + 'px';
    }
    const canvas = layoutContentRef.current?.querySelector('.layout-canvas') as HTMLElement | null;
    if (canvas) {
      canvas.style.transform = `scale(${layoutZoom})`;
      if (layoutZoom > 1) {
        canvas.style.transformOrigin = origin || 'top left';
        canvas.style.margin = '0';
      } else {
        canvas.style.transformOrigin = origin || 'top center';
        canvas.style.margin = '0 auto';
      }
    }
  }, [zoom, layoutZoom]);

  // ---- Fit-width zoom ----
  const refitImage = useCallback(() => {
    const img = imgRef.current;
    const container = imgContainerRef.current;
    if (!img || !img.naturalWidth || !container?.clientWidth) return;
    const fit = (container.clientWidth - 32) / img.naturalWidth;
    const newFit = Math.min(5.0, Math.max(0.1, fit));
    setFitZoom(newFit);
    setZoom(newFit);
    requestAnimationFrame(() => applyZoom());
  }, [setFitZoom, setZoom, applyZoom]);

  // Refit on image load and container resize
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const onLoad = () => { if (!userZoomed) refitImage(); };
    img.addEventListener('load', onLoad);
    const ro = new ResizeObserver(() => { if (!userZoomed) refitImage(); });
    ro.observe(imgContainerRef.current!);
    return () => { img.removeEventListener('load', onLoad); ro.disconnect(); };
  }, [refitImage, userZoomed]);

  // Apply zoom when zoom value changes
  useEffect(() => { applyZoom(); }, [applyZoom]);

  // ---- Zoom controls ----
  const zoomIn = () => { setZoom(Math.min(zoom + 0.25, 5.0)); setUserZoomed(true); requestAnimationFrame(() => applyZoom()); };
  const zoomOut = () => { setZoom(Math.max(zoom - 0.25, 0.1)); setUserZoomed(true); requestAnimationFrame(() => applyZoom()); };
  const zoomReset = () => { setUserZoomed(false); refitImage(); };

  // ---- Wheel/pinch zoom ----
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.002);
    const oldZoom = zoom;
    const newZoom = Math.min(Math.max(oldZoom * factor, 0.1), 5.0);
    if (newZoom === oldZoom) return;
    const img = imgRef.current;
    const container = imgContainerRef.current;
    if (!img || !img.naturalWidth) return;
    const r1 = img.getBoundingClientRect();
    const fx = (e.clientX - r1.left) / Math.max(r1.width, 1);
    const fy = (e.clientY - r1.top) / Math.max(r1.height, 1);
    setZoom(newZoom);
    setUserZoomed(true);
    requestAnimationFrame(() => {
      applyZoom();
      const r2 = img.getBoundingClientRect();
      if (container) {
        container.scrollLeft += (r2.left + fx * r2.width) - e.clientX;
        container.scrollTop += (r2.top + fy * r2.height) - e.clientY;
      }
    });
  }, [zoom, setZoom, setUserZoomed, applyZoom]);

  // ---- Scroll sync (anchor-block based) ----
  const rightBlockSelector = resultViewMode === 'layout'
    ? '.layout-block' : '.md-block';

  const anchorLeft = useCallback((): { idx: number; offset: number } | null => {
    const container = imgContainerRef.current;
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !currentBlocks.length) return null;
    const res = pageData?.json?.res || pageData?.json || {};
    const coordW = res.width || res.page_width;
    if (!coordW) return null;
    const imgRect = img.getBoundingClientRect();
    const cRect = container!.getBoundingClientRect();
    const scale = imgRect.width / coordW;
    const imgTop = imgRect.top - cRect.top + container!.scrollTop;
    const anchorY = container!.scrollTop + container!.clientHeight * ANCHOR_RATIO;
    let best: { idx: number; offset: number } | null = null;
    currentBlocks.forEach((block: any, idx: number) => {
      const bb = block.block_bbox;
      if (!bb || bb.length !== 4) return;
      const top = imgTop + bb[1] * scale;
      if (top <= anchorY) best = { idx, offset: anchorY - top };
    });
    return best;
  }, [currentBlocks, pageData]);

  const anchorRight = useCallback((): { idx: number; offset: number } | null => {
    if (resultViewMode === 'layout' && layoutZoom !== 1) return null;
    const container = mdContainerRef.current;
    if (!container) return null;
    const blocks = container.querySelectorAll(rightBlockSelector);
    if (!blocks.length) return null;
    const cRect = container.getBoundingClientRect();
    const anchorY = container.scrollTop + container.clientHeight * ANCHOR_RATIO;
    let best: { idx: number; offset: number } | null = null;
    blocks.forEach((el: Element) => {
      const idxAttr = (el as HTMLElement).dataset.blockIdx;
      if (idxAttr === undefined) return;
      const top = (el as HTMLElement).getBoundingClientRect().top - cRect.top + container.scrollTop;
      if (top <= anchorY) best = { idx: Number(idxAttr), offset: anchorY - top };
    });
    return best;
  }, [resultViewMode, layoutZoom, rightBlockSelector]);

  const scrollLeftTo = useCallback((idx: number, offset: number) => {
    const container = imgContainerRef.current;
    const img = imgRef.current;
    const block = currentBlocks[idx];
    if (!img || !img.naturalWidth || !block) return false;
    const bb = block.block_bbox;
    if (!bb || bb.length !== 4) return false;
    const res = pageData?.json?.res || pageData?.json || {};
    const coordW = res.width || res.page_width;
    if (!coordW) return false;
    const imgRect = img.getBoundingClientRect();
    const cRect = container!.getBoundingClientRect();
    const scale = imgRect.width / coordW;
    const imgTop = imgRect.top - cRect.top + container!.scrollTop;
    const blockTop = imgTop + bb[1] * scale;
    container!.scrollTop = blockTop + offset - container!.clientHeight * ANCHOR_RATIO;
    return true;
  }, [currentBlocks, pageData]);

  const scrollRightTo = useCallback((idx: number, offset: number) => {
    if (resultViewMode === 'layout' && layoutZoom !== 1) return false;
    const container = mdContainerRef.current;
    if (!container) return false;
    const el = container.querySelector(`${rightBlockSelector}[data-block-idx="${idx}"]`);
    if (!el) return false;
    const cRect = container.getBoundingClientRect();
    const top = (el as HTMLElement).getBoundingClientRect().top - cRect.top + container.scrollTop;
    container.scrollTop = top + offset - container.clientHeight * ANCHOR_RATIO;
    return true;
  }, [resultViewMode, layoutZoom, rightBlockSelector]);

  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (!syncScroll || scrollSyncLock.current) return;
    scrollSyncLock.current = true;
    const left = imgContainerRef.current;
    const right = mdContainerRef.current;
    if (!left || !right) { scrollSyncLock.current = false; return; }
    if (source === 'left') {
      const a = anchorLeft();
      const synced = a ? scrollRightTo(a.idx, a.offset) : false;
      if (!synced && left.scrollHeight > left.clientHeight) {
        const pct = left.scrollTop / (left.scrollHeight - left.clientHeight);
        right.scrollTop = pct * (right.scrollHeight - right.clientHeight);
      }
    } else {
      const a = anchorRight();
      const synced = a ? scrollLeftTo(a.idx, a.offset) : false;
      if (!synced && right.scrollHeight > right.clientHeight) {
        const pct = right.scrollTop / (right.scrollHeight - right.clientHeight);
        left.scrollTop = pct * (left.scrollHeight - left.clientHeight);
      }
    }
    setTimeout(() => { scrollSyncLock.current = false; }, 50);
  }, [syncScroll, anchorLeft, anchorRight, scrollLeftTo, scrollRightTo]);

  // ---- Hover linkage ----
  const setHover = useCallback((idx: number, source: 'img' | 'md') => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setHoverIdx(idx);
  }, [setHoverIdx]);

  const scheduleClearHover = useCallback(() => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setHoverIdx(null), 120);
  }, [setHoverIdx]);

  // ---- Lasso (dual-panel) ----
  const bandStart = useCallback((e: React.MouseEvent, panel: 'img' | 'result') => {
    if (!selectMode || e.button !== 0) return;
    const el = panel === 'img' ? imgRef.current : mdContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    e.preventDefault();
    setSelPanel(panel);
    bandState.current = { panel, x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY, moved: false };
  }, [selectMode, setSelPanel]);

  const bandMove = useCallback((e: React.MouseEvent, panel: 'img' | 'result') => {
    if (!bandState.current || bandState.current.panel !== panel) return;
    const band = bandState.current;
    band.x2 = e.clientX; band.y2 = e.clientY;
    if (Math.abs(band.x2 - band.x1) > 5 || Math.abs(band.y2 - band.y1) > 5) band.moved = true;
    if (panel === 'img') {
      const img = imgRef.current; if (!img) return;
      const rect = img.getBoundingClientRect();
      const l = Math.max(0, Math.min(band.x1, band.x2) - rect.left);
      const t = Math.max(0, Math.min(band.y1, band.y2) - rect.top);
      const r = Math.min(rect.width, Math.max(band.x1, band.x2) - rect.left);
      const b = Math.min(rect.height, Math.max(band.y1, band.y2) - rect.top);
      const el = bandRef.current; if (!el) return;
      el.style.display = 'block';
      el.style.left = (l / rect.width * 100) + '%';
      el.style.top = (t / rect.height * 100) + '%';
      el.style.width = ((r - l) / rect.width * 100) + '%';
      el.style.height = ((b - t) / rect.height * 100) + '%';
    } else {
      const container = mdContainerRef.current; if (!container) return;
      const rect = container.getBoundingClientRect();
      const x1 = Math.max(rect.left, Math.min(band.x1, band.x2));
      const y1 = Math.max(rect.top, Math.min(band.y1, band.y2));
      const x2 = Math.min(rect.right, Math.max(band.x1, band.x2));
      const y2 = Math.min(rect.bottom, Math.max(band.y1, band.y2));
      const el = bandRightRef.current; if (!el) return;
      el.style.display = 'block';
      el.style.left = (x1 - rect.left + container.scrollLeft) + 'px';
      el.style.top = (y1 - rect.top + container.scrollTop) + 'px';
      el.style.width = (x2 - x1) + 'px';
      el.style.height = (y2 - y1) + 'px';
    }
  }, []);

  const bandEnd = useCallback((e: React.MouseEvent) => {
    if (!bandState.current) return;
    const band = bandState.current;
    bandState.current = null;
    const el = band.panel === 'img' ? bandRef.current : bandRightRef.current;
    if (el) el.style.display = 'none';
    if (!selectMode) return;

    if (band.panel === 'result') {
      if (!band.moved) {
        const blockEl = (e.target as HTMLElement).closest?.('.md-block, .layout-block') as HTMLElement | null;
        if (blockEl && blockEl.dataset.blockIdx !== undefined) {
          useViewerStore.getState().toggleBlock(Number(blockEl.dataset.blockIdx));
        }
      } else {
        const x1 = Math.min(band.x1, band.x2), y1 = Math.min(band.y1, band.y2);
        const x2 = Math.max(band.x1, band.x2), y2 = Math.max(band.y1, band.y2);
        const container = mdContainerRef.current;
        if (container) {
          container.querySelectorAll(rightBlockSelector).forEach(el => {
            const idxAttr = (el as HTMLElement).dataset.blockIdx;
            if (idxAttr === undefined) return;
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) {
              useViewerStore.getState().addBlock(Number(idxAttr));
            }
          });
        }
      }
      return;
    }

    // Left panel (image)
    const res = pageData?.json?.res || pageData?.json || {};
    const coordW = res.width || res.page_width;
    const coordH = res.height || res.page_height;
    if (!coordW || !coordH) return;
    const img = imgRef.current; if (!img) return;
    const rect = img.getBoundingClientRect();
    if (!band.moved) {
      const px = (e.clientX - rect.left) / rect.width * coordW;
      const py = (e.clientY - rect.top) / rect.height * coordH;
      const idx = blockAtPoint(currentBlocks, px, py);
      if (idx !== null) useViewerStore.getState().toggleBlock(idx);
    } else {
      const x1 = Math.max(0, (Math.min(band.x1, band.x2) - rect.left) / rect.width * coordW);
      const y1 = Math.max(0, (Math.min(band.y1, band.y2) - rect.top) / rect.height * coordH);
      const x2 = Math.min(coordW, (Math.max(band.x1, band.x2) - rect.left) / rect.width * coordW);
      const y2 = Math.min(coordH, (Math.max(band.y1, band.y2) - rect.top) / rect.height * coordH);
      currentBlocks.forEach((block: any, idx: number) => {
        const bb = block.block_bbox;
        if (!bb || bb.length !== 4) return;
        if (bb[0] < x2 && bb[2] > x1 && bb[1] < y2 && bb[3] > y1) {
          useViewerStore.getState().addBlock(idx);
        }
      });
    }
  }, [selectMode, pageData, currentBlocks, rightBlockSelector]);

  // ---- Sync selection highlight + order number onto md-block / layout-block ----
  // flow/layout blocks are rendered via innerHTML with a fixed class, so
  // toggling selectedBlocks doesn't re-render them; mirror the SVG polygon
  // .sel class + a 1-based data-sel-num badge here (legacy renderSelection).
  useEffect(() => {
    const clear = (c: Element | null) => c?.querySelectorAll('.md-block.sel, .layout-block.sel')
      .forEach(el => { el.classList.remove('sel'); el.removeAttribute('data-sel-num'); });
    clear(mdContentRef.current);
    clear(layoutContentRef.current);
    const idxs = [...selectedBlocks].sort((a, b) => a - b);
    idxs.forEach((idx, i) => {
      const num = String(i + 1);
      const md = mdContentRef.current?.querySelector(`.md-block[data-block-idx="${idx}"]`);
      if (md) { md.classList.add('sel'); md.setAttribute('data-sel-num', num); }
      const lb = layoutContentRef.current?.querySelector(`.layout-block[data-block-idx="${idx}"]`);
      if (lb) { lb.classList.add('sel'); lb.setAttribute('data-sel-num', num); }
    });
  }, [selectedBlocks]);

  // ---- Copy ----
  const copyHoveredBlock = useCallback(async () => {
    if (hoverIdx === null) return;
    const block = currentBlocks[hoverIdx];
    if (!block) return;
    let done = false;
    try {
      done = await copyRichText(currentBatch!, currentFile!, currentPage, hoverIdx);
    } catch { /* fall back */ }
    if (!done) await copyPlainText(block.block_content || '');
  }, [hoverIdx, currentBlocks, currentBatch, currentFile, currentPage]);

  const copySelection = useCallback(async () => {
    const idxs = [...selectedBlocks];
    if (!idxs.length) return;
    let done = false;
    try {
      done = await copyRichText(currentBatch!, currentFile!, currentPage, null, idxs);
    } catch { /* fall back */ }
    if (!done) {
      const text = idxs.sort((a, b) => a - b)
        .map(i => currentBlocks[i]?.block_content || '')
        .filter(Boolean).join('\n\n');
      await copyPlainText(text);
    }
  }, [selectedBlocks, currentBatch, currentFile, currentPage, currentBlocks]);

  // ---- Flow rendering ----
  useEffect(() => {
    const container = mdContentRef.current;
    if (!container) return;
    if (!pageData) {
      container.innerHTML = '<p class="viewer-loading">加载中...</p>';
      return;
    }
    if (pageData.error) {
      container.innerHTML = '<p class="viewer-error">该批次暂无结果数据（可能处理失败或已被清理）</p>';
      return;
    }
    // Guard against stale data: pageData may still belong to the previously
    // viewed batch while the new page request is in flight. Rendering it with
    // the new batch/file parameters would mint broken image URLs.
    if (currentBatch && currentFile != null &&
      (pageData.batch_id !== currentBatch || pageData.file_id !== currentFile || pageData.page_id !== currentPage)) {
      return;
    }
    const res = pageData.json?.res || pageData.json || {};
    const blocks = res.parsing_res_list || [];
    if (!blocks.length) {
      container.innerHTML = pageData.markdown || '<p>暂无内容</p>';
      renderMath(container);
      if (currentBatch && currentFile != null) {
        fixImagePaths(container, currentBatch, currentFile, currentPage);
      }
      return;
    }
    const imgTags = (pageData.markdown || '').match(/<img[^>]*>/g) || [];
    let imgCursor = 0;
    container.innerHTML = blocks.map((block: any, idx: number) => {
      const label = block.block_label || '';
      const labelZh = LABEL_MAP[label] || label;
      let content = block.block_content || '';
      if (!content.includes('<img') && (label === 'image' || label === 'chart' || label === 'seal')) {
        const tag = imgTags[imgCursor++] || '';
        if (tag) content = `<div style="text-align:center">${tag}</div>`;
      }
      const body = parseBlockMd(content);
      return `<div class="md-block" data-block-idx="${idx}" data-label="${label}">
        <span class="md-block-tag">${labelZh}</span>
        <div class="md-block-body">${body}</div>
      </div>`;
    }).join('');
    renderMath(container);
    if (currentBatch && currentFile != null) {
      fixImagePaths(container, currentBatch, currentFile, currentPage);
    }
  }, [pageData, currentBatch, currentFile, currentPage]);

  // ---- Layout rendering ----
  useEffect(() => {
    const container = layoutContentRef.current;
    if (!container || !pageData || resultViewMode !== 'layout') return;
    if (pageData.error) {
      container.innerHTML = '<div class="layout-empty">该批次暂无结果数据</div>';
      return;
    }
    // Same stale-data guard as the flow renderer above.
    if (currentBatch && currentFile != null &&
      (pageData.batch_id !== currentBatch || pageData.file_id !== currentFile || pageData.page_id !== currentPage)) {
      return;
    }
    const res = pageData.json?.res || pageData.json || {};
    const blocks = res.parsing_res_list || [];
    const coordW = res.width || res.page_width;
    const coordH = res.height || res.page_height;
    if (!blocks.length || !coordW || !coordH) {
      container.innerHTML = '<div class="layout-empty">该页无版面数据</div>';
      return;
    }
    const imgTags = (pageData.markdown || '').match(/<img[^>]*>/g) || [];
    let imgCursor = 0;
    container.innerHTML = `<div class="layout-canvas" style="aspect-ratio:${coordW}/${coordH}">` +
      blocks.map((block: any, idx: number) => {
        const [x1, y1, x2, y2] = block.block_bbox || [0, 0, coordW, coordH];
        const label = block.block_label || '';
        const content = block.block_content || '';
        const style = `left:${(x1 / coordW * 100).toFixed(3)}%;top:${(y1 / coordH * 100).toFixed(3)}%;width:${((x2 - x1) / coordW * 100).toFixed(3)}%;height:${((y2 - y1) / coordH * 100).toFixed(3)}%;`;
        let body = '';
        if (isPureImageBlock(label, content)) {
          const tag = content.includes('<img') ? content : (imgTags[imgCursor++] || '');
          if (tag) body = tag.replace(/^<img/, '<img style="width:100%;height:100%;object-fit:fill;"');
        } else {
          body = parseBlockMd(content);
        }
        return `<div class="layout-block" data-block-idx="${idx}" data-label="${label}" style="${style}"><div class="lb-body">${body}</div></div>`;
      }).join('') + '</div>';
    renderMath(container);
    if (currentBatch && currentFile != null) {
      fixImagePaths(container, currentBatch, currentFile, currentPage);
    }
    // Shrink-to-fit
    container.querySelectorAll('.layout-block').forEach(block => {
      const body = block.querySelector('.lb-body');
      if (!body) return;
      const label = (block as HTMLElement).dataset.label || '';
      const onlyChild = body.children.length === 1 ? body.children[0] : null;
      if (onlyChild && onlyChild.tagName === 'IMG' && isPureImageBlock(label, '')) return;
      const W = (block as HTMLElement).clientWidth, H = (block as HTMLElement).clientHeight;
      if (!W || !H) return;
      const len = Math.max((body.textContent || '').length, 1);
      let fs = Math.min(H * 0.8, Math.sqrt(W * H * 1.9 / len));
      fs = Math.max(6, Math.min(fs, 28));
      (body as HTMLElement).style.fontSize = fs + 'px';
      for (let i = 0; i < 15 && fs > 6 && (body.scrollHeight > H || body.scrollWidth > W); i++) {
        fs = Math.max(6, fs * 0.92);
        (body as HTMLElement).style.fontSize = fs + 'px';
      }
    });
    applyZoom();
  }, [pageData, resultViewMode, currentBatch, currentFile, currentPage, applyZoom]);

  // ---- Divider drag ----
  useEffect(() => {
    const divider = dividerRef.current;
    const left = leftPanelRef.current;
    const split = splitViewRef.current;
    if (!divider || !left || !split) return;
    const clampW = (w: number) => {
      const total = split.getBoundingClientRect().width;
      return Math.max(280, Math.min(w, total - 280));
    };
    const saved = parseInt(localStorage.getItem('ocr_split_left') || '0', 10);
    if (saved > 0) {
      const apply = () => { left.style.flex = `0 0 ${clampW(saved)}px`; };
      if (split.getBoundingClientRect().width >= 600) apply();
      else {
        const ro = new ResizeObserver(() => {
          if (split.getBoundingClientRect().width < 600) return;
          ro.disconnect(); apply();
        });
        ro.observe(split);
      }
    }
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      divider.classList.add('dragging');
      const startX = e.clientX;
      const startW = left.getBoundingClientRect().width;
      let lastW = startW;
      const onMove = (ev: MouseEvent) => {
        lastW = clampW(startW + (ev.clientX - startX));
        left.style.flex = `0 0 ${lastW}px`;
      };
      const onUp = () => {
        divider.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('ocr_split_left', String(Math.round(lastW)));
        if (!userZoomed) refitImage();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    divider.addEventListener('mousedown', onDown);
    return () => divider.removeEventListener('mousedown', onDown);
    // viewMode in deps so the listener re-binds when the divider re-mounts
    // after switching back from original/markdown mode (otherwise dragging
    // silently stops working until a zoom change forces a re-run).
  }, [userZoomed, refitImage, viewMode]);

  // ---- Keyboard navigation ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && currentPage > 0) {
        loadPage(currentBatch!, currentFile!, currentPage - 1);
      }
      if (e.key === 'ArrowRight' && currentPage < (batchData?.total_pages || 1) - 1) {
        loadPage(currentBatch!, currentFile!, currentPage + 1);
      }
      if (e.key === 'Escape') {
        if (selectedBlocks.size) useViewerStore.getState().clearSelection();
        else if (selectMode) toggleSelectMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage, currentBatch, currentFile, batchData, selectedBlocks, selectMode, toggleSelectMode, loadPage]);

  // ---- Render ----
  const res = pageData?.json?.res || pageData?.json || {};
  const coordW = res.width || res.page_width;
  const coordH = res.height || res.page_height;
  const hasScore = pageData?.has_score !== false;
  // The image is always the clean original; the toggle button drives the
  // SVG annotation overlay (overlayVisible) instead of swapping image URLs.
  const imgUrl = pageData?.original_image_url;
  const showOverlay = overlayVisible && currentBlocks.length > 0;
  // Selection order map (block idx -> 1-based badge number) for SVG labels
  const selOrder = new Map<number, number>([...selectedBlocks].sort((a, b) => a - b).map((idx, i) => [idx, i + 1]));
  const showLeft = viewMode !== 'markdown';
  const showRight = viewMode !== 'original';
  const showDivider = viewMode === 'split';

  return (
    <div className="split-view" ref={splitViewRef} id="split-view">
      {showLeft && (
        <div id="left-panel" ref={leftPanelRef} className="panel">
          <div className="panel-header">
            <span className="panel-title">原图</span>
            <div className="panel-controls">
              <button className="btn-icon" onClick={zoomIn} title="放大"><ZoomIcon type="in" /></button>
              <button className="btn-icon" onClick={zoomOut} title="缩小"><ZoomIcon type="out" /></button>
              <button className="btn-icon" onClick={zoomReset} title="重置缩放"><ZoomIcon type="reset" /></button>
              <button className={`btn-icon ${overlayVisible ? 'active' : ''}`} onClick={toggleOverlay} title="显示/隐藏标注框"><OverlayIcon /></button>
              <button className={`btn-icon ${selectMode ? 'active' : ''}`} onClick={toggleSelectMode} title="框选模式"><LassoIcon /></button>
            </div>
          </div>
          <div className={`image-container ${selectMode ? 'select-mode' : ''}`} ref={imgContainerRef}
            onWheel={onWheel}
            onMouseDown={(e) => bandStart(e, 'img')}
            onMouseMove={(e) => bandMove(e, 'img')}
            onMouseUp={bandEnd}
            onScroll={() => handleScroll('left')}>
            <div className={`image-wrapper ${!showRight ? 'full' : ''}`}>
              <img ref={imgRef} src={imgUrl || ''} alt="页面图片" />
              {showOverlay && (
                <svg ref={svgRef} className="overlay-svg" preserveAspectRatio="none"
                  viewBox={`0 0 ${coordW} ${coordH}`}>
                  {currentBlocks.map((block: any, idx: number) => {
                    const pts = blockPoints(block);
                    if (!pts) return null;
                    const score = blockScores[idx];
                    const cls = blockClass(hasScore, score, block.block_label || '');
                    const num = selOrder.get(idx);
                    const bb = block.block_bbox || [];
                    const cx = bb.length === 4 ? (bb[0] + bb[2]) / 2 : 0;
                    const cy = bb.length === 4 ? (bb[1] + bb[3]) / 2 : 0;
                    return (
                      <g key={idx}>
                        <polygon points={pts} className={`ovl ${cls} ${hoverIdx === idx ? 'hl' : ''} ${selectedBlocks.has(idx) ? 'sel' : ''}`}
                          data-block-idx={idx}
                          onMouseEnter={(e) => setHover(idx, 'img')}
                          onMouseMove={(e) => { if (tooltipRef.current) { tooltipRef.current.style.display = 'block'; tooltipRef.current.style.left = (e.clientX + 12) + 'px'; tooltipRef.current.style.top = (e.clientY + 14) + 'px'; tooltipRef.current.textContent = `${LABEL_MAP[block.block_label] || block.block_label || ''}${score != null ? ' · ' + Number(score).toFixed(2) : ''}`; } }}
                          onMouseLeave={scheduleClearHover} />
                        {num && <text x={cx} y={cy} className="sel-num">{num}</text>}
                      </g>
                    );
                  })}
                </svg>
              )}
              <div className="select-band" ref={bandRef} style={{ display: 'none' }} />
            </div>
          </div>
        </div>
      )}

      {showDivider && <div className="split-divider" id="split-divider" ref={dividerRef}></div>}

      {showRight && (
        <div className="panel" id="right-panel" ref={rightPanelRef}>
          <div className="panel-header">
            <span className="panel-title">解析结果</span>
            <div className="panel-controls">
              <div className="view-mode-toggle" title="结果展示方式">
                <button className={`btn-toggle ${resultViewMode === 'flow' ? 'active' : ''}`} onClick={() => setResultViewMode('flow')}>流式</button>
                <button className={`btn-toggle ${resultViewMode === 'layout' ? 'active' : ''}`} onClick={() => setResultViewMode('layout')}>版面</button>
              </div>
              <button className="btn-icon" title="复制到 Word" onClick={() => copyRichText(currentBatch!, currentFile!, currentPage)}><CopyIcon /></button>
              <SelectionPopover />
              <button className={`btn-icon ${syncScroll ? 'active' : ''}`} onClick={toggleSyncScroll} title="同步滚动"><SyncIcon /></button>
            </div>
          </div>
          <div className={`markdown-container ${selectMode ? 'select-mode' : ''}`} ref={mdContainerRef}
            onMouseDown={(e) => bandStart(e, 'result')}
            onMouseMove={(e) => bandMove(e, 'result')}
            onMouseUp={bandEnd}
            onScroll={() => handleScroll('right')}>
            <div className="markdown-content" id="markdown-content" ref={mdContentRef}
              style={{ display: resultViewMode === 'flow' ? '' : 'none' }}
              onMouseOver={(e) => { const b = (e.target as HTMLElement).closest('.md-block') as HTMLElement | null; if (b && b.dataset.blockIdx !== undefined) { setHover(Number(b.dataset.blockIdx), 'md'); } }}
              onMouseLeave={scheduleClearHover} />
            <div className="layout-content" id="layout-content" ref={layoutContentRef}
              style={{ display: resultViewMode === 'layout' ? '' : 'none' }} />
            <div className="select-band" ref={bandRightRef} style={{ display: 'none' }} />
          </div>
        </div>
      )}

      {/* Floating tooltip */}
      <div className="overlay-tooltip" ref={tooltipRef} style={{ display: 'none' }} />

      {/* Floating block copy button */}
      {hoverIdx !== null && !selectMode && (
        <button className="block-copy-btn" onClick={copyHoveredBlock}
          style={{ position: 'fixed', right: 12, top: 120, zIndex: 9999 }}>
          复制
        </button>
      )}
    </div>
  );
}

// ---- SVG icon components ----
function ZoomIcon({ type }: { type: 'in' | 'out' | 'reset' }) {
  if (type === 'reset') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9" /><polyline points="3 4 3 12 11 12" /></svg>;
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />{type === 'in' ? <><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></> : <line x1="8" y1="11" x2="14" y2="11" />}</svg>;
}
function OverlayIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>; }
function LassoIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="9" r="6" strokeDasharray="3 2" /><line x1="14.2" y1="13.2" x2="20" y2="19" /></svg>; }
function CopyIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>; }
function SyncIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 6H3M21 12H3M21 18H3" /></svg>; }
