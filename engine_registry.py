"""
OCR engine registry: descriptors, configuration resolution, cost accounting.

Configuration precedence:  settings table (UI)  >  environment variable  >  default

API keys are never returned in full by the HTTP layer — use mask() for display.
Cost is always expressed in CNY.
"""

import importlib.util
import logging
import os

import settings_store

logger = logging.getLogger(__name__)

LOCAL = "local"
SILICONFLOW = "siliconflow"
BAIDU = "baidu"

# ---------------------------------------------------------------------------
# Engine descriptors
# ---------------------------------------------------------------------------
ENGINES: dict[str, dict] = {
    LOCAL: {
        "name": "本地 PaddleOCR-VL-1.6",
        "billing": "free",
        "requires_key": False,
        "note": "本机推理，完整版面解析。Apple Silicon 下经 MLX-VLM 加速约 8s/页，纯 CPU 约 76s/页。",
        "limitations": [],
    },
    SILICONFLOW: {
        "name": "硅基流动 PaddleOCR-VL",
        "billing": "token",
        "requires_key": True,
        "note": "整页 Spotting 远程识别，按 token 计费（该模型当前免费）。",
        "limitations": [
            "行级纯文本，表格与公式不做结构化",
            "不提取文档插图",
            "无置信度分数，标注按块类型着色",
        ],
    },
    BAIDU: {
        "name": "百度文档解析",
        "billing": "page",
        "requires_key": True,
        "note": "云端异步整档解析，返回结构化版面与表格 Markdown，按页计费。",
        "limitations": [
            "无置信度分数，标注按块类型着色",
            "PDF 最大 500 页 / 100MB",
        ],
    },
}

# setting key -> (env var, default)
_FIELDS: dict[str, dict[str, tuple[str, str]]] = {
    "global": {
        "default_engine": ("OCR_DEFAULT_ENGINE", LOCAL),
    },
    SILICONFLOW: {
        "api_key": ("SILICONFLOW_API_KEY", ""),
        "base_url": ("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1"),
        "model": ("SILICONFLOW_MODEL", "PaddlePaddle/PaddleOCR-VL-1.5"),
        "max_concurrency": ("SILICONFLOW_MAX_CONCURRENCY", "4"),
        "price_in": ("SILICONFLOW_PRICE_IN", "0"),
        "price_out": ("SILICONFLOW_PRICE_OUT", "0"),
    },
    BAIDU: {
        "api_key": ("BAIDU_OCR_API_KEY", ""),
        "secret_key": ("BAIDU_OCR_SECRET_KEY", ""),
        "price_per_page": ("BAIDU_PRICE_PER_PAGE", "0"),
    },
}

SECRET_FIELDS = {"api_key", "secret_key"}

_LOCAL_UNAVAILABLE_NOTE = "未安装本地推理环境(paddleocr/paddle),仅可用在线引擎"


def local_runtime_available() -> bool:
    """Whether the local inference stack (paddleocr + paddle) is installed.

    Machines started via start_remote.sh deliberately skip those heavy
    deps; the local engine then degrades to 'unavailable' instead of
    crashing at OCR time.
    """
    return (
        importlib.util.find_spec("paddleocr") is not None
        and importlib.util.find_spec("paddle") is not None
    )


def _setting_key(scope: str, field: str) -> str:
    return f"{scope}.{field}"


def _resolve(scope: str, field: str) -> str:
    """Resolve one config field: settings table > env var > default."""
    env_var, default = _FIELDS[scope][field]
    stored = settings_store.get(_setting_key(scope, field))
    if stored not in (None, ""):
        return stored
    return os.environ.get(env_var) or default


def _as_float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value: str, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Public config accessors
# ---------------------------------------------------------------------------
def default_engine() -> str:
    engine = _resolve("global", "default_engine")
    if engine in ENGINES and is_configured(engine):
        return engine
    # The configured default is unusable here (e.g. local engine on a
    # machine without the paddle stack) — fall back to the first engine
    # that can actually run.
    for candidate in ENGINES:
        if is_configured(candidate):
            return candidate
    return LOCAL


def get_config(engine: str) -> dict:
    """Return the resolved runtime configuration for an engine."""
    if engine == SILICONFLOW:
        return {
            "engine": engine,
            "api_key": _resolve(engine, "api_key"),
            "base_url": _resolve(engine, "base_url").rstrip("/"),
            "model": _resolve(engine, "model"),
            "max_concurrency": max(
                1, _as_int(_resolve(engine, "max_concurrency"), 4)
            ),
            "price_in": _as_float(_resolve(engine, "price_in")),
            "price_out": _as_float(_resolve(engine, "price_out")),
        }
    if engine == BAIDU:
        return {
            "engine": engine,
            "api_key": _resolve(engine, "api_key"),
            "secret_key": _resolve(engine, "secret_key"),
            "price_per_page": _as_float(_resolve(engine, "price_per_page")),
        }
    return {"engine": LOCAL}


def is_configured(engine: str) -> bool:
    """Whether the engine has everything it needs to run."""
    if engine not in ENGINES:
        return False
    if engine == LOCAL:
        return local_runtime_available()
    if not ENGINES[engine]["requires_key"]:
        return True
    cfg = get_config(engine)
    if engine == SILICONFLOW:
        return bool(cfg["api_key"])
    if engine == BAIDU:
        return bool(cfg["api_key"] and cfg["secret_key"])
    return True


def mask(secret: str) -> str:
    """Mask a secret for display: keep a short tail only."""
    if not secret:
        return ""
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:3]}****{secret[-4:]}"


def price_info(engine: str) -> dict:
    """Pricing summary for UI display."""
    cfg = get_config(engine)
    billing = ENGINES[engine]["billing"]
    if billing == "token":
        return {
            "billing": billing,
            "unit": "CNY / 1M tokens",
            "price_in": cfg["price_in"],
            "price_out": cfg["price_out"],
            "configured": cfg["price_in"] > 0 or cfg["price_out"] > 0,
        }
    if billing == "page":
        return {
            "billing": billing,
            "unit": "CNY / 页",
            "price_per_page": cfg["price_per_page"],
            "configured": cfg["price_per_page"] > 0,
        }
    return {"billing": billing, "unit": "", "configured": True}


def list_engines() -> list[dict]:
    """Engine list for the frontend."""
    current_default = default_engine()
    local_ok = local_runtime_available()
    out = []
    for engine_id, meta in ENGINES.items():
        note = meta["note"]
        if engine_id == LOCAL and not local_ok:
            note = _LOCAL_UNAVAILABLE_NOTE
        out.append({
            "id": engine_id,
            "name": meta["name"],
            "billing": meta["billing"],
            "requires_key": meta["requires_key"],
            "configured": is_configured(engine_id),
            "is_default": engine_id == current_default,
            "note": note,
            "limitations": meta["limitations"],
            "price": price_info(engine_id),
        })
    return out


def settings_view() -> dict:
    """All settings for the UI, with secrets masked."""
    out: dict[str, dict] = {}
    for scope, fields in _FIELDS.items():
        scope_out: dict = {}
        for field in fields:
            value = _resolve(scope, field)
            if field in SECRET_FIELDS:
                scope_out[field] = mask(value)
                scope_out[f"{field}_configured"] = bool(value)
            else:
                scope_out[field] = value
        out[scope] = scope_out
    return out


def apply_settings(payload: dict) -> list[str]:
    """Persist submitted settings. Empty secret strings mean 'keep current'.

    Returns the list of updated setting keys.
    """
    updated: list[str] = []
    for scope, fields in _FIELDS.items():
        submitted = payload.get(scope)
        if not isinstance(submitted, dict):
            continue
        for field in fields:
            if field not in submitted:
                continue
            value = submitted[field]
            if value is None:
                continue
            value = str(value).strip()
            # A blank secret is "unchanged", not "erase" — the UI only ever
            # shows a mask, so it cannot round-trip the real value back.
            if field in SECRET_FIELDS and value == "":
                continue
            settings_store.set(_setting_key(scope, field), value)
            updated.append(_setting_key(scope, field))
    if updated:
        logger.info("Settings updated: %s", ", ".join(updated))
    return updated


# ---------------------------------------------------------------------------
# Cost
# ---------------------------------------------------------------------------
def compute_cost(
    engine: str,
    *,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    billed_pages: int = 0,
) -> float:
    """Cost in CNY for one accounting event."""
    billing = ENGINES.get(engine, {}).get("billing", "free")
    if billing == "token":
        cfg = get_config(engine)
        cost = (
            prompt_tokens / 1_000_000 * cfg["price_in"]
            + completion_tokens / 1_000_000 * cfg["price_out"]
        )
        return round(cost, 6)
    if billing == "page":
        cfg = get_config(engine)
        return round(billed_pages * cfg["price_per_page"], 6)
    return 0.0


def estimate_cost(engine: str, pages: int) -> dict:
    """Pre-flight cost estimate for `pages` pages.

    Token-billed engines have no deterministic per-page price, so the
    estimate is derived from historical usage; without history we report
    `cost: None` rather than inventing a number.
    """
    billing = ENGINES.get(engine, {}).get("billing", "free")
    if billing == "free":
        return {"engine": engine, "pages": pages, "cost": 0.0, "basis": "free"}

    if billing == "page":
        cfg = get_config(engine)
        if cfg["price_per_page"] <= 0:
            return {
                "engine": engine, "pages": pages, "cost": None,
                "basis": "no_price", "note": "未配置单价，请在设置中填写 CNY/页",
            }
        return {
            "engine": engine, "pages": pages,
            "cost": round(pages * cfg["price_per_page"], 6),
            "basis": "price_per_page",
        }

    # token billing
    cfg = get_config(engine)
    if cfg["price_in"] <= 0 and cfg["price_out"] <= 0:
        return {
            "engine": engine, "pages": pages, "cost": 0.0,
            "basis": "free_model", "note": "该模型当前定价为免费",
        }
    avg = settings_store.avg_tokens_per_page(engine)
    if not avg:
        return {
            "engine": engine, "pages": pages, "cost": None,
            "basis": "no_history", "note": "暂无历史数据，无法预估",
        }
    cost = compute_cost(
        engine,
        prompt_tokens=int(avg["prompt_tokens"] * pages),
        completion_tokens=int(avg["completion_tokens"] * pages),
    )
    return {
        "engine": engine, "pages": pages, "cost": cost,
        "basis": "history_avg",
    }
