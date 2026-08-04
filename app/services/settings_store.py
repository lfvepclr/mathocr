"""
Settings and API usage storage (SQLite).

Owns two tables in the same `batches/metadata.db` file as batch_manager,
but with its own connection + RLock. This keeps the module free of any
import cycle with batch_manager (which imports ocr_engine, which in turn
resolves engine configuration through engine_registry -> settings_store).

  settings   key/value store for engine configuration (API keys, prices)
  api_usage  one row per remote API accounting event, for cost reporting
"""

import logging
import sqlite3
import threading
from datetime import datetime

logger = logging.getLogger(__name__)

from app.config import BATCHES_DIR, DB_PATH

_conn: sqlite3.Connection | None = None
_lock = threading.RLock()


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        BATCHES_DIR.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _init(_conn)
    return _conn


def _init(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS api_usage (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            ts                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            batch_id          TEXT,
            file_id           TEXT,
            page_id           INTEGER,
            engine            TEXT NOT NULL,
            calls             INTEGER DEFAULT 0,
            prompt_tokens     INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            billed_pages      INTEGER DEFAULT 0,
            cost              REAL DEFAULT 0
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_api_usage_batch ON api_usage(batch_id)")
    conn.commit()


# ---------------------------------------------------------------------------
# Settings key/value
# ---------------------------------------------------------------------------
def get(key: str, default: str | None = None) -> str | None:
    with _lock:
        row = _db().execute("SELECT value FROM settings WHERE key = ?", [key]).fetchone()
    if row is None or row[0] is None or row[0] == "":
        return default
    return row[0]


def set(key: str, value: str):
    with _lock:
        db = _db()
        db.execute(
            """INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                              updated_at = excluded.updated_at""",
            [key, value, datetime.now().isoformat()],
        )
        db.commit()


def get_all() -> dict[str, str]:
    with _lock:
        rows = _db().execute("SELECT key, value FROM settings").fetchall()
    return {r[0]: r[1] for r in rows if r[1] is not None}


def delete(key: str):
    with _lock:
        db = _db()
        db.execute("DELETE FROM settings WHERE key = ?", [key])
        db.commit()


# ---------------------------------------------------------------------------
# API usage accounting
# ---------------------------------------------------------------------------
def record_usage(
    engine: str,
    *,
    batch_id: str | None = None,
    file_id: str | None = None,
    page_id: int | None = None,
    calls: int = 0,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    billed_pages: int = 0,
    cost: float = 0.0,
):
    """Append one accounting row for a remote API call."""
    with _lock:
        db = _db()
        db.execute(
            """INSERT INTO api_usage
               (ts, batch_id, file_id, page_id, engine, calls,
                prompt_tokens, completion_tokens, billed_pages, cost)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                datetime.now().isoformat(),
                batch_id,
                file_id,
                page_id,
                engine,
                calls,
                prompt_tokens,
                completion_tokens,
                billed_pages,
                cost,
            ],
        )
        db.commit()


_SCOPE_CLAUSES = {
    "today": "WHERE date(ts) = date('now', 'localtime')",
    "month": "WHERE strftime('%Y-%m', ts) = strftime('%Y-%m', 'now', 'localtime')",
    "all": "",
}

_AGG_COLS = "SUM(calls), SUM(prompt_tokens), SUM(completion_tokens), SUM(billed_pages), SUM(cost)"


def _agg_row(row, engine: str | None = None) -> dict:
    out = {
        "calls": int(row[0] or 0),
        "prompt_tokens": int(row[1] or 0),
        "completion_tokens": int(row[2] or 0),
        "billed_pages": int(row[3] or 0),
        "cost": round(float(row[4] or 0), 6),
    }
    if engine is not None:
        out["engine"] = engine
    return out


def aggregate(scope: str = "all") -> dict:
    """Usage totals for a time scope, grouped by engine plus an overall total."""
    clause = _SCOPE_CLAUSES.get(scope, "")
    with _lock:
        db = _db()
        rows = db.execute(
            f"SELECT engine, {_AGG_COLS} FROM api_usage {clause} GROUP BY engine"
        ).fetchall()
        total = db.execute(f"SELECT {_AGG_COLS} FROM api_usage {clause}").fetchone()
    return {
        "scope": scope,
        "engines": [_agg_row(r[1:], engine=r[0]) for r in rows],
        "total": _agg_row(total),
    }


def aggregate_batch(batch_id: str) -> dict:
    """Usage totals for a single batch."""
    with _lock:
        row = (
            _db()
            .execute(f"SELECT {_AGG_COLS} FROM api_usage WHERE batch_id = ?", [batch_id])
            .fetchone()
        )
    return _agg_row(row)


def delete_batch_usage(batch_id: str):
    """Drop accounting rows for a deleted batch."""
    with _lock:
        db = _db()
        db.execute("DELETE FROM api_usage WHERE batch_id = ?", [batch_id])
        db.commit()


def avg_cost_per_page(engine: str) -> float | None:
    """Historical average cost per page for an engine, or None if no history.

    Used for pre-flight cost estimation of token-billed engines, where the
    price per page cannot be known before the request is made.
    """
    with _lock:
        row = (
            _db()
            .execute(
                """SELECT SUM(cost), COUNT(DISTINCT batch_id || '/' || file_id || '/' || page_id)
               FROM api_usage WHERE engine = ? AND page_id IS NOT NULL""",
                [engine],
            )
            .fetchone()
        )
    if not row or not row[1]:
        return None
    return float(row[0] or 0) / int(row[1])


def avg_tokens_per_page(engine: str) -> dict | None:
    """Historical average prompt/completion tokens per page, or None."""
    with _lock:
        row = (
            _db()
            .execute(
                """SELECT SUM(prompt_tokens), SUM(completion_tokens),
                      COUNT(DISTINCT batch_id || '/' || file_id || '/' || page_id)
               FROM api_usage WHERE engine = ? AND page_id IS NOT NULL""",
                [engine],
            )
            .fetchone()
        )
    if not row or not row[2]:
        return None
    n = int(row[2])
    return {
        "prompt_tokens": (row[0] or 0) / n,
        "completion_tokens": (row[1] or 0) / n,
    }
