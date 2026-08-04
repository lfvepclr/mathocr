/** Viewer state: page data, blocks, zoom, selection, hover, view mode. */
import { create } from 'zustand';
import type { PageData } from '@/api/batches';
import { STORAGE_KEYS } from '@/lib/storage';

type ResultViewMode = 'flow' | 'layout';

interface ViewerState {
  // Page data
  pageData: PageData | null;
  currentBlocks: any[];
  blockScores: Record<number, number | undefined>;
  totalPages: number;

  // Zoom
  zoom: number;
  fitZoom: number;
  layoutZoom: number;
  userZoomed: boolean;

  // Overlay
  overlayVisible: boolean;

  // View mode
  resultViewMode: ResultViewMode;
  syncScroll: boolean;

  // Lasso
  selectMode: boolean;
  selectedBlocks: Set<number>;
  selPanel: 'img' | 'result';

  // Hover
  hoverIdx: number | null;

  // Actions
  setPageData: (data: PageData) => void;
  setZoom: (z: number) => void;
  setFitZoom: (z: number) => void;
  setLayoutZoom: (z: number) => void;
  setUserZoomed: (v: boolean) => void;
  toggleOverlay: () => void;
  setResultViewMode: (m: ResultViewMode) => void;
  toggleSyncScroll: () => void;
  toggleSelectMode: () => void;
  toggleBlock: (idx: number) => void;
  addBlock: (idx: number) => void;
  clearSelection: () => void;
  setSelPanel: (p: 'img' | 'result') => void;
  setHoverIdx: (idx: number | null) => void;
  setTotalPages: (n: number) => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  pageData: null,
  currentBlocks: [],
  blockScores: {},
  totalPages: 1,

  zoom: 1.0,
  fitZoom: 1.0,
  layoutZoom: 1.0,
  userZoomed: false,

  overlayVisible: localStorage.getItem(STORAGE_KEYS.overlay) !== '0',

  resultViewMode: (localStorage.getItem(STORAGE_KEYS.viewMode) as ResultViewMode) || 'flow',
  syncScroll: true,

  selectMode: false,
  selectedBlocks: new Set(),
  selPanel: 'img',

  hoverIdx: null,

  setPageData: (data) => {
    const res = data?.json?.res || data?.json || {};
    const blocks = res.parsing_res_list || [];
    const detBoxes = res.layout_det_res?.boxes || [];
    const scoreByOrder: Record<number, number | undefined> = {};
    detBoxes.forEach((b: any) => { scoreByOrder[b.order] = b.score; });
    const hasScore = data.has_score !== false;
    const blockScores: Record<number, number | undefined> = {};
    blocks.forEach((_: any, idx: number) => {
      blockScores[idx] = hasScore ? scoreByOrder[blocks[idx].block_order] : undefined;
    });
    set({ pageData: data, currentBlocks: blocks, blockScores, selectedBlocks: new Set(), hoverIdx: null });
  },

  setZoom: (z) => set({ zoom: z }),
  setFitZoom: (z) => set({ fitZoom: z }),
  setLayoutZoom: (z) => set({ layoutZoom: z }),
  setUserZoomed: (v) => set({ userZoomed: v }),
  toggleOverlay: () => set((s) => {
    const v = !s.overlayVisible;
    localStorage.setItem(STORAGE_KEYS.overlay, v ? '1' : '0');
    return { overlayVisible: v };
  }),
  setResultViewMode: (m) => {
    localStorage.setItem(STORAGE_KEYS.viewMode, m);
    set({ resultViewMode: m });
  },
  toggleSyncScroll: () => set((s) => ({ syncScroll: !s.syncScroll })),
  toggleSelectMode: () => set((s) => ({ selectMode: !s.selectMode })),
  toggleBlock: (idx) => set((s) => {
    const blocks = new Set(s.selectedBlocks);
    if (blocks.has(idx)) blocks.delete(idx); else blocks.add(idx);
    return { selectedBlocks: blocks };
  }),
  addBlock: (idx) => set((s) => {
    const blocks = new Set(s.selectedBlocks);
    blocks.add(idx);
    return { selectedBlocks: blocks };
  }),
  clearSelection: () => set({ selectedBlocks: new Set() }),
  setSelPanel: (p) => set({ selPanel: p }),
  setHoverIdx: (idx) => set({ hoverIdx: idx }),
  setTotalPages: (n) => set({ totalPages: n }),
}));
