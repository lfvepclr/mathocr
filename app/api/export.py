"""Export APIs: file export and Word-friendly rich text."""

import logging
from pathlib import Path

from robyn import Request, jsonify, serve_file

from app.services import exporter

logger = logging.getLogger(__name__)


def register(app):
    @app.get("/api/export/:batch_id")
    def export(request: Request):
        """Export batch or file as Markdown, Word, or layout HTML."""
        batch_id = request.path_params["batch_id"]
        fmt = "md"
        file_id = None
        qp = request.query_params
        if qp:
            fmt = qp.get("format", "md")
            file_id = qp.get("file_id", None)

        try:
            if fmt == "md":
                if file_id:
                    path = exporter.export_markdown(batch_id, file_id)
                else:
                    path = exporter.export_batch_markdown(batch_id)
            elif fmt == "docx":
                if file_id:
                    path = exporter.export_word(batch_id, file_id)
                else:
                    path = exporter.export_batch_word(batch_id)
            elif fmt == "html":
                path = exporter.export_layout_html(batch_id, file_id)
            else:
                return jsonify({"error": f"Unknown format: {fmt}"})

            if path and Path(path).exists():
                return serve_file(path)
            return jsonify({"error": "Export failed"})
        except Exception as e:
            logger.exception("Export failed")
            return jsonify({"error": str(e)})

    @app.get("/api/page_richtext/:batch_id/:file_id/:page_id")
    def page_richtext(request: Request):
        """Word-friendly HTML + plain text for a page or a single block."""
        batch_id = request.path_params["batch_id"]
        file_id = request.path_params["file_id"]
        try:
            page_id = int(request.path_params["page_id"])
        except (TypeError, ValueError):
            return jsonify({"error": "无效的页码"})
        qp = request.query_params
        block = qp.get("block", None) if qp else None
        blocks_param = qp.get("blocks", None) if qp else None
        try:
            block_idx = int(block) if block not in (None, "") else None
        except ValueError:
            return jsonify({"error": "无效的块索引"})
        block_idxs = None
        if blocks_param not in (None, ""):
            try:
                block_idxs = [int(x) for x in blocks_param.split(",") if x.strip()]
            except ValueError:
                return jsonify({"error": "无效的块索引"})
            if not block_idxs:
                return jsonify({"error": "无效的块索引"})
        try:
            return jsonify(
                exporter.page_to_richtext(batch_id, file_id, page_id, block_idx, block_idxs)
            )
        except ValueError as e:
            return jsonify({"error": str(e)})
        except Exception:
            logger.exception("Page richtext failed")
            return jsonify({"error": "生成富文本失败"})
