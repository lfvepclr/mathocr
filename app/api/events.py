"""SSE (Server-Sent Events) APIs for real-time progress."""

import json
import logging
import queue
import time

from robyn import Headers, Request, StreamingResponse

from app.core.event_bus import event_bus

logger = logging.getLogger(__name__)


def register(app):
    @app.get("/api/events")
    def global_events(request: Request):
        """Global SSE stream: events from ALL batches."""
        q = event_bus.subscribe("*")

        def event_stream():
            start_time = time.time()
            while True:
                if time.time() - start_time > 600:
                    yield "event: timeout\ndata: {}\n\n"
                    break
                try:
                    event = q.get(timeout=15)
                    event_type = event.get("type", "message")
                    event_data = json.dumps(event.get("data", {}), ensure_ascii=False)
                    yield f"event: {event_type}\ndata: {event_data}\n\n"
                except queue.Empty:
                    yield "event: ping\ndata: {}\n\n"
            event_bus.unsubscribe("*", q)

        return StreamingResponse(
            event_stream(),
            headers=Headers(
                {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            ),
        )

    @app.get("/api/events/:batch_id")
    def batch_events(request: Request):
        """SSE stream for real-time batch processing updates."""
        batch_id = request.path_params["batch_id"]
        q = event_bus.subscribe(batch_id)

        def event_stream():
            start_time = time.time()
            while True:
                if time.time() - start_time > 600:
                    yield "event: timeout\ndata: {}\n\n"
                    break
                try:
                    event = q.get(timeout=15)
                    event_type = event.get("type", "message")
                    event_data = json.dumps(event.get("data", {}), ensure_ascii=False)
                    yield f"event: {event_type}\ndata: {event_data}\n\n"
                    if event_type in ("batch_completed",):
                        break
                except queue.Empty:
                    yield "event: ping\ndata: {}\n\n"
            event_bus.unsubscribe(batch_id, q)

        return StreamingResponse(
            event_stream(),
            headers=Headers(
                {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            ),
        )
