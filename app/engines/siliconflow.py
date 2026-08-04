"""
SiliconFlow remote OCR engine (pure-remote Spotting mode).

Sends each rendered page image to an OpenAI-compatible chat/completions
endpoint with the PaddleOCR-VL `Spotting:` prompt, then decodes the
`<|TEXT_START|>...<|LOC_*|>` response into the same page_result shape the
local pipeline produces.

Capability boundaries (the model is element-level only — page-level layout
parsing requires the local pipeline):
  - line-level plain text; tables and formulas are NOT structured
  - no figure extraction
  - no confidence score (boxes carry no `score` key, so downstream falls
    back to per-label colouring)

Deliberately does not import paddlex/paddle: this engine must work on a
machine without the local inference stack.
"""

import base64
import concurrent.futures
import io
import json
import logging
import re
import time
import urllib.error
import urllib.request

from PIL import Image

logger = logging.getLogger(__name__)

SPOTTING_PROMPT = "Spotting:"

# Mirrors paddlex pre_process_for_spotting / the spotting pixel budget
UPSCALE_THRESHOLD = 1500
MAX_PIXELS = 1_605_632

REQUEST_TIMEOUT = 300
MAX_RETRIES = 3
MAX_TOKENS = 8192

# Response grammar (mirrors paddlex .../paddleocr_vl/uilts.py). Coordinates
# are LOC tokens normalized to 0-1000, 8 per box = 4 polygon points.
_ANNOT_TEXT_RE = re.compile(r"<\|TEXT_START\|>(.*?)<\|TEXT_END\|>", re.DOTALL)
_LOC_BLOCK_RE = re.compile(r"<\|LOC_BEGIN\|>(.*?)<\|LOC_END\|>", re.DOTALL)
_LOC_TOKEN_RE = re.compile(r"<\|LOC_(\d+)\|>")


class EngineError(RuntimeError):
    """Raised for unrecoverable remote engine failures."""


# ---------------------------------------------------------------------------
# Image preparation
# ---------------------------------------------------------------------------
def _prepare_image(path: str) -> tuple[str, int, int]:
    """Return (base64 JPEG data URI, original width, original height).

    Small pages are upscaled 2x (spotting accuracy), oversized pages are
    scaled down to the spotting pixel budget. Coordinates come back
    normalized to 0-1000, so they are resolution independent — we always
    de-normalize against the ORIGINAL page size.
    """
    with Image.open(path) as im:
        img = im.convert("RGB")
    orig_w, orig_h = img.size

    if orig_w < UPSCALE_THRESHOLD and orig_h < UPSCALE_THRESHOLD:
        img = img.resize((orig_w * 2, orig_h * 2), Image.Resampling.LANCZOS)

    w, h = img.size
    if w * h > MAX_PIXELS:
        ratio = (MAX_PIXELS / (w * h)) ** 0.5
        img = img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{data}", orig_w, orig_h


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def _post_chat_completion(cfg: dict, data_uri: str) -> dict:
    """Call /chat/completions with retries; return the parsed JSON body."""
    url = f"{cfg['base_url'].rstrip('/')}/chat/completions"
    payload = {
        "model": cfg["model"],
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_uri}},
                    {"type": "text", "text": SPOTTING_PROMPT},
                ],
            }
        ],
    }
    body = json.dumps(payload).encode("utf-8")

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {cfg['api_key']}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:500]
            except (OSError, ValueError):
                logger.debug("Could not read SiliconFlow error detail", exc_info=True)
            # 4xx other than rate limiting will not get better on retry
            if exc.code != 429 and 400 <= exc.code < 500:
                raise EngineError(f"硅基流动接口返回 {exc.code}: {detail or exc.reason}") from exc
            last_error = EngineError(f"硅基流动接口返回 {exc.code}: {detail or exc.reason}")
        except (OSError, ValueError) as exc:
            last_error = exc

        if attempt < MAX_RETRIES - 1:
            delay = 2 ** (attempt + 1)
            logger.warning(
                "SiliconFlow request failed (attempt %d/%d): %s — retrying in %ds",
                attempt + 1,
                MAX_RETRIES,
                last_error,
                delay,
            )
            time.sleep(delay)

    raise EngineError(f"硅基流动接口请求失败: {last_error}")


# ---------------------------------------------------------------------------
# Spotting response decoding
# ---------------------------------------------------------------------------
def _scale_points(vals: list[int], w: int, h: int) -> list[list[float]]:
    pts = [(vals[j], vals[j + 1]) for j in range(0, 8, 2)]
    return [[round(x / 1000.0 * w, 2), round(y / 1000.0 * h, 2)] for x, y in pts]


def parse_spotting(content: str, w: int, h: int) -> list[dict]:
    """Decode a spotting response into [{text, polygon, bbox}, ...]."""
    items: list[dict] = []

    texts = _ANNOT_TEXT_RE.findall(content)
    loc_blocks = _LOC_BLOCK_RE.findall(content)
    for i in range(min(len(texts), len(loc_blocks))):
        loc_items = _LOC_TOKEN_RE.findall(loc_blocks[i])
        if len(loc_items) < 8:
            continue
        items.append(
            {
                "text": texts[i].strip(),
                "polygon": _scale_points(list(map(int, loc_items[:8])), w, h),
            }
        )

    # Fallback: bare LOC runs with the text preceding each group of 8
    if not items:
        matches = list(_LOC_TOKEN_RE.finditer(content))
        last_end = 0
        i = 0
        while i + 7 < len(matches):
            group = matches[i : i + 8]
            vals = [int(m.group(1)) for m in group]
            items.append(
                {
                    "text": content[last_end : group[0].start()].strip(),
                    "polygon": _scale_points(vals, w, h),
                }
            )
            last_end = group[-1].end()
            i += 8

    for item in items:
        xs = [p[0] for p in item["polygon"]]
        ys = [p[1] for p in item["polygon"]]
        item["bbox"] = [min(xs), min(ys), max(xs), max(ys)]
    return items


def _build_page_result(items: list[dict], w: int, h: int) -> dict:
    """Assemble a page_result isomorphic to the local pipeline output."""
    parsing_res_list = []
    boxes = []
    for idx, item in enumerate(items):
        order = idx + 1
        parsing_res_list.append(
            {
                "block_label": "text",
                "block_content": item["text"],
                "block_bbox": item["bbox"],
                "block_polygon_points": item["polygon"],
                "block_id": order,
                "block_order": order,
            }
        )
        # No `score` key: downstream switches to per-label colouring.
        boxes.append(
            {
                "label": "text",
                "order": order,
                "coordinate": item["bbox"],
                "polygon_points": item["polygon"],
            }
        )

    json_data = {
        "res": {
            "width": w,
            "height": h,
            "engine": "siliconflow",
            "has_score": False,
            "parsing_res_list": parsing_res_list,
            "layout_det_res": {"boxes": boxes},
        }
    }
    return {
        "markdown_text": "\n\n".join(item["text"] for item in items if item["text"]),
        "json_data": json_data,
        "images": {},
        "page_data": {
            "parsing_res_list": parsing_res_list,
            "boxes": boxes,
            "width": w,
            "height": h,
        },
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def _process_one_page(page_image: str, cfg: dict) -> tuple[dict, dict]:
    """Run one page. Returns (page_result, usage)."""
    data_uri, w, h = _prepare_image(page_image)
    response = _post_chat_completion(cfg, data_uri)

    choices = response.get("choices") or []
    if not choices:
        raise EngineError(f"硅基流动接口未返回结果: {str(response)[:300]}")
    content = (choices[0].get("message") or {}).get("content") or ""

    items = parse_spotting(content, w, h)
    if not items:
        logger.warning(
            "Spotting returned no located text for %s (content length %d)",
            page_image,
            len(content),
        )

    usage = response.get("usage") or {}
    return _build_page_result(items, w, h), {
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
    }


def process_pages_iter(page_images: list[str], cfg: dict, on_usage=None):
    """
    Stream-process pre-rendered page images through the remote model.

    Pages are dispatched concurrently (remote calls have no shared-pipeline
    constraint) but yielded strictly in page order, so persistence and SSE
    ordering in batch_manager stay unchanged.

    Yields
    ------
    tuple[int, dict]
        (page_index, page_result)
    """
    if not cfg.get("api_key"):
        raise EngineError("硅基流动未配置 API Key")
    if not page_images:
        return

    workers = min(cfg.get("max_concurrency", 4), len(page_images))
    logger.info(
        "SiliconFlow spotting: %d page(s), model %s, concurrency %d",
        len(page_images),
        cfg["model"],
        workers,
    )

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_process_one_page, img, cfg) for img in page_images]
        try:
            for idx, future in enumerate(futures):
                page_result, usage = future.result()
                if on_usage:
                    on_usage(
                        page_id=idx,
                        calls=1,
                        prompt_tokens=usage["prompt_tokens"],
                        completion_tokens=usage["completion_tokens"],
                    )
                yield idx, page_result
        except BaseException:
            # Do not keep burning quota on pages nobody will consume
            for future in futures:
                future.cancel()
            raise
