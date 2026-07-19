"""
SQLite-backed persistent job queue for OCR batch processing.

Queue state lives in the batches table (status column), so it survives
server restarts: batches in 'queued' status are picked up by the single
worker thread in FIFO order, and batches interrupted mid-processing are
re-queued at startup via recover_interrupted().

A threading.Event wakes the worker immediately on enqueue, avoiding
poll latency while keeping the idle loop cheap.
"""

import logging
import threading

logger = logging.getLogger(__name__)


class JobQueue:
    """Persistent FIFO job queue backed by SQLite batch status."""

    def __init__(self):
        self._wake_event = threading.Event()
        self._worker: threading.Thread | None = None
        self._started = False

    def start(self):
        """Start the background worker thread."""
        if self._started:
            return
        self._started = True
        self._worker = threading.Thread(
            target=self._run_worker, daemon=True, name="ocr-worker"
        )
        self._worker.start()
        logger.info("Job queue worker started (SQLite-backed)")

    def recover_interrupted(self) -> int:
        """
        Re-queue batches left in 'processing' state by a previous shutdown.
        Called once at server startup, before start().
        Returns the number of recovered batches.
        """
        import batch_manager

        recovered = batch_manager.reset_interrupted_tasks()
        if recovered:
            self._wake_event.set()
        return recovered

    def enqueue(self, batch_id: str):
        """Add a batch to the processing queue (persists in SQLite)."""
        import batch_manager
        from event_bus import event_bus

        batch_manager.update_batch_status(batch_id, "queued")
        # Notify global listeners (sidebar / queue panel) immediately
        event_bus.publish(batch_id, "batch_queued", {})
        self._wake_event.set()
        logger.info(
            "Batch %s enqueued (queue size: %d)",
            batch_id,
            batch_manager.count_queued_batches(),
        )

    def get_status(self, batch_id: str) -> str:
        """Get the queue status of a batch."""
        import batch_manager

        batch = batch_manager.get_batch(batch_id)
        return batch["status"] if batch else "unknown"

    def get_all_status(self) -> dict[str, str]:
        """Get status of recent batches."""
        import batch_manager

        return batch_manager.get_queue_status_map()

    def get_queue_size(self) -> int:
        """Get the number of queued (not yet processing) batches."""
        import batch_manager

        return batch_manager.count_queued_batches()

    def _run_worker(self):
        """Worker loop: dequeue and process batches in FIFO order."""
        import batch_manager

        while True:
            batch_id = batch_manager.fetch_next_queued_batch()
            if batch_id is None:
                # Nothing to do — wait for a wake-up signal
                self._wake_event.wait(timeout=2.0)
                self._wake_event.clear()
                continue
            try:
                batch_manager.update_batch_status(batch_id, "processing")
                logger.info("Worker processing batch %s", batch_id)
                batch_manager.process_batch_background(batch_id)
            except Exception:
                logger.exception("Worker error processing batch %s", batch_id)
                try:
                    batch_manager.update_batch_status(batch_id, "error")
                except Exception:
                    logger.exception("Failed to mark batch %s as error", batch_id)


# Global singleton
job_queue = JobQueue()
