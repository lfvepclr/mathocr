"""Upload API: receive files and create OCR batches."""

import logging

from robyn import Request, jsonify

from app.core.job_queue import job_queue
from app.engines import registry as engine_registry
from app.services import batch_manager

logger = logging.getLogger(__name__)


def register(app):
    @app.post("/api/upload")
    async def upload(request: Request):
        """Receive multi-file upload, create batch, start background OCR.

        The OCR engine is passed as a query parameter (?engine=) rather
        than a form field: Robyn's multipart parsing exposes files only.
        """
        files = request.files
        if not files:
            return jsonify({"error": "No files uploaded"})

        qp = request.query_params
        engine = (qp.get("engine", None) if qp else None) or engine_registry.default_engine()
        if engine not in engine_registry.ENGINES:
            return jsonify({"error": f"未知的 OCR 引擎: {engine}"})
        if not engine_registry.is_configured(engine):
            name = engine_registry.ENGINES[engine]["name"]
            return jsonify({"error": f"引擎「{name}」未配置 API Key，请先在设置中填写"})

        uploaded_files = [(name, content) for name, content in files.items()]
        logger.info("Upload received: %d files (engine=%s)", len(uploaded_files), engine)

        batch_id = batch_manager.create_batch(uploaded_files, engine=engine)
        job_queue.enqueue(batch_id)

        return jsonify(
            {
                "batch_id": batch_id,
                "status": "queued",
                "file_count": len(uploaded_files),
                "engine": engine,
            }
        )
