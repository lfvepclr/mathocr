"""
Baidu document parsing engine (文档解析 / PaddleOCR-VL cloud API).

Two-step async API:
  1. POST .../paddle-vl-parser/task        -> task_id
  2. POST .../paddle-vl-parser/task/query  -> poll until status == success,
     then download the JSON at `parse_result_url`

The Baidu result format differs from the local pipeline, so this module
adapts it into the same page_result shape:
  - `position [x, y, w, h]` -> `block_bbox [x1, y1, x2, y2]`
  - Baidu layout types -> platform block labels
  - table content taken from `tables[].markdown` (matched by layout_id)
  - figures downloaded from `images[].data_url` into the `images` dict

Baidu returns no confidence score, so boxes carry no `score` key and the
UI falls back to per-label colouring.

Deliberately does not import paddlex/paddle.
"""

import base64
import io
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image

from app.services import settings_store

logger = logging.getLogger(__name__)

TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"
SUBMIT_URL = "https://aip.baidubce.com/rest/2.0/brain/online/v2/paddle-vl-parser/task"
QUERY_URL = SUBMIT_URL + "/query"

POLL_INTERVAL = 6.0  # docs recommend 5-10s; query QPS limit is 5
POLL_TIMEOUT = 30 * 60
HTTP_TIMEOUT = 120

# Baidu limits: 版式文档 <= 100MB / 500 pages, 图片 <= 10MB
MAX_DOC_BYTES = 100 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 500
SUPPORTED_SUFFIXES = {
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".tif",
    ".tiff",
    ".ofd",
}

# Baidu layout type -> platform block label (drives label colours / CSS).
# Types keep their semantics 1:1 so the layout view can style them
# (vertical text, page furniture, formula numbers...); only genuinely
# equivalent names are translated. Unmapped types pass through unchanged.
LABEL_MAP = {
    "title": "paragraph_title",
    "display_formula": "formula",
    "content": "contents",
}
IMAGE_TYPES = {"image", "header_image", "footer_image", "chart", "seal"}


class EngineError(RuntimeError):
    """Raised for unrecoverable remote engine failures."""


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
_token_cache: dict = {}


def _get_access_token(api_key: str, secret_key: str) -> str:
    """Fetch (and cache) an access_token. Baidu tokens last 30 days."""
    if not api_key or not secret_key:
        raise EngineError("百度文档解析未配置 API Key / Secret Key")

    now = datetime.now()
    if _token_cache.get("token") and _token_cache.get("expire_at", now) > now:
        return _token_cache["token"]

    # Survive a server restart without re-issuing a token
    stored = settings_store.get("baidu.access_token")
    stored_exp = settings_store.get("baidu.token_expire_at")
    if stored and stored_exp:
        try:
            if datetime.fromisoformat(stored_exp) > now:
                _token_cache.update(token=stored, expire_at=datetime.fromisoformat(stored_exp))
                return stored
        except ValueError:
            pass

    params = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": api_key,
            "client_secret": secret_key,
        }
    )
    try:
        with urllib.request.urlopen(f"{TOKEN_URL}?{params}", timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise EngineError(f"百度 access_token 获取失败: {exc}") from exc

    token = data.get("access_token")
    if not token:
        raise EngineError(f"百度 access_token 获取失败: {data.get('error_description') or data}")
    # Renew a day early to avoid edge-of-expiry failures
    expire_at = now + timedelta(seconds=int(data.get("expires_in", 2592000)) - 86400)
    _token_cache.update(token=token, expire_at=expire_at)
    settings_store.set("baidu.access_token", token)
    settings_store.set("baidu.token_expire_at", expire_at.isoformat())
    return token


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def _post_form(url: str, token: str, fields: dict) -> dict:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        f"{url}?access_token={token}",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:500]
        except (OSError, ValueError):
            logger.debug("Could not read Baidu error detail", exc_info=True)
        raise EngineError(f"百度接口返回 {exc.code}: {detail or exc.reason}") from exc
    except Exception as exc:
        raise EngineError(f"百度接口请求失败: {exc}") from exc

    if data.get("error_code"):
        raise EngineError(f"百度接口错误 {data['error_code']}: {data.get('error_msg', '')}")
    return data


def _download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------
def _validate_input(file_path: Path):
    suffix = file_path.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise EngineError(f"百度文档解析不支持的文件类型: {suffix}")

    size = file_path.stat().st_size
    if suffix == ".pdf":
        if size > MAX_DOC_BYTES:
            raise EngineError(f"PDF 超过百度接口上限 100MB (当前 {size / 1024 / 1024:.1f}MB)")
        from app.services import pdf_renderer

        pages = pdf_renderer.get_page_count(file_path)
        if pages > MAX_PDF_PAGES:
            raise EngineError(f"PDF 页数 {pages} 超过百度接口上限 500 页")
    elif size > MAX_IMAGE_BYTES:
        raise EngineError(f"图片超过百度接口上限 10MB (当前 {size / 1024 / 1024:.1f}MB)")


# ---------------------------------------------------------------------------
# Result adaptation
# ---------------------------------------------------------------------------
def _bbox_from_position(position) -> list[float] | None:
    if not position or len(position) != 4:
        return None
    x, y, w, h = position
    return [x, y, x + w, y + h]


def _title_level(layout: dict, label: str) -> int:
    """Markdown heading level for a title block.

    `sub_type` is only present when relevel_titles is enabled; it carries
    the level as a trailing digit. Heuristic on top: numbered section
    headings ("1. ..." / "2、...") are demoted to level 3 so textbook
    pages don't collapse into a flat list of H1/H2.
    """
    if label == "doc_title":
        return 1
    level = 2
    sub_type = str(layout.get("sub_type") or "")
    digits = "".join(ch for ch in sub_type if ch.isdigit())
    if digits:
        level = min(6, max(1, int(digits)))
    if level <= 2 and re.match(r"^\s*\d+\s*[.、]", str(layout.get("text") or "")):
        level = 3
    logger.debug(
        "baidu title: sub_type=%r level=%d text=%.20s",
        sub_type,
        level,
        str(layout.get("text") or ""),
    )
    return level


_TABLE_IMG_RE = re.compile(r'<img[^>]*\bsrc="(https?://[^"]+)"[^>]*>')


def _localize_table_images(md: str, images: dict, page_idx: int) -> str:
    """Download remote <img> inside table markdown into the images dict.

    Baidu table cells reference figures via bcebos URLs whose auth expires
    after 30 days. Pulling them into `images` lets batch_manager persist
    them like figure blocks and rewrite src to a local API path.
    """

    def _sub(m: re.Match) -> str:
        url = m.group(1)
        img_name = f"page_{page_idx}_table_{len(images)}.png"
        try:
            with Image.open(io.BytesIO(_download(url))) as im:
                images[img_name] = im.convert("RGB")
        except OSError:
            logger.warning("Failed to download table image %s", url)
            return m.group(0)
        return m.group(0).replace(url, img_name)

    return _TABLE_IMG_RE.sub(_sub, md)


def _adapt_page(page: dict, page_idx: int) -> dict:
    """Convert one Baidu page into the platform's page_result shape."""
    meta = page.get("meta") or {}
    width = meta.get("page_width", 0)
    height = meta.get("page_height", 0)

    tables_by_layout = {t.get("layout_id"): t for t in (page.get("tables") or [])}
    images_by_layout = {im.get("layout_id"): im for im in (page.get("images") or [])}

    parsing_res_list: list[dict] = []
    boxes: list[dict] = []
    images: dict[str, Image.Image] = {}
    md_parts: list[str] = []

    for layout in page.get("layouts") or []:
        baidu_type = layout.get("type") or "text"
        label = LABEL_MAP.get(baidu_type, baidu_type)
        bbox = _bbox_from_position(layout.get("position"))
        if bbox is None:
            continue
        order = len(parsing_res_list) + 1
        layout_id = layout.get("layout_id")

        content = layout.get("text") or ""
        md_piece = content

        if baidu_type == "table":
            table = tables_by_layout.get(layout_id) or {}
            content = _localize_table_images(table.get("markdown") or content, images, page_idx)
            md_piece = content
        elif baidu_type in IMAGE_TYPES:
            img_meta = images_by_layout.get(layout_id) or {}
            data_url = img_meta.get("data_url")
            img_name = f"page_{page_idx}_img_{len(images)}.png"
            if data_url:
                try:
                    with Image.open(io.BytesIO(_download(data_url))) as im:
                        images[img_name] = im.convert("RGB")
                except Exception:
                    logger.exception("Failed to download figure %s", data_url)
                    img_name = ""
            else:
                img_name = ""
            # `src="<name>"` is what batch_manager rewrites to an API URL
            content = f'<img src="{img_name}">' if img_name else ""
            if content:
                # Center like the local pipeline; width % keeps the flow
                # view's figure size close to the original layout.
                pct = ""
                if width:
                    pct = f' width="{round((bbox[2] - bbox[0]) / width * 100)}%"'
                md_piece = f'<div style="text-align: center;"><img src="{img_name}"{pct}></div>'
            else:
                md_piece = ""
            description = img_meta.get("image_description")
            if description:
                md_piece = f"{md_piece}\n\n{description}" if md_piece else description
        elif baidu_type == "display_formula":
            content = content.strip()
            md_piece = f"$${content}$$" if content else ""
        elif baidu_type == "inline_formula":
            content = content.strip()
            md_piece = content if not content or "$" in content else f"${content}$"
        elif label in ("doc_title", "paragraph_title"):
            level = _title_level(layout, label)
            md_piece = f"{'#' * level} {content}".strip() if content else ""
        elif label in ("figure_title", "table_title"):
            md_piece = f'<div style="text-align: center;">{content}</div>' if content else ""

        parsing_res_list.append(
            {
                "block_label": label,
                "block_content": content,
                "block_bbox": bbox,
                "block_polygon_points": layout.get("polygon") or [],
                "block_id": order,
                "block_order": order,
            }
        )
        # No `score` key: Baidu does not report confidence.
        boxes.append(
            {
                "label": label,
                "order": order,
                "coordinate": bbox,
                "polygon_points": layout.get("polygon") or [],
            }
        )
        if md_piece:
            md_parts.append(md_piece)

    json_data = {
        "res": {
            "width": width,
            "height": height,
            "engine": "baidu",
            "has_score": False,
            "parsing_res_list": parsing_res_list,
            "layout_det_res": {"boxes": boxes},
        }
    }
    return {
        "markdown_text": "\n\n".join(md_parts),
        "json_data": json_data,
        "images": images,
        "page_data": {
            "parsing_res_list": parsing_res_list,
            "boxes": boxes,
            "width": width,
            "height": height,
        },
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def process_file_iter(file_path: str, cfg: dict, on_usage=None):
    """
    Submit a whole document to Baidu, wait for the task, yield adapted pages.

    Unlike the local pipeline this is not incremental — the wait happens
    during polling, after which all pages are adapted quickly.

    Yields
    ------
    tuple[int, dict]
        (page_index, page_result)
    """
    path = Path(file_path)
    _validate_input(path)

    token = _get_access_token(cfg.get("api_key", ""), cfg.get("secret_key", ""))
    file_data = base64.b64encode(path.read_bytes())

    logger.info(
        "Baidu doc-parse: submitting %s (%.1fMB)", path.name, path.stat().st_size / 1024 / 1024
    )
    submitted = _post_form(
        SUBMIT_URL,
        token,
        {
            "file_data": file_data,
            "file_name": path.name,
            "analysis_chart": "true",
            "merge_tables": "true",
            "relevel_titles": "true",
            "recognize_seal": "true",
        },
    )
    task_id = (submitted.get("result") or {}).get("task_id")
    if not task_id:
        raise EngineError(f"百度未返回 task_id: {str(submitted)[:300]}")
    logger.info("Baidu doc-parse: task %s submitted, polling", task_id)

    deadline = time.time() + POLL_TIMEOUT
    result_url = None
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL)
        queried = _post_form(QUERY_URL, token, {"task_id": task_id})
        result = queried.get("result") or {}
        status = (result.get("status") or "").lower()
        if status == "success":
            result_url = result.get("parse_result_url")
            break
        if status in ("failed", "error"):
            raise EngineError(
                f"百度解析任务失败: {result.get('task_error') or queried.get('error_msg')}"
            )
        logger.debug("Baidu task %s status: %s", task_id, status or "pending")
    else:
        raise EngineError(f"百度解析任务超时 ({POLL_TIMEOUT // 60} 分钟): {task_id}")

    if not result_url:
        raise EngineError(f"百度解析成功但未返回结果链接: {task_id}")

    try:
        parsed = json.loads(_download(result_url).decode("utf-8"))
    except EngineError:
        raise
    except Exception as exc:
        raise EngineError(f"百度解析结果下载失败: {exc}") from exc

    pages = parsed.get("pages") or []
    if not pages:
        raise EngineError("百度解析结果为空")
    pages = sorted(pages, key=lambda p: p.get("page_num", 0))

    # Billing is per page and known only once the task returns
    if on_usage:
        on_usage(calls=1, billed_pages=len(pages))

    logger.info("Baidu doc-parse: %d page(s) returned for %s", len(pages), path.name)
    for idx, page in enumerate(pages):
        yield idx, _adapt_page(page, idx)
