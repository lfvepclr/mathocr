"""Batch, file, page listing and alias APIs."""

import json
import logging
from pathlib import Path

from robyn import Request, jsonify

from app.core.job_queue import job_queue
from app.services import batch_manager

logger = logging.getLogger(__name__)


def register(app):
    @app.get("/api/batches")
    def list_batches(request: Request):
        """List all historical batches, optional status filter."""
        qp = request.query_params
        status = qp.get("status", None) if qp else None
        limit = int(qp.get("limit", "50") or "50") if qp else 50
        batches = batch_manager.list_batches(limit=limit, status=status)
        for b in batches:
            if b["status"] in ("processing", "queued"):
                try:
                    b["progress"] = batch_manager.get_batch_live_progress(b["batch_id"])
                except Exception:
                    logger.exception("Failed to compute progress for %s", b["batch_id"])
        return jsonify(batches)

    @app.get("/api/batch/:batch_id")
    def get_batch(request: Request):
        batch_id = request.path_params["batch_id"]
        summary = batch_manager.get_batch_summary(batch_id)
        if not summary:
            return jsonify({"error": "Batch not found"})
        return jsonify(summary)

    @app.delete("/api/batch/:batch_id")
    def delete_batch(request: Request):
        batch_id = request.path_params["batch_id"]
        batch_manager.delete_batch(batch_id)
        return jsonify({"deleted": batch_id})

    @app.get("/api/batch/:batch_id/file/:file_id")
    def get_file(request: Request):
        batch_id = request.path_params["batch_id"]
        file_id = request.path_params["file_id"]
        files = batch_manager.get_files(batch_id)
        file_info = next((f for f in files if f["file_id"] == file_id), None)
        if not file_info:
            return jsonify({"error": "File not found"})
        pages = batch_manager.get_pages(batch_id, file_id)
        return jsonify(
            {
                **file_info,
                "pages": [
                    {
                        "page_id": p["page_id"],
                        "has_result": p["has_result"],
                        "block_count": p["block_count"],
                        "avg_score": p["avg_score"],
                    }
                    for p in pages
                ],
            }
        )

    @app.get("/api/batch/:batch_id/file/:file_id/page/:page_id")
    def get_page(request: Request):
        batch_id = request.path_params["batch_id"]
        file_id = request.path_params["file_id"]
        page_id = int(request.path_params["page_id"])

        page = batch_manager.get_page(batch_id, file_id, page_id)
        if not page:
            return jsonify({"error": "Page not found"})

        md_content = ""
        if page["markdown_path"]:
            md_path = Path(page["markdown_path"])
            if md_path.exists():
                md_content = md_path.read_text(encoding="utf-8")

        json_data = None
        if page["json_path"]:
            json_path = Path(page["json_path"])
            if json_path.exists():
                json_data = json.loads(json_path.read_text(encoding="utf-8"))

        res = (json_data or {}).get("res") or {}
        boxes = (res.get("layout_det_res") or {}).get("boxes") or []
        has_score = res.get("has_score")
        if has_score is None:
            has_score = any("score" in b for b in boxes) if boxes else True

        return jsonify(
            {
                "page_id": page["page_id"],
                "batch_id": batch_id,
                "file_id": file_id,
                "has_result": page["has_result"],
                "block_count": page["block_count"],
                "avg_score": page["avg_score"],
                "markdown": md_content,
                "json": json_data,
                "engine": res.get("engine", "local"),
                "has_score": bool(has_score),
                "original_image_url": f"/api/image/{batch_id}/{file_id}/{page_id}?type=original",
                "annotated_image_url": f"/api/image/{batch_id}/{file_id}/{page_id}?type=annotated",
            }
        )

    @app.post("/api/batch/:batch_id/alias")
    def set_batch_alias(request: Request):
        batch_id = request.path_params["batch_id"]
        try:
            data = request.json()
            alias = data.get("alias", "") if isinstance(data, dict) else ""
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid JSON"})
        batch_manager.update_batch_alias(batch_id, alias)
        return jsonify({"batch_id": batch_id, "alias": alias})

    @app.get("/api/queue/status")
    def queue_status(_request: Request):
        return jsonify(
            {
                "queue_size": job_queue.get_queue_size(),
                "statuses": job_queue.get_all_status(),
            }
        )
