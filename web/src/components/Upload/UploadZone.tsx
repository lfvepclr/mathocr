/** UploadZone — drag-drop file upload with engine selection. */
import { useState, useCallback, useRef, useEffect } from 'react';
import { uploadFiles } from '@/api/client';
import { settingsApi, type EngineInfo } from '@/api/settings';
import { useAppStore } from '@/stores/appStore';
import { useQueueStore } from '@/stores/queueStore';

export function UploadZone() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<string>('');
  const fileInput = useRef<HTMLInputElement>(null);
  const openBatch = useAppStore((s) => s.openBatch);
  const refreshQueue = useQueueStore((s) => s.refresh);

  // Load engines on mount
  useEffect(() => {
    settingsApi.engines().then(({ engines, default: def }) => {
      setEngines(engines);
      setSelectedEngine(def);
    });
  }, []);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    if (!files || (files as FileList).length === 0) return;
    setUploading(true);
    try {
      const result = await uploadFiles(Array.from(files) as File[], selectedEngine);
      if (result.batch_id) {
        refreshQueue();
        openBatch(result.batch_id);
      } else {
        alert('上传失败');
      }
    } catch (err) {
      console.error('Upload failed:', err);
      alert('上传失败: ' + err);
    } finally {
      setUploading(false);
    }
  }, [selectedEngine, openBatch, refreshQueue]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setDragging(false), []);

  const selectedInfo = engines.find((e) => e.id === selectedEngine);
  return (
    <>
      {/* Brand hero — the central "MathOCR" wordmark + tagline (legacy upload-hero) */}
      <div className="upload-hero">
        <h1>MathOCR</h1>
        <p className="subtitle">文档智能解析平台 — 本地 / 在线引擎可选、置信度标注、费用统计</p>
      </div>

      {/* Engine picker — tab style (engine-option active), not a <select> dropdown */}
      {engines.length > 0 && (
        <div className="engine-picker">
          <div className="engine-picker-head">
            <span className="engine-picker-title">识别引擎</span>
          </div>
          <div className="engine-select">
            {engines.filter((e) => e.configured).map((e) => (
              <button
                key={e.id}
                className={`engine-option ${selectedEngine === e.id ? 'active' : ''}`}
                onClick={() => setSelectedEngine(e.id)}
              >
                <span className="engine-option-name">{e.name}</span>
              </button>
            ))}
          </div>
          {selectedInfo?.note && <div className="engine-note">{selectedInfo.note}</div>}
        </div>
      )}

      <div
        className={`upload-zone ${dragging ? 'dragover' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => fileInput.current?.click()}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.bmp,.gif,.tiff,.tif,.webp"
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files ?? [])}
        />
        <div className="upload-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <p className="upload-text">点击上传或拖拽文件到此处开始解析</p>
        <p className="upload-hint">支持 PDF / PNG / JPG / BMP / GIF / TIFF / WEBP 格式</p>
        <p className="upload-hint">支持多文件同时上传，并行 OCR 识别</p>
        {uploading && <p className="upload-status">上传中…</p>}
      </div>
    </>
  );
}
