"""Central path configuration for the MathOCR application.

All modules should import paths from here rather than computing them
from ``__file__``, so that file relocations never break path resolution.
"""

from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.resolve()
STATIC_DIR = PROJECT_ROOT / "static"
INDEX_HTML = STATIC_DIR / "index.html"
BATCHES_DIR = PROJECT_ROOT / "batches"
DB_PATH = BATCHES_DIR / "metadata.db"
