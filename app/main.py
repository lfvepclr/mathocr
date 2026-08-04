"""
MathOCR application factory and CLI entry point.

Creates the Robyn app, registers static-serving and API routes, then
starts the background job-queue worker and the HTTP server.
"""

import argparse
import logging
import mimetypes
import threading
import webbrowser

from robyn import Headers, Request, Response, Robyn

from app.api import batches, events, media, upload
from app.api import export as export_api
from app.api import settings as settings_api
from app.config import BATCHES_DIR, INDEX_HTML, STATIC_DIR
from app.core.job_queue import job_queue

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("server")


def create_app() -> Robyn:
    """Create and configure the Robyn application."""
    app = Robyn(__file__)

    # ---- Static file serving -------------------------------------------
    @app.get("/")
    def index(_request: Request):
        # Cache-Control: no-cache — index.html must always be revalidated so a
        # stale copy (old asset URLs) never leaves the page blank/styless.
        # Hashed bundles under /static/assets are unaffected.
        headers = Headers({"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"})
        with open(INDEX_HTML, "rb") as f:
            return Response(200, headers, f.read())

    @app.get("/static/*file_path")
    def serve_static(request: Request):
        file_path = request.path_params.get("file_path", "")
        full_path = STATIC_DIR / file_path
        try:
            full_path = full_path.resolve()
            full_path.relative_to(STATIC_DIR)
        except ValueError:
            return Response(403, Headers({}), "Forbidden")
        if not full_path.exists() or not full_path.is_file():
            return Response(404, Headers({}), "Not Found")
        content_type, _ = mimetypes.guess_type(str(full_path))
        headers = Headers({"Content-Type": content_type or "application/octet-stream"})
        with open(full_path, "rb") as f:
            data = f.read()
        return Response(200, headers, data)

    # ---- API routes (delegated to sub-modules) -------------------------
    upload.register(app)
    batches.register(app)
    media.register(app)
    export_api.register(app)
    settings_api.register(app)
    events.register(app)

    return app


def main():
    parser = argparse.ArgumentParser(description="PaddleOCR-VL Document Parsing Server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--port", type=int, default=7860, help="Port number")
    parser.add_argument("--open-browser", action="store_true", help="Open browser on start")
    args = parser.parse_args()

    BATCHES_DIR.mkdir(parents=True, exist_ok=True)

    recovered = job_queue.recover_interrupted()
    if recovered:
        logger.info("Recovered %d interrupted batch(es) — processing resumed", recovered)

    job_queue.start()
    queue_size = job_queue.get_queue_size()
    if queue_size > 0:
        logger.info("Job queue worker started — %d batch(es) queued, processing begins", queue_size)
    else:
        logger.info("Job queue worker started — queue is empty, waiting for uploads")

    if args.open_browser:
        url = f"http://localhost:{args.port}"
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    logger.info("Starting server on %s:%d", args.host, args.port)
    app = create_app()
    app.start(host=args.host, port=args.port)
