"""Settings, engines, usage, and legend APIs."""

import logging

from robyn import Request, jsonify

from app.engines import registry as engine_registry
from app.services import settings_store
from app.services.image_annotator import generate_legend

logger = logging.getLogger(__name__)


def register(app):
    @app.get("/api/legend")
    def get_legend(request: Request):
        qp = request.query_params
        mode = (qp.get("mode", "score") if qp else "score") or "score"
        return jsonify(generate_legend(mode))

    @app.get("/api/engines")
    def list_engines(_request: Request):
        return jsonify(
            {
                "engines": engine_registry.list_engines(),
                "default": engine_registry.default_engine(),
            }
        )

    @app.get("/api/settings")
    def get_settings(_request: Request):
        return jsonify(engine_registry.settings_view())

    @app.post("/api/settings")
    def post_settings(request: Request):
        try:
            payload = request.json()
        except (ValueError, TypeError):
            return jsonify({"error": "Invalid JSON"})
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid payload"})
        updated = engine_registry.apply_settings(payload)
        return jsonify(
            {
                "updated": updated,
                "settings": engine_registry.settings_view(),
                "engines": engine_registry.list_engines(),
            }
        )

    @app.get("/api/usage")
    def get_usage(request: Request):
        qp = request.query_params
        scope = (qp.get("scope", "all") if qp else "all") or "all"
        if scope not in ("today", "month", "all"):
            return jsonify({"error": f"Unknown scope: {scope}"})
        data = settings_store.aggregate(scope)
        names = {e: meta["name"] for e, meta in engine_registry.ENGINES.items()}
        for row in data["engines"]:
            row["name"] = names.get(row["engine"], row["engine"])
        return jsonify(data)

    @app.get("/api/usage/batch/:batch_id")
    def get_batch_usage(request: Request):
        batch_id = request.path_params["batch_id"]
        return jsonify(settings_store.aggregate_batch(batch_id))

    @app.get("/api/usage/estimate")
    def estimate_usage(request: Request):
        qp = request.query_params
        engine = (qp.get("engine", None) if qp else None) or engine_registry.default_engine()
        if engine not in engine_registry.ENGINES:
            return jsonify({"error": f"未知的 OCR 引擎: {engine}"})
        try:
            pages = int((qp.get("pages", "1") if qp else "1") or "1")
        except ValueError:
            return jsonify({"error": "pages must be an integer"})
        return jsonify(engine_registry.estimate_cost(engine, max(0, pages)))
