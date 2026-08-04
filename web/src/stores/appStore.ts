/** Main application state: routing, view mode, current batch/file/page. */
import { create } from 'zustand';
import { batchesApi, type BatchSummary, type PageData } from '@/api/batches';

// Monotonic guard for async page loads: a newer loadPage() call invalidates
// any in-flight one, so a slow stale response can never overwrite fresh data.
let pageLoadSeq = 0;

type ViewMode = 'split' | 'original' | 'markdown';
type ImageMode = 'annotated' | 'original';

interface AppState {
  // Routing
  route: 'upload' | 'batch';
  currentBatch: string | null;
  currentFile: string | null;
  currentPage: number;

  // Batch data
  batchData: BatchSummary | null;
  pageData: PageData | null;

  // View state
  viewMode: ViewMode;
  imageMode: ImageMode;
  sidebarCollapsed: boolean;
  showSettings: boolean;

  // Actions
  openBatch: (batchId: string) => Promise<void>;
  openFile: (fileId: string, pageId: number) => Promise<void>;
  loadPage: (batchId: string, fileId: string, pageId: number) => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  toggleImageMode: () => void;
  toggleSidebar: () => void;
  setShowSettings: (show: boolean) => void;
  showUploadView: () => void;
  handleRoute: () => void;
  updateBatchData: (data: Partial<BatchSummary>) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  route: 'upload',
  currentBatch: null,
  currentFile: null,
  currentPage: 0,
  batchData: null,
  pageData: null,
  viewMode: 'split',
  imageMode: 'annotated',
  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
  showSettings: false,

  openBatch: async (batchId) => {
    // Clear pageData immediately so the viewer never renders the previous
    // batch's content while the new page is still loading.
    set({ currentBatch: batchId, currentFile: null, currentPage: 0, route: 'batch', pageData: null });
    try {
      const data = await batchesApi.get(batchId);
      if (data.error) { alert('批次不存在'); return; }
      set({ batchData: data });
      const files = data.files || [];
      if (files.length > 0) {
        await get().openFile(files[0].file_id, 0);
      }
    } catch (err) {
      console.error('Failed to open batch:', err);
    }
  },

  openFile: async (fileId, pageId) => {
    const state = get();
    set({ currentFile: fileId, currentPage: pageId, pageData: null });
    // Ensure batchData loaded (deep-link path skips openBatch)
    if (!state.batchData || state.batchData.batch_id !== state.currentBatch) {
      try {
        const data = await batchesApi.get(state.currentBatch!);
        if (!data.error) set({ batchData: data });
      } catch (err) {
        console.warn('batchData fetch failed:', err);
      }
    }
    await get().loadPage(state.currentBatch!, fileId, pageId);
  },

  loadPage: async (batchId, fileId, pageId) => {
    const seq = ++pageLoadSeq;
    try {
      const page = await batchesApi.getPage(batchId, fileId, pageId);
      const s = get();
      // Drop the response if a newer load superseded it, or if the user has
      // since navigated elsewhere — otherwise stale data would be rendered
      // with the wrong batch/file parameters (e.g. broken image URLs).
      if (seq !== pageLoadSeq) return;
      if (s.currentBatch !== batchId || s.currentFile !== fileId || s.currentPage !== pageId) return;
      set({ pageData: page });
    } catch (err) {
      console.error('Failed to load page:', err);
    }
  },

  setViewMode: (mode) => set({ viewMode: mode }),
  toggleImageMode: () => set((s) => ({ imageMode: s.imageMode === 'annotated' ? 'original' : 'annotated' })),
  toggleSidebar: () => set((s) => {
    const collapsed = !s.sidebarCollapsed;
    localStorage.setItem('sidebarCollapsed', String(collapsed));
    return { sidebarCollapsed: collapsed };
  }),
  setShowSettings: (show) => set({ showSettings: show }),
  showUploadView: () => set({ route: 'upload', currentBatch: null, batchData: null, pageData: null }),
  updateBatchData: (data) => set((s) => ({ batchData: s.batchData ? { ...s.batchData, ...data } : null })),

  handleRoute: () => {
    const hash = window.location.hash.slice(1).replace(/^\//, '');
    if (!hash || hash === 'upload') {
      get().showUploadView();
      return;
    }
    const parts = hash.split('/');
    if (parts[0] === 'batch' && parts[1]) {
      const batchId = parts[1];
      if (parts[2] === 'file' && parts[3]) {
        const fileId = parts[3];
        const pageId = parts[5] ? parseInt(parts[5]) : 0;
        set({ currentBatch: batchId, route: 'batch' });
        get().openFile(fileId, pageId);
      } else {
        get().openBatch(batchId);
      }
    }
  },
}));
