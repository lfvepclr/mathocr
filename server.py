"""
PaddleOCR-VL Document Parsing Server
=====================================
Robyn (Rust-runtime Python web framework) server providing:
  - Multi-file upload with batch management
  - Parallel OCR processing (background threads)
  - Original vs annotated image comparison
  - Markdown / Word export
  - Historical batch browsing via SQLite
  - SSE real-time progress updates
  - In-memory job queue for sequential batch processing

Usage:
    uv run python server.py
    uv run python server.py --port 8080 --open-browser
"""

import json
import logging
import mimetypes
import os
import queue
import sys
import threading
import time
import webbrowser
from pathlib import Path

from robyn import Headers, Request, Response, Robyn, StreamingResponse, jsonify, serve_file, serve_html

import batch_manager
import exporter
from job_queue import job_queue
from event_bus import event_bus
from image_annotator import generate_legend

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("server")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).parent.resolve()
STATIC_DIR = PROJECT_ROOT / "static"
INDEX_HTML = STATIC_DIR / "index.html"

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = Robyn(__file__)


# ===========================================================================
# Static file serving
# ===========================================================================
@app.get("/")
def index(_request: Request):
    """Serve the main HTML page."""
    return serve_html(str(INDEX_HTML))


@app.get("/static/*file_path")
def serve_static(request: Request):
    """Serve static files (CSS, JS, images, fonts)."""
    file_path = request.path_params.get("file_path", "")
    full_path = STATIC_DIR / file_path

    # Prevent path traversal
    try:
        full_path = full_path.resolve()
        full_path.relative_to(STATIC_DIR)
    except ValueError:
        return Response(403, Headers({}), "Forbidden")

    if not full_path.exists() or not full_path.is_file():
        return Response(404, Headers({}), "Not Found")

    # Set content type based on extension
    content_type, _ = mimetypes.guess_type(str(full_path))
    headers = Headers({"Content-Type": content_type or "application/octet-stream"})
    with open(full_path, "rb") as f:
        data = f.read()
    return Response(200, headers, data)


# ===========================================================================
# API: Upload
# ===========================================================================
@app.post("/api/upload")
async def upload(request: Request):
    """Receive multi-file upload, create batch, start background OCR."""
    files = request.files
    if not files:
        return jsonify({"error": "No files uploaded"})

    uploaded_files = [(name, content) for name, content in files.items()]
    logger.info("Upload received: %d files", len(uploaded_files))

    # Create batch and save files
    batch_id = batch_manager.create_batch(uploaded_files)

    # Enqueue for processing (single worker, sequential)
    job_queue.enqueue(batch_id)

    return jsonify({"batch_id": batch_id, "status": "queued", "file_count": len(uploaded_files)})


# ===========================================================================
# API: Batch listing & details
# ===========================================================================
@app.get("/api/batches")
def list_batches(request: Request):
    """List all historical batches, optional status filter."""
    qp = request.query_params
    status = qp.get("status", None) if qp else None
    limit = int(qp.get("limit", "50")) if qp else 50
    batches = batch_manager.list_batches(limit=limit, status=status)
    return jsonify(batches)


@app.get("/api/batch/:batch_id")
def get_batch(request: Request):
    """Get batch details with files and page summaries."""
    batch_id = request.path_params["batch_id"]
    summary = batch_manager.get_batch_summary(batch_id)
    if not summary:
        return jsonify({"error": "Batch not found"})
    return jsonify(summary)


@app.delete("/api/batch/:batch_id")
def delete_batch(request: Request):
    """Delete a batch and all its files."""
    batch_id = request.path_params["batch_id"]
    batch_manager.delete_batch(batch_id)
    return jsonify({"deleted": batch_id})


# ===========================================================================
# API: File & Page data
# ===========================================================================
@app.get("/api/batch/:batch_id/file/:file_id")
def get_file(request: Request):
    """Get file details with all page summaries."""
    batch_id = request.path_params["batch_id"]
    file_id = request.path_params["file_id"]
    files = batch_manager.get_files(batch_id)
    file_info = next((f for f in files if f["file_id"] == file_id), None)
    if not file_info:
        return jsonify({"error": "File not found"})

    pages = batch_manager.get_pages(batch_id, file_id)
    return jsonify({
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
    })


@app.get("/api/batch/:batch_id/file/:file_id/page/:page_id")
def get_page(request: Request):
    """Get page markdown content and metadata."""
    batch_id = request.path_params["batch_id"]
    file_id = request.path_params["file_id"]
    page_id = int(request.path_params["page_id"])

    page = batch_manager.get_page(batch_id, file_id, page_id)
    if not page:
        return jsonify({"error": "Page not found"})

    # Read markdown content
    md_content = ""
    if page["markdown_path"]:
        md_path = Path(page["markdown_path"])
        if md_path.exists():
            md_content = md_path.read_text(encoding="utf-8")

    # Read JSON content
    json_data = None
    if page["json_path"]:
        json_path = Path(page["json_path"])
        if json_path.exists():
            json_data = json.loads(json_path.read_text(encoding="utf-8"))

    return jsonify({
        "page_id": page["page_id"],
        "has_result": page["has_result"],
        "block_count": page["block_count"],
        "avg_score": page["avg_score"],
        "markdown": md_content,
        "json": json_data,
        "original_image_url": f"/api/image/{batch_id}/{file_id}/{page_id}?type=original",
        "annotated_image_url": f"/api/image/{batch_id}/{file_id}/{page_id}?type=annotated",
    })


# ===========================================================================
# API: Image serving
# ===========================================================================
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
    if img_path.exists() and img_path.is_file():
        content_type, _ = mimetypes.guess_type(str(img_path))
        headers = Headers({"Content-Type": content_type or "image/jpeg"})
        with open(img_path, "rb") as f:
            data = f.read()
        return Response(200, headers, data)
    return Response(404, Headers({}), "Image not found")


# ===========================================================================
# API: Export
# ===========================================================================
@app.get("/api/export/:batch_id")
def export(request: Request):
    """Export batch or file as Markdown or Word."""
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
            if not file_id:
                return jsonify({"error": "file_id required for docx export"})
            path = exporter.export_word(batch_id, file_id)
        else:
            return jsonify({"error": f"Unknown format: {fmt}"})

        if path and Path(path).exists():
            return serve_file(path)
        return jsonify({"error": "Export failed"})
    except Exception as e:
        logger.exception("Export failed")
        return jsonify({"error": str(e)})


# ===========================================================================
# API: Legend
# ===========================================================================
@app.get("/api/legend")
def get_legend(_request: Request):
    """Return confidence color legend data."""
    return jsonify(generate_legend())


# ===========================================================================
# API: SSE real-time events
# ===========================================================================
@app.get("/api/events")
def global_events(request: Request):
    """Global SSE stream: events from ALL batches.

    Drives the sidebar batch progress and the home-page queue panel with a
    single connection, independent of which batch (if any) is being viewed.
    """
    q = event_bus.subscribe("*")

    def event_stream():
        start_time = time.time()
        while True:
            # Max 10 min per connection; EventSource auto-reconnects
            if time.time() - start_time > 600:
                yield f"event: timeout\ndata: {{}}\n\n"
                break
            try:
                event = q.get(timeout=15)
                event_type = event.get("type", "message")
                event_data = json.dumps(event.get("data", {}), ensure_ascii=False)
                yield f"event: {event_type}\ndata: {event_data}\n\n"
            except queue.Empty:
                # Keepalive ping
                yield f"event: ping\ndata: {{}}\n\n"
        event_bus.unsubscribe("*", q)

    return StreamingResponse(
        event_stream(),
        headers=Headers({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }),
    )


@app.get("/api/events/:batch_id")
def batch_events(request: Request):
    """SSE stream for real-time batch processing updates."""
    batch_id = request.path_params["batch_id"]
    q = event_bus.subscribe(batch_id)

    def event_stream():
        start_time = time.time()
        while True:
            # Check if batch is completed (max 10 min connection)
            if time.time() - start_time > 600:
                yield f"event: timeout\ndata: {{}}\n\n"
                break
            try:
                event = q.get(timeout=15)
                event_type = event.get("type", "message")
                event_data = json.dumps(event.get("data", {}), ensure_ascii=False)
                yield f"event: {event_type}\ndata: {event_data}\n\n"
                # Close stream when batch is done
                if event_type in ("batch_completed",):
                    break
            except queue.Empty:
                # Keepalive ping
                yield f"event: ping\ndata: {{}}\n\n"
        event_bus.unsubscribe(batch_id, q)

    return StreamingResponse(
        event_stream(),
        headers=Headers({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }),
    )


# ===========================================================================
# API: Batch alias
# ===========================================================================
@app.post("/api/batch/:batch_id/alias")
def set_batch_alias(request: Request):
    """Set a custom alias for a batch."""
    batch_id = request.path_params["batch_id"]
    try:
        data = request.json()
        alias = data.get("alias", "")
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid JSON"})
    batch_manager.update_batch_alias(batch_id, alias)
    return jsonify({"batch_id": batch_id, "alias": alias})


# ===========================================================================
# API: Queue status
# ===========================================================================
@app.get("/api/queue/status")
def queue_status(_request: Request):
    """Return current job queue status."""
    return jsonify({
        "queue_size": job_queue.get_queue_size(),
        "statuses": job_queue.get_all_status(),
    })


# ===========================================================================
# Main entry
# ===========================================================================
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="PaddleOCR-VL Document Parsing Server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--port", type=int, default=7860, help="Port number")
    parser.add_argument("--open-browser", action="store_true", help="Open browser on start")
    args = parser.parse_args()

    # Ensure batches directory exists
    batch_manager.BATCHES_DIR.mkdir(parents=True, exist_ok=True)

    # Recover batches interrupted by a previous shutdown, then start worker
    recovered = job_queue.recover_interrupted()
    if recovered:
        logger.info("Recovered %d interrupted batch(es) — processing resumed", recovered)
    job_queue.start()
    logger.info("Job queue worker started")

    # Open browser after a short delay
    if args.open_browser:
        url = f"http://localhost:{args.port}"
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    logger.info("Starting server on %s:%d", args.host, args.port)
    app.start(host=args.host, port=args.port)
