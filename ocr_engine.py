"""
PaddleOCR-VL-1.6 OCR Engine with parallel processing support.

Provides a singleton pipeline, single-document processing, and
parallel batch processing using ThreadPoolExecutor.

Inference backend (Apple Silicon optimization):
  - If a VLM inference server is reachable (default http://localhost:8111/),
    the pipeline offloads VLM recognition to it via vl_rec_backend
    (e.g. MLX-VLM, which runs on the Apple GPU and is far faster than CPU).
    Start one with:  mlx_vlm.server --port 8111 --model ~/.cache/mlx_models/PaddlePaddle/PaddleOCR-VL-1.6
    (start.sh automates this, including downloading the model via ModelScope)
  - Otherwise it falls back to local Paddle inference on CPU.
  Env overrides: OCR_VL_REC_BACKEND, OCR_VL_REC_SERVER_URL,
                 OCR_VL_REC_API_MODEL_NAME, OCR_VL_REC_MAX_CONCURRENCY
"""

import base64
import concurrent.futures
import io
import logging
import os
import threading
import urllib.request
from pathlib import Path
from typing import Any

# Use ModelScope as default model source for better availability
os.environ.setdefault("PADDLE_PDX_LOCAL_MODEL_SOURCE", "ModelScope")

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pipeline singleton (thread-safe lazy init)
# ---------------------------------------------------------------------------
_pipeline = None
_pipeline_lock = threading.Lock()


def _vlm_server_reachable(url: str, timeout: float = 0.8) -> bool:
    """Probe whether a VLM inference server is up (cheap, best-effort)."""
    base = url.rstrip("/")
    for path in ("/health", "/v1/models", "/"):
        try:
            with urllib.request.urlopen(base + path, timeout=timeout) as resp:
                if resp.status < 500:
                    return True
        except Exception:
            continue
    return False


def get_pipeline():
    """Return the global PaddleOCRVL pipeline, creating it on first call."""
    global _pipeline
    if _pipeline is None:
        with _pipeline_lock:
            if _pipeline is None:
                from paddleocr import PaddleOCRVL

                kwargs: dict[str, Any] = dict(
                    device="cpu",
                    use_layout_detection=True,
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_chart_recognition=False,
                )

                # --- VLM backend selection (Apple Silicon acceleration) ---
                vl_backend = os.environ.get("OCR_VL_REC_BACKEND", "").strip()
                vl_server_url = os.environ.get(
                    "OCR_VL_REC_SERVER_URL", "http://localhost:8111/"
                )
                if not vl_backend and _vlm_server_reachable(vl_server_url):
                    # Auto-detect a running MLX-VLM (or compatible) server
                    vl_backend = "mlx-vlm-server"

                if vl_backend:
                    kwargs.update(
                        vl_rec_backend=vl_backend,
                        vl_rec_server_url=vl_server_url,
                        # 服务端 /v1/models 报告的模型 id
                        # (start.sh 从本地路径预加载, 其 id 即为此名)
                        vl_rec_api_model_name=os.environ.get(
                            "OCR_VL_REC_API_MODEL_NAME",
                            "PaddlePaddle/PaddleOCR-VL-1.6",
                        ),
                        vl_rec_max_concurrency=int(
                            os.environ.get("OCR_VL_REC_MAX_CONCURRENCY", "4")
                        ),
                    )
                    logger.info(
                        "Initializing PaddleOCRVL with VLM server backend "
                        "'%s' at %s …", vl_backend, vl_server_url,
                    )
                else:
                    logger.info(
                        "Initializing PaddleOCRVL pipeline (local CPU mode). "
                        "Tip: run `./start.sh` (auto-starts MLX-VLM) for much "
                        "faster recognition on Apple Silicon."
                    )

                _pipeline = PaddleOCRVL(**kwargs)
                logger.info("PaddleOCRVL pipeline ready.")
    return _pipeline


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------
def _extract_page_data(json_data: dict) -> dict:
    """
    Extract parsing_res_list, boxes, width, height from the JSON result.

    Handles different nesting levels that PaddleOCR may return.
    """
    pruned: dict = {}
    if not json_data:
        return {"parsing_res_list": [], "boxes": [], "width": 0, "height": 0}

    # Local PaddleOCR-VL model: {"res": {...}}
    if "res" in json_data and isinstance(json_data["res"], dict):
        pruned = json_data["res"]
    elif "layoutParsingResults" in json_data:
        results = json_data["layoutParsingResults"]
        if results and isinstance(results, list):
            first = results[0]
            pruned = first.get("prunedResult", first)
    elif "prunedResult" in json_data:
        pruned = json_data["prunedResult"]
    else:
        pruned = json_data

    return {
        "parsing_res_list": pruned.get("parsing_res_list", []),
        "boxes": pruned.get("layout_det_res", {}).get("boxes", []),
        "width": pruned.get("width", 0),
        "height": pruned.get("height", 0),
    }


# ---------------------------------------------------------------------------
# Single-document processing
# ---------------------------------------------------------------------------
def _build_page_result(res) -> dict[str, Any]:
    """Build the page_result dict from a single PaddleOCR result object."""
    md = res.markdown or {}
    text = md.get("markdown_texts", "")
    images = md.get("markdown_images", {})

    # Full JSON output
    try:
        json_data = res.json if isinstance(res.json, dict) else {}
    except (AttributeError, TypeError):
        json_data = {}

    page_data = _extract_page_data(json_data)

    return {
        "markdown_text": text,
        "json_data": json_data,
        "images": images,
        "page_data": page_data,
    }


def process_document_iter(file_path: str):
    """
    Stream-process a document (image or PDF) with PaddleOCR-VL.

    Uses the pipeline's generator interface so each page is yielded
    as soon as its inference finishes — callers can persist and
    publish per-page progress without waiting for the whole document.

    Yields
    ------
    tuple[int, dict]
        (page_index, page_result) for each page, in order.
    """
    pipeline = get_pipeline()
    for idx, res in enumerate(pipeline.predict_iter(file_path)):
        yield idx, _build_page_result(res)


def process_document(file_path: str) -> list[dict[str, Any]]:
    """
    Process a single document (image or PDF) with PaddleOCR-VL.

    Returns a list of page results, each containing:
        - markdown_text: str
        - json_data: dict (full PaddleOCR JSON)
        - images: dict[str, PIL.Image]  (extracted images)
        - page_data: dict (parsed parsing_res_list, boxes, width, height)
    """
    return [page for _, page in process_document_iter(file_path)]


# ---------------------------------------------------------------------------
# Parallel batch processing
# ---------------------------------------------------------------------------
def process_batch_parallel(
    file_paths: list[str],
    max_workers: int | None = None,
    progress_callback=None,
) -> dict[str, list[dict] | dict]:
    """
    Process multiple files in parallel using ThreadPoolExecutor.

    PaddlePaddle inference releases the GIL during C-level computation,
    so threads give real parallelism for the model forward pass.

    Parameters
    ----------
    file_paths : list[str]
        Paths to files to process.
    max_workers : int | None
        Maximum parallel workers. Defaults to min(len(files), 4).
    progress_callback : callable | None
        Called as progress_callback(file_path, status, result) where
        status is "started", "completed", or "error".

    Returns
    -------
    dict
        Mapping file_path -> list[page_result] on success,
        or file_path -> {"error": str} on failure.
    """
    if max_workers is None:
        max_workers = min(len(file_paths), 4)

    results: dict[str, list[dict] | dict] = {}

    def _worker(fp: str):
        if progress_callback:
            progress_callback(fp, "started", None)
        try:
            pages = process_document(fp)
            if progress_callback:
                progress_callback(fp, "completed", pages)
            return fp, pages
        except Exception as exc:
            logger.exception("Error processing %s", fp)
            if progress_callback:
                progress_callback(fp, "error", str(exc))
            return fp, {"error": str(exc)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(_worker, fp) for fp in file_paths]
        for future in concurrent.futures.as_completed(futures):
            fp, result = future.result()
            results[fp] = result

    return results


# ---------------------------------------------------------------------------
# Image embedding helper (kept for compatibility with old app.py)
# ---------------------------------------------------------------------------
def _pil_to_base64(pil_image) -> str:
    """Convert a PIL Image to a base64 data URI string."""
    buf = io.BytesIO()
    fmt = pil_image.format or "JPEG"
    pil_image.save(buf, format=fmt)
    data = base64.b64encode(buf.getvalue()).decode("utf-8")
    mime = f"image/{fmt.lower()}"
    return f"data:{mime};base64,{data}"


def embed_images_in_markdown(markdown_text: str, images: dict) -> str:
    """Replace local image paths in markdown with base64 data URIs."""
    result = markdown_text
    for filename, pil_img in images.items():
        b64_uri = _pil_to_base64(pil_img)
        result = result.replace(f'src="{filename}"', f'src="{b64_uri}"')
        basename = Path(filename).name
        if basename != filename:
            result = result.replace(f'src="{basename}"', f'src="{b64_uri}"')
    return result
