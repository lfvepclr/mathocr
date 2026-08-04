"""Image serving APIs: page images and extracted images."""

import logging
import mimetypes
from pathlib import Path

from robyn import Headers, Request, Response

from app.services import batch_manager

logger = logging.getLogger(__name__)


def register(app):
    @app.get("/api/image/:batch_id/:file_id/:page_id")
    def serve_page_image(request: Request):
        """Serve original or annotated page image."""
        batch_id = request.path_params["batch_id"]
        file_id = request.path_params["file_id"]
        page_id = int(request.path_params["page_id"])

        img_type = "annotated"
        qp = request.query_params
        if qp:
            img_type = qp.get("type", "annotated")

        page = batch_manager.get_page(batch_id, file_id, page_id)
        if not page:
            return Response(404, Headers({}), "Page not found")

        if img_type == "original":
            path = page["original_image_path"]
        else:
            path = page["annotated_image_path"]

        if path and Path(path).exists():
            headers = Headers({"Content-Type": "image/png"})
            with open(path, "rb") as f:
                data = f.read()
            return Response(200, headers, data)
        return Response(404, Headers({}), "Image not found")

    @app.get("/api/page_image/:batch_id/:file_id/:page_id/*img_name")
    def serve_extracted_image(request: Request):
        """Serve images extracted from documents during OCR."""
        batch_id = request.path_params["batch_id"]
        file_id = request.path_params["file_id"]
        page_id = int(request.path_params["page_id"])
        img_name = request.path_params.get("img_name", "")

        page = batch_manager.get_page(batch_id, file_id, page_id)
        if not page or not page["images_dir"]:
            return Response(404, Headers({}), "Image not found")

        img_path = Path(page["images_dir"]) / img_name
        if not img_path.is_file():
            # Old local-engine batches reference table images as "imgs/x.jpg"
            # while files are stored flat — retry with the bare file name.
            img_path = Path(page["images_dir"]) / Path(img_name).name
        if img_path.exists() and img_path.is_file():
            content_type, _ = mimetypes.guess_type(str(img_path))
            headers = Headers({"Content-Type": content_type or "image/jpeg"})
            with open(img_path, "rb") as f:
                data = f.read()
            return Response(200, headers, data)
        return Response(404, Headers({}), "Image not found")
