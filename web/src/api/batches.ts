/** Batch, file, and page API. */
import { getJSON, postJSON } from './client';

export interface BatchSummary {
  error?: string;
  batch_id: string;
  status: string;
  engine: string;
  alias: string | null;
  original_name: string | null;
  created_at: string;
  completed_at: string | null;
  processing_time: number | null;
  file_count: number;
  total_pages: number;
  cost: number;
  api_calls: number;
  files: FileInfo[];
  progress?: BatchProgress;
}

export interface FileInfo {
  file_id: string;
  original_name: string;
  file_type: string;
  file_size: number;
  page_count: number;
  total_pages: number;
  status: string;
  error_message: string | null;
  completed_at: string | null;
  processing_time: number | null;
}

export interface BatchProgress {
  total_files: number;
  completed_files: number;
  total_pages: number;
  completed_pages: number;
  current_file: string | null;
  current_page: number | null;
  percent: number;
}

export interface PageData {
  error?: string;
  page_id: number;
  // Ownership markers (echoed from the server) so renderers can detect
  // stale page data after the user switches batch/file/page mid-flight.
  batch_id?: string;
  file_id?: string;
  has_result: boolean;
  block_count: number;
  avg_score: number;
  markdown: string;
  json: any;
  engine: string;
  has_score: boolean;
  original_image_url: string;
  annotated_image_url: string;
}

export const batchesApi = {
  list: (status?: string) =>
    getJSON<BatchSummary[]>(`/api/batches${status ? `?status=${status}` : ''}`),
  get: (id: string) => getJSON<BatchSummary>(`/api/batch/${id}`),
  delete: (id: string) => postJSON(`/api/batch/${id}`),  // DELETE is also fine
  getFile: (bid: string, fid: string) => getJSON<any>(`/api/batch/${bid}/file/${fid}`),
  getPage: (bid: string, fid: string, pid: number) =>
    getJSON<PageData>(`/api/batch/${bid}/file/${fid}/page/${pid}`),
  setAlias: (bid: string, alias: string) =>
    postJSON(`/api/batch/${bid}/alias`, { alias }),
  queueStatus: () => getJSON<{ queue_size: number; statuses: Record<string, string> }>(`/api/queue/status`),
};
