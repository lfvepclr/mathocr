# MathOCR 集成 Ruff + ty 并启动验证

## 摘要与已确认决策

- **工具**: Ruff 0.16.1（lint + format）+ ty 0.0.65（类型检查，Astral 出品，beta）。实测现状: `ruff check` 126 错误（60 可自动修复）、`ruff format` 37 文件待格式化、`ty check` app 内 16 诊断（另 backup/ 旧代码 16 个需排除）。
- **规则集**: 采用 Ruff 0.16 默认全规则集，手动修复全部非自动修复项（用户已确认）。
- **DTZ005 豁免**: `datetime.now()` 无时区 14 处保持本地时间，配置忽略（用户已确认，单机本地工具）。
- **安装方式约束**: 不能用 `uv add --dev`/`uv sync`（会移除未声明的 paddlepaddle，AGENTS.md 排查 1）。改用 `[dependency-groups]` 声明 + `uv lock` 更新锁文件 + `uvx ruff`/`uvx ty` 运行，.venv 与 paddle 零接触。
- **排除范围**: backup/（旧代码备份）、batches/、.venv/、testset/ 不参与检查。
- **line-length = 100**（实测 >100 行仅 11 处，贴合现有风格）。

## 阶段 1: 配置声明（pyproject.toml + uv.lock）

1. `pyproject.toml` 追加：
   - `[dependency-groups]` → `dev = ["ruff>=0.16", "ty>=0.0.65"]`
   - `[tool.ruff]`: `line-length = 100`、`target-version = "py313"`、`exclude = ["backup", "batches", "testset", ".venv"]`、`extend-exclude` 无需
   - `[tool.ruff.lint]`: `ignore = ["DTZ005"]`（本地时间决策）；`preview` 不开启
   - `[tool.ruff.format]`: 默认（`quote-style = "double"` 等不写，跟默认）
   - `[tool.ty]`: `python-version = "3.13"`、`exclude = ["backup", "batches", "testset"]`（ty 无默认 exclude，必须显式）
2. `uv lock` 更新 uv.lock（仅锁文件，不触碰 .venv）。
3. 验证: `uvx ruff --version`、`uvx ty --version` 可用。

## 阶段 2: 自动修复 + 格式化

1. `uvx ruff check --fix .` — 60 个安全修复（F401 未用导入、I001 导入排序、F541 空 f-string、RUF100 无用 noqa、UP024 os 别名、FURB167 正则标志等）。
2. `uvx ruff format .` — 37 个文件统一格式（纯格式，无行为影响）。
3. `uvx ruff check .` 复核，剩余约 66 处进入阶段 3。

## 阶段 3: 手动修复剩余 lint（按类逐处）

- **BLE001 盲捕获 21 处**: 逐处审查。内部逻辑（engines/、services/）改具体异常（KeyError/ValueError/requests.RequestException 等）;API 边界兜底（app/api/*.py 请求处理、main.py）保留 `except Exception` + `# noqa: BLE001` 注释说明"边界兜底防 500"。
- **S110/S112 try-except-pass/continue 8 处**: 消除可消除的（空分支补注释或收敛异常）;确需吞异常的加 `# noqa: S110` + 理由注释。
- **PIE810 6 处**: `startswith/endswith` 单参调多次改元组传参。
- **SIM115 5 处**: `open()` 无 with 改 `with open(...) as f`。
- **RUF059 4 处**: 未用解包变量改 `_` 前缀。
- **UP031 4 处**: `%` 格式化改 f-string。
- **C408 2 处、ISC004 2 处、UP024 等其余**: 逐处修。
- 修完删残留 `# noqa`（RUF100 会再报则一并清）。

## 阶段 4: ty 类型诊断修复（16 处 app/ + tests/）

- **unresolved-import `settings_store`**（engines/baidu.py 延迟 import 残留）: 改 `from app.services import settings_store`。
- **PIL `Image.LANCZOS` 2 处**（image_annotator.py）: 改 Pillow 10+ 推荐 `Image.Resampling.LANCZOS`。
- **`FreeTypeFont.getsize`**（image_annotator.py）: 改 `getbbox()`。
- **None union append 类 4 处**（exporter.py / batch_manager.py 列表字段）: 补类型注解与初始化（`Optional` 改为显式 `[]` 或函数签名标注）让收窄成立。
- **invalid-argument-type / unsupported-operator / invalid-return-type 各 1-2 处**: 定位后修注解或逻辑。
- **tests monkeypatch `_download = lambda`**（tests/test_layout_render.py:121）: `# ty: ignore[invalid-assignment]` + 注释（测试刻意替换）。
- 个别 ty beta 误报: `# ty: ignore[rule]` + 理由注释,并在 AGENTS.md 记录。
- 目标: `uvx ty check app server.py tests` → 0 diagnostics。

## 阶段 5: 启动验证（用户要求的"启动验证"）

1. 静态: `uvx ruff check .` = 0 errors;`uvx ruff format --check .` 全绿;`uvx ty check .` = 0。
2. 单测: `.venv/bin/python tests/test_layout_render.py` + `tests/test_richtext_multi.py` 26 例全过。
3. 服务: 启动 `.venv/bin/python server.py --port 7861`（先查端口占用,旧进程先 kill）;curl 冒烟 `/`、`/api/batches`、`/api/settings`、`/api/engines`、`/api/legend` 均 200。
4. 真实流水线冒烟: 上传 `testset/` 一张小图 POST /api/upload,等待队列处理到 completed,页面 API 200（验证 BLE001/异常处理改动未破坏 OCR 流水线）;完成后删除该测试批次（或保留在 batches/ 由用户自行清理,执行期视情况）。
5. 前端零改动,`static/` 构建产物不受影响。

## 阶段 6: 文档

- `AGENTS.md`: 开发环境节加 ruff/ty 命令（`uvx ruff check` / `uvx ruff format` / `uvx ty check`）;排查节更新: "uv sync 会移除 paddle,dev 工具走 uvx + dependency-groups"（并入排查 1）;记录 DTZ005 豁免决策与 ty beta 说明。
- `README.md`: 开发命令补 lint 检查一行。

## 风险

- `ruff format` 触及 37 文件: 纯格式改动,单测 + 冒烟兜底。
- BLE001 修复需逐处看语义,防止边界 catch 改坏导致 500 直出——API 边界保留兜底。
- ty 为 beta,个别误报用 ignore 注释并记录理由,不硬改逻辑。
- 全程不运行 `uv sync`/`uv add`/`uv run`(会移除 paddle);验证一律 `.venv/bin/python` + `uvx`。
