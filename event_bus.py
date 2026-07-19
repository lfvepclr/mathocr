"""
Lightweight in-process event bus for SSE (Server-Sent Events).

Subscribers register for a specific batch_id and receive events
via a queue. Publishers push events from background threads.
"""

import asyncio
import json
import logging
import queue
import threading
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


class EventBus:
    """Process-wide event bus keyed by batch_id."""

    def __init__(self):
        self._subscribers: dict[str, list[queue.Queue]] = {}
        self._lock = threading.Lock()

    def subscribe(self, batch_id: str) -> queue.Queue:
        """Subscribe to events for a batch. Returns a Queue to read events from."""
        q: queue.Queue = queue.Queue()
        with self._lock:
            if batch_id not in self._subscribers:
                self._subscribers[batch_id] = []
            self._subscribers[batch_id].append(q)
        logger.debug("Subscriber added for batch %s (total: %d)", batch_id,
                      len(self._subscribers.get(batch_id, [])))
        return q

    def unsubscribe(self, batch_id: str, q: queue.Queue):
        """Remove a subscriber."""
        with self._lock:
            if batch_id in self._subscribers:
                try:
                    self._subscribers[batch_id].remove(q)
                except ValueError:
                    pass
                if not self._subscribers[batch_id]:
                    del self._subscribers[batch_id]

    def publish(self, batch_id: str, event_type: str, data: dict[str, Any]):
        """Push an event to subscribers of a batch AND to global ('*') subscribers.

        batch_id is injected into the payload so global-channel consumers can
        attribute events to their batch (the SSE layer only forwards `data`).
        """
        event = {
            "type": event_type,
            "data": {**data, "batch_id": batch_id},
            "timestamp": datetime.now().isoformat(),
        }
        with self._lock:
            subs = list(self._subscribers.get(batch_id, []))
            if batch_id != "*":
                subs += list(self._subscribers.get("*", []))
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                logger.warning("Event queue full for batch %s, dropping event", batch_id)
        logger.debug("Published %s to %d subscribers for batch %s",
                      event_type, len(subs), batch_id)


# Global singleton
event_bus = EventBus()
