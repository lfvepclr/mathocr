"""
Batch management module with SQLite metadata storage.

Manages the full lifecycle of document parsing batches:
  - Batch/file/page metadata in SQLite
  - Filesystem storage for original files, OCR results, annotated images
  - Background parallel OCR processing pipeline with SSE event publishing
  - Per-file and per-page processing time tracking
"""

import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

import image_annotator
import ocr_engine
import pdf_renderer
from event_bus import event_bus

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).parent.resolve()
BATCHES_DIR = PROJECT_ROOT / "batches"
DB_PATH = BATCHES_DIR / "metadata.db"

# ---------------------------------------------------------------------------
# SQLite connection (thread-safe via lock + check_same_thread=False)
# ---------------------------------------------------------------------------
_db_conn: sqlite3.Connection | None = None
_db_lock = threading.RLock()


def _get_db() -> sqlite3.Connection:
    global _db_conn
    if _db_conn is None:
        BATCHES_DIR.mkdir(parents=True, exist_ok=True)
        _db_conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _db_conn.row_factory = sqlite3.Row
        _init_db(_db_conn)
    return _db_conn


def _init_db(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS batches (
            batch_id        TEXT PRIMARY KEY,
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status          TEXT DEFAULT 'processing',
            file_count      INTEGER DEFAULT 0,
            alias           TEXT,
            completed_at    TIMESTAMP,
            processing_time REAL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS files (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id        TEXT NOT NULL,
            file_id         TEXT NOT NULL,
            original_name   TEXT NOT NULL,
            file_type       TEXT,
            file_size       INTEGER DEFAULT 0,
            page_count      INTEGER DEFAULT 0,
            total_pages     INTEGER DEFAULT 0,
            status          TEXT DEFAULT 'pending',
            error_message   TEXT,
            created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at    TIMESTAMP,
            processing_time REAL DEFAULT 0,
            UNIQUE(batch_id, file_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pages (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id              TEXT NOT NULL,
            file_id               TEXT NOT NULL,
            page_id               INTEGER NOT NULL,
            has_result            INTEGER DEFAULT 0,
            block_count           INTEGER DEFAULT 0,
            avg_score             REAL DEFAULT 0,
            markdown_path         TEXT,
            json_path             TEXT,
            original_image_path   TEXT,
            annotated_image_path  TEXT,
            images_dir            TEXT,
            processing_time       REAL DEFAULT 0,
            created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(batch_id, file_id, page_id)
        )
    """)
    conn.commit()


# ---------------------------------------------------------------------------
# Filesystem path helpers
# ---------------------------------------------------------------------------
def get_batch_dir(batch_id: str) -> Path:
    return BATCHES_DIR / batch_id


def get_uploads_dir(batch_id: str) -> Path:
    return get_batch_dir(batch_id) / "uploads"


def get_results_dir(batch_id: str) -> Path:
    return get_batch_dir(batch_id) / "results"


def get_file_results_dir(batch_id: str, file_id: str) -> Path:
    return get_results_dir(batch_id) / file_id


# ---------------------------------------------------------------------------
# File ID generation
# ---------------------------------------------------------------------------
def generate_file_id(original_name: str) -> str:
    stem = Path(original_name).stem
    safe = re.sub(r"[^a-zA-Z0-9_\u4e00-\u9fff]", "_", stem)[:60]
    suffix = uuid.uuid4().hex[:4]
    return f"{safe}_{suffix}"


def get_file_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        return "pdf"
    return "image"


# ---------------------------------------------------------------------------
# Batch CRUD
# ---------------------------------------------------------------------------
def create_batch(uploaded_files: list[tuple[str, bytes]]) -> str:
    batch_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    uploads_dir = get_uploads_dir(batch_id)
    uploads_dir.mkdir(parents=True, exist_ok=True)

    file_records = []
    for idx, (filename, content) in enumerate(uploaded_files):
        file_id = generate_file_id(filename)
        file_path = uploads_dir / filename
        file_path.write_bytes(content)
        file_records.append({
            "file_id": file_id,
            "original_name": filename,
            "file_type": get_file_type(filename),
            "file_size": len(content),
            "file_index": idx,
        })

    with _db_lock:
        db = _get_db()
        db.execute(
            "INSERT INTO batches (batch_id, status, file_count) VALUES (?, ?, ?)",
            [batch_id, "processing", len(file_records)],
        )
        for rec in file_records:
            db.execute(
                """INSERT INTO files (batch_id, file_id, original_name, file_type, file_size, status)
                   VALUES (?, ?, ?, ?, ?, 'pending')""",
                [batch_id, rec["file_id"], rec["original_name"],
                 rec["file_type"], rec["file_size"]],
            )
        db.commit()

    logger.info("Created batch %s with %d files", batch_id, len(file_records))
    return batch_id


def update_batch_status(batch_id: str, status: str, processing_time: float | None = None):
    with _db_lock:
        db = _get_db()
        if status in ("completed", "error") and processing_time is not None:
            db.execute(
                "UPDATE batches SET status = ?, completed_at = ?, processing_time = ? WHERE batch_id = ?",
                [status, datetime.now().isoformat(), processing_time, batch_id],
            )
        else:
            db.execute(
                "UPDATE batches SET status = ? WHERE batch_id = ?",
                [status, batch_id],
            )
        db.commit()


def update_batch_alias(batch_id: str, alias: str):
    with _db_lock:
        _get_db().execute(
            "UPDATE batches SET alias = ? WHERE batch_id = ?",
            [alias, batch_id],
        )
        _get_db().commit()


def get_batch(batch_id: str) -> dict | None:
    with _db_lock:
        row = _get_db().execute(
            """SELECT batch_id, created_at, status, file_count, alias,
                      completed_at, processing_time
               FROM batches WHERE batch_id = ?""",
            [batch_id],
        ).fetchone()
    if not row:
        return None
    return {
        "batch_id": row[0], "created_at": str(row[1]), "status": row[2],
        "file_count": row[3], "alias": row[4],
        "completed_at": str(row[5]) if row[5] else None,
        "processing_time": row[6],
    }


def list_batches(limit: int = 50, offset: int = 0,
                 status: str | None = None) -> list[dict]:
    with _db_lock:
        db = _get_db()
        if status:
            rows = db.execute(
                """SELECT batch_id, created_at, status, file_count, alias,
                          completed_at, processing_time
                   FROM batches WHERE status = ?
                   ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                [status, limit, offset],
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT batch_id, created_at, status, file_count, alias,
                          completed_at, processing_time
                   FROM batches ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                [limit, offset],
            ).fetchall()
    return [{
        "batch_id": r[0], "created_at": str(r[1]), "status": r[2],
        "file_count": r[3], "alias": r[4],
        "completed_at": str(r[5]) if r[5] else None,
        "processing_time": r[6],
    } for r in rows]


def delete_batch(batch_id: str):
    import shutil
    with _db_lock:
        db = _get_db()
        db.execute("DELETE FROM pages WHERE batch_id = ?", [batch_id])
        db.execute("DELETE FROM files WHERE batch_id = ?", [batch_id])
        db.execute("DELETE FROM batches WHERE batch_id = ?", [batch_id])
        db.commit()
    batch_dir = get_batch_dir(batch_id)
    if batch_dir.exists():
        shutil.rmtree(batch_dir, ignore_errors=True)
    logger.info("Deleted batch %s", batch_id)


# ---------------------------------------------------------------------------
# File CRUD
# ---------------------------------------------------------------------------
def get_files(batch_id: str) -> list[dict]:
    with _db_lock:
        rows = _get_db().execute(
            """SELECT file_id, original_name, file_type, file_size,
                      page_count, total_pages, status, error_message,
                      completed_at, processing_time
               FROM files WHERE batch_id = ?
               ORDER BY id""",
            [batch_id],
        ).fetchall()
    return [{
        "file_id": r[0], "original_name": r[1], "file_type": r[2],
        "file_size": r[3], "page_count": r[4], "total_pages": r[5],
        "status": r[6], "error_message": r[7],
        "completed_at": str(r[8]) if r[8] else None,
        "processing_time": r[9],
    } for r in rows]


def get_file_index(batch_id: str, file_id: str) -> int:
    """Get the 0-based index of a file within its batch."""
    files = get_files(batch_id)
    for i, f in enumerate(files):
        if f["file_id"] == file_id:
            return i
    return 0


def update_file_status(batch_id: str, file_id: str, status: str,
                       page_count: int | None = None,
                       total_pages: int | None = None,
                       error_message: str | None = None,
                       processing_time: float | None = None):
    with _db_lock:
        db = _get_db()
        sets = ["status = ?"]
        params = [status]
        if page_count is not None:
            sets.append("page_count = ?")
            params.append(page_count)
        if total_pages is not None:
            sets.append("total_pages = ?")
            params.append(total_pages)
        if error_message is not None:
            sets.append("error_message = ?")
            params.append(error_message)
        if processing_time is not None:
            sets.append("processing_time = ?")
            params.append(processing_time)
        if status in ("completed", "error"):
            sets.append("completed_at = ?")
            params.append(datetime.now().isoformat())
        params.extend([batch_id, file_id])
        db.execute(
            f"UPDATE files SET {', '.join(sets)} WHERE batch_id = ? AND file_id = ?",
            params,
        )
        db.commit()


def get_avg_page_time(default: float = 60.0) -> float:
    """Average per-page OCR time over historical pages (seconds)."""
    with _db_lock:
        row = _get_db().execute(
            "SELECT AVG(processing_time) FROM pages WHERE processing_time > 0"
        ).fetchone()
    if row and row[0]:
        return float(row[0])
    return default


# ---------------------------------------------------------------------------
# Queue support (SQLite-backed job queue)
# ---------------------------------------------------------------------------
def fetch_next_queued_batch() -> str | None:
    """Return the oldest queued batch_id, or None if the queue is empty."""
    with _db_lock:
        row = _get_db().execute(
            "SELECT batch_id FROM batches WHERE status = 'queued' "
            "ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    return row[0] if row else None


def reset_interrupted_tasks() -> int:
    """
    Re-queue batches/files left in 'processing' state by a server shutdown.
    Returns the number of recovered batches.
    """
    with _db_lock:
        db = _get_db()
        cur = db.execute(
            "UPDATE batches SET status = 'queued' WHERE status = 'processing'"
        )
        recovered = cur.rowcount
        db.execute(
            "UPDATE files SET status = 'pending' WHERE status = 'processing'"
        )
        db.commit()
    if recovered:
        logger.info("Recovered %d interrupted batch(es), re-queued", recovered)
    return recovered


def get_queue_status_map(limit: int = 50) -> dict[str, str]:
    """Return {batch_id: status} for recent batches (queue status API)."""
    with _db_lock:
        rows = _get_db().execute(
            "SELECT batch_id, status FROM batches "
            "ORDER BY created_at DESC LIMIT ?",
            [limit],
        ).fetchall()
    return {r[0]: r[1] for r in rows}


def count_queued_batches() -> int:
    """Number of batches waiting in the queue."""
    with _db_lock:
        row = _get_db().execute(
            "SELECT COUNT(*) FROM batches WHERE status = 'queued'"
        ).fetchone()
    return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Page CRUD
# ---------------------------------------------------------------------------
def insert_page(batch_id: str, file_id: str, page_id: int, data: dict):
    with _db_lock:
        _get_db().execute(
            """INSERT OR REPLACE INTO pages
               (batch_id, file_id, page_id, has_result, block_count, avg_score,
                markdown_path, json_path, original_image_path,
                annotated_image_path, images_dir, processing_time)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [batch_id, file_id, page_id, data.get("has_result", True),
             data.get("block_count", 0), data.get("avg_score", 0),
             data.get("markdown_path"), data.get("json_path"),
             data.get("original_image_path"), data.get("annotated_image_path"),
             data.get("images_dir"), data.get("processing_time", 0)],
        )
        _get_db().commit()


def get_pages(batch_id: str, file_id: str) -> list[dict]:
    with _db_lock:
        rows = _get_db().execute(
            """SELECT page_id, has_result, block_count, avg_score,
                      markdown_path, json_path, original_image_path,
                      annotated_image_path, images_dir, processing_time
               FROM pages WHERE batch_id = ? AND file_id = ?
               ORDER BY page_id""",
            [batch_id, file_id],
        ).fetchall()
    return [{
        "page_id": r[0], "has_result": bool(r[1]), "block_count": r[2],
        "avg_score": r[3], "markdown_path": r[4], "json_path": r[5],
        "original_image_path": r[6], "annotated_image_path": r[7],
        "images_dir": r[8], "processing_time": r[9],
    } for r in rows]


def get_page(batch_id: str, file_id: str, page_id: int) -> dict | None:
    with _db_lock:
        row = _get_db().execute(
            """SELECT page_id, has_result, block_count, avg_score,
                      markdown_path, json_path, original_image_path,
                      annotated_image_path, images_dir, processing_time
               FROM pages WHERE batch_id = ? AND file_id = ? AND page_id = ?""",
            [batch_id, file_id, page_id],
        ).fetchone()
    if not row:
        return None
    return {
        "page_id": row[0], "has_result": bool(row[1]),
        "block_count": row[2], "avg_score": row[3],
        "markdown_path": row[4], "json_path": row[5],
        "original_image_path": row[6], "annotated_image_path": row[7],
        "images_dir": row[8], "processing_time": row[9],
    }


# ---------------------------------------------------------------------------
# Background batch processing
# ---------------------------------------------------------------------------
def process_batch_background(batch_id: str):
    batch_start = time.time()
    try:
        files = get_files(batch_id)
        if not files:
            update_batch_status(batch_id, "completed", processing_time=0)
            event_bus.publish(batch_id, "batch_completed",
                              {"status": "completed", "processing_time": 0})
            return

        # Skip files already completed (e.g. recovered interrupted batch)
        pending_files = [f for f in files if f["status"] != "completed"]
        if not pending_files:
            logger.info("Batch %s: all files already completed", batch_id)
            update_batch_status(batch_id, "completed", processing_time=0)
            event_bus.publish(batch_id, "batch_completed",
                              {"status": "completed", "processing_time": 0})
            return

        max_workers = min(len(pending_files), 4)
        logger.info("Processing batch %s with %d workers (%d/%d files pending)",
                    batch_id, max_workers, len(pending_files), len(files))

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(_process_single_file, batch_id, f): f
                for f in pending_files
            }
            for future in as_completed(futures):
                file_info = futures[future]
                try:
                    future.result()
                except Exception:
                    logger.exception("File processing failed: %s", file_info["file_id"])
                    update_file_status(batch_id, file_info["file_id"], "error",
                                       error_message="Processing exception")

        # Determine final batch status
        file_statuses = [f["status"] for f in get_files(batch_id)]
        if all(s == "completed" for s in file_statuses):
            final_status = "completed"
        elif all(s == "error" for s in file_statuses):
            final_status = "error"
        else:
            final_status = "completed"

        batch_time = time.time() - batch_start
        update_batch_status(batch_id, final_status, processing_time=round(batch_time, 2))
        event_bus.publish(batch_id, "batch_completed", {
            "status": final_status,
            "processing_time": round(batch_time, 2),
        })
        logger.info("Batch %s finished in %.1fs", batch_id, batch_time)

    except Exception:
        logger.exception("Batch processing failed: %s", batch_id)
        batch_time = time.time() - batch_start
        update_batch_status(batch_id, "error", processing_time=round(batch_time, 2))
        event_bus.publish(batch_id, "batch_completed", {
            "status": "error",
            "processing_time": round(batch_time, 2),
        })


def _process_single_file(batch_id: str, file_info: dict):
    file_start = time.time()
    file_id = file_info["file_id"]
    original_name = file_info["original_name"]

    update_file_status(batch_id, file_id, "processing")
    event_bus.publish(batch_id, "file_started", {"file_id": file_id, "original_name": original_name})

    file_path = get_uploads_dir(batch_id) / original_name
    file_results_dir = get_file_results_dir(batch_id, file_id)
    file_results_dir.mkdir(parents=True, exist_ok=True)

    # --- Resume guard: pages already persisted by a previous (interrupted) run ---
    prev_total = file_info.get("total_pages") or 0
    if prev_total > 0:
        existing_pages = get_pages(batch_id, file_id)
        done_pages = [p for p in existing_pages if p["has_result"]]
        if len(done_pages) >= prev_total and all(
            p["markdown_path"] and Path(p["markdown_path"]).exists()
            for p in done_pages
        ):
            logger.info("File %s already fully processed (%d pages), skipping",
                        original_name, prev_total)
            update_file_status(batch_id, file_id, "completed", page_count=prev_total)
            event_bus.publish(batch_id, "file_completed", {
                "file_id": file_id,
                "original_name": original_name,
                "status": "completed",
                "page_count": prev_total,
                "processing_time": file_info.get("processing_time") or 0,
            })
            return

    # Step 1: Prepare original page images
    original_images = pdf_renderer.prepare_original_images(file_path, file_results_dir)
    total_pages = len(original_images)
    update_file_status(batch_id, file_id, "processing", total_pages=total_pages)

    # Step 2+3: Stream OCR — persist each page as soon as it is ready,
    # publishing per-page progress events along the way.
    avg_page_time = get_avg_page_time()
    event_bus.publish(batch_id, "page_started", {
        "file_id": file_id, "page_id": 0,
        "total_pages": total_pages, "avg_page_time": round(avg_page_time, 1),
    })

    completed_pages = 0
    # Inference happens lazily inside the generator's next(); measure it here
    # so per-page timing reflects inference + persistence, not just persistence.
    infer_start = time.time()
    for page_idx, page_result in ocr_engine.process_document_iter(str(file_path)):
        infer_time = time.time() - infer_start
        _process_single_page(batch_id, file_id, page_idx, page_result,
                             original_images, file_results_dir,
                             total_pages, completed_pages,
                             infer_time=infer_time)
        completed_pages += 1
        infer_start = time.time()
        # Announce that the next page is now being inferred
        if page_idx + 1 < total_pages:
            event_bus.publish(batch_id, "page_started", {
                "file_id": file_id, "page_id": page_idx + 1,
                "total_pages": total_pages, "avg_page_time": round(avg_page_time, 1),
            })

    if completed_pages != total_pages:
        logger.warning(
            "Page count mismatch: OCR returned %d, rendered %d for %s",
            completed_pages, total_pages, original_name,
        )

    file_time = time.time() - file_start
    update_file_status(batch_id, file_id, "completed",
                       page_count=completed_pages, processing_time=round(file_time, 2))
    event_bus.publish(batch_id, "file_completed", {
        "file_id": file_id,
        "original_name": original_name,
        "status": "completed",
        "page_count": completed_pages,
        "processing_time": round(file_time, 2),
    })
    logger.info("File %s processed: %d pages in %.1fs", original_name, completed_pages, file_time)


def _process_single_page(
    batch_id: str,
    file_id: str,
    page_idx: int,
    page_result: dict,
    original_images: list[str],
    file_results_dir: Path,
    total_pages: int = 0,
    prior_completed: int = 0,
    infer_time: float = 0.0,
):
    page_start = time.time()
    page_id = page_idx
    images_dir = file_results_dir / f"page_{page_id}_images"
    images_dir.mkdir(exist_ok=True)

    # --- Save JSON ---
    json_path = file_results_dir / f"page_{page_id}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(page_result["json_data"], f, ensure_ascii=False, indent=2)

    # --- Save markdown (replace image src with API paths) ---
    markdown_text = page_result["markdown_text"]
    images = page_result.get("images", {})
    for img_name, pil_img in images.items():
        safe_name = Path(img_name).name
        img_path = images_dir / safe_name
        pil_img.save(str(img_path))
        api_url = f"/api/page_image/{batch_id}/{file_id}/{page_id}/{safe_name}"
        markdown_text = markdown_text.replace(f'src="{img_name}"', f'src="{api_url}"')
        basename = Path(img_name).name
        if basename != img_name:
            markdown_text = markdown_text.replace(
                f'src="{basename}"', f'src="{api_url}"'
            )

    md_path = file_results_dir / f"page_{page_id}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(markdown_text)

    # --- Generate annotated image ---
    annotated_path = file_results_dir / f"page_{page_id}_annotated.png"
    original_img = (
        original_images[page_idx]
        if page_idx < len(original_images)
        else original_images[0]
    )
    try:
        image_annotator.annotate_image(
            original_img, page_result["page_data"], annotated_path
        )
    except Exception:
        logger.exception("Annotation failed for page %d", page_id)
        import shutil
        shutil.copy2(original_img, annotated_path)

    # --- Calculate stats ---
    boxes = page_result["page_data"].get("boxes", [])
    block_count = len(boxes)
    scores = [b.get("score", 0) for b in boxes if "score" in b]
    avg_score = sum(scores) / len(scores) if scores else 0
    page_time = infer_time + (time.time() - page_start)

    # --- Insert page record ---
    insert_page(batch_id, file_id, page_id, {
        "has_result": True,
        "block_count": block_count,
        "avg_score": round(avg_score, 4),
        "markdown_path": str(md_path),
        "json_path": str(json_path),
        "original_image_path": str(original_img),
        "annotated_image_path": str(annotated_path),
        "images_dir": str(images_dir),
        "processing_time": round(page_time, 2),
    })

    # --- Publish SSE event ---
    event_bus.publish(batch_id, "page_completed", {
        "file_id": file_id,
        "page_id": page_id,
        "block_count": block_count,
        "avg_score": round(avg_score, 4),
        "processing_time": round(page_time, 2),
        "total_pages": total_pages,
        "completed_pages": prior_completed + 1,
    })


# ---------------------------------------------------------------------------
# Batch summary for API
# ---------------------------------------------------------------------------
def get_batch_summary(batch_id: str) -> dict | None:
    batch = get_batch(batch_id)
    if not batch:
        return None

    files = get_files(batch_id)
    file_summaries = []
    for f in files:
        pages = get_pages(batch_id, f["file_id"])
        file_summaries.append({
            "file_id": f["file_id"],
            "original_name": f["original_name"],
            "file_type": f["file_type"],
            "file_size": f["file_size"],
            "page_count": f["page_count"],
            "total_pages": f["total_pages"],
            "status": f["status"],
            "error_message": f["error_message"],
            "completed_at": f["completed_at"],
            "processing_time": f["processing_time"],
            "pages": [
                {
                    "page_id": p["page_id"],
                    "has_result": p["has_result"],
                    "block_count": p["block_count"],
                    "avg_score": p["avg_score"],
                    "processing_time": p["processing_time"],
                }
                for p in pages
            ],
        })

    return {**batch, "files": file_summaries}
