# 多引擎 OCR：本地 + 硅基流动 + 百度

## 摘要

`ocr_engine.py` 从"单一本地 pipeline"改为**引擎分发器**，新增两个远程引擎模块、一个设置/用量存储模块、一个引擎注册表。批次表记录 engine 与费用，前端新增设置面板、上传时引擎选择、用量与费用展示。本地引擎行为保持完全不变。

### 已核实的关键事实（决定实现方式）

- Spotting 输出格式（`paddlex/inference/pipelines/paddleocr_vl/uilts.py:1111-1183`）：
  `<|TEXT_START|>文本<|TEXT_END|><|LOC_BEGIN|>` + 8 个 `<|LOC_n|>`（4 个点）+ `<|LOC_END|>`，坐标归一化到 **0–1000**。存在一条 fallback 解析路径（连续 8 个 LOC token，文本取其前的 span）。
- Spotting 预处理（同文件 `pre_process_for_spotting`）：`w<1500 且 h<1500` 时 LANCZOS 放大 2 倍；`max_pixels=1605632`。
- 硅基流动模型 id：`PaddlePaddle/PaddleOCR-VL-1.5`，定价页当前为免费。
- 百度：异步双接口 `POST /rest/2.0/brain/online/v2/paddle-vl-parser/task` → `.../task/query`（提交 QPS 2，查询 QPS 5，建议 5–10s 轮询），返回自有 JSON（`pages[].layouts[].position=[x,y,w,h]`、`tables[].markdown`、`images[].data_url`、`meta.page_width/page_height`），**无置信度分数**。

### 明确的能力边界（需在 UI 上如实标注）

| 引擎 | markdown 结构 | bbox 蒙层 | 置信度 | 插图提取 | 表格/公式 |
|---|---|---|---|---|---|
| 本地 pipeline | 完整 | 有 | 有（版面检测 score） | 有 | 结构化 |
| 硅基流动（Spotting） | 行级纯文本 | 有（4 点多边形） | **无** | **无** | **无结构，按行文本** |
| 百度文档解析 | 完整（含表格 md） | 有（矩形） | **无** | 有（data_url 下载） | 结构化 |

---

## 新增模块

### `settings_store.py`

独立 sqlite 连接（同 `batches/metadata.db`）+ 自己的 `RLock`，避免与 `batch_manager` 产生 import 循环。

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  batch_id TEXT, file_id TEXT, page_id INTEGER,
  engine TEXT NOT NULL,
  calls INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  billed_pages INTEGER DEFAULT 0,
  cost REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage(ts);
CREATE INDEX IF NOT EXISTS idx_api_usage_batch ON api_usage(batch_id);
```

函数：`get(key, default)` / `set(key, value)` / `get_all()`；`record_usage(...)`；`aggregate(scope)`（scope=`today`/`month`/`all`，按 engine 分组返回 calls/tokens/billed_pages/cost）；`aggregate_batch(batch_id)`。

### `engine_registry.py`

引擎描述 + 配置解析（**环境变量作默认值，settings 表覆盖**）+ 可用性判定 + 费用计算。

```python
ENGINES = {
    "local": {"name": "本地 PaddleOCR-VL-1.6", "billing": "free", "requires_key": False},
    "siliconflow": {"name": "硅基流动 PaddleOCR-VL", "billing": "token", "requires_key": True},
    "baidu": {"name": "百度文档解析", "billing": "page", "requires_key": True},
}
```

环境变量默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OCR_DEFAULT_ENGINE` | `local` | 默认引擎 |
| `SILICONFLOW_API_KEY` | — | 必填 |
| `SILICONFLOW_BASE_URL` | `https://api.siliconflow.cn/v1` | |
| `SILICONFLOW_MODEL` | `PaddlePaddle/PaddleOCR-VL-1.5` | |
| `SILICONFLOW_MAX_CONCURRENCY` | `4` | 单文件内页级并发 |
| `SILICONFLOW_PRICE_IN` / `_OUT` | `0` / `0` | CNY / 1M tokens（当前免费） |
| `BAIDU_OCR_API_KEY` / `BAIDU_OCR_SECRET_KEY` | — | 必填 |
| `BAIDU_PRICE_PER_PAGE` | `0` | CNY/页，**默认 0，需用户在设置中按自己的计费方案填写** |

函数：`list_engines()`（含 `configured` 布尔）、`get_config(engine)`、`default_engine()`、`compute_cost(engine, prompt_tokens, completion_tokens, billed_pages)`、`estimate_cost(engine, pages)`（token 计费引擎用 `api_usage` 历史均值/页，无历史时返回 `None` 并标注"暂无历史数据"）。

Key 的读写规则：`GET /api/settings` 只返回掩码（`sk-****abcd`）+ `configured`；`POST` 时空字符串表示不修改。

### `engine_siliconflow.py`

```python
def process_pages_iter(page_images: list[str], cfg: dict, on_usage) -> Iterator[tuple[int, dict]]
```

单页流程：
1. PIL 打开，记下**原始** `(w, h)`（坐标反归一化用它）。
2. `w<1500 and h<1500` → LANCZOS ×2；随后若 `w*h > 1_605_632` 按比例缩小（对齐 `pre_process_for_spotting` 与 `max_pixels`）。
3. 编码为 JPEG(q=90) data URI。
4. `urllib.request` POST `{base_url}/chat/completions`（不引入新依赖，与 `ocr_engine.py` 现有 urllib 用法一致）：
   ```json
   {"model": "<cfg.model>", "temperature": 0, "max_tokens": 8192,
    "messages": [{"role": "user", "content": [
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}},
      {"type": "text", "text": "Spotting:"}]}]}
   ```
   `Authorization: Bearer <key>`，timeout 300s，429/5xx/超时重试 3 次（指数退避 2/4/8s）。
5. 本模块内自实现 spotting 解析（**复制** `uilts.py` 的正则逻辑，不 import paddlex，使远程模式不依赖 paddle）：
   `ANNOT_TEXT_RE`、`LOC_BLOCK_RE`、`LOC_ITEM_RE`，取前 8 个整数 → 4 点 → `p/1000*w`、`p/1000*h`；主路径无结果时走 fallback。
6. 组装与本地同构的 `page_result`：
   - `markdown_text` = 各行文本 `"\n\n".join(...)`
   - `images` = `{}`
   - `json_data = {"res": {"width": w, "height": h, "engine": "siliconflow", "has_score": false,
     "parsing_res_list": [{block_label:"text", block_content, block_bbox:[x1,y1,x2,y2], block_polygon_points: pts, block_id:i+1, block_order:i+1}],
     "layout_det_res": {"boxes": [{label:"text", order:i+1, coordinate:[...], polygon_points: pts}]}}}`
     — **不写 `score` 键**，下游据此进入类型着色模式。
   - `page_data` 由 `ocr_engine._extract_page_data(json_data)` 统一提取（复用现有函数，零改动）。
7. `on_usage(calls=1, prompt_tokens=usage.prompt_tokens, completion_tokens=usage.completion_tokens)`。

**页级并发**：远程无共享 pipeline 限制，用 `ThreadPoolExecutor(max_concurrency)` 提交全部页，**按 index 顺序 yield**（`futures[i].result()`），保证 `_process_single_file` 的落盘与 SSE 顺序不变。批次间/批次内文件仍串行（队列不动）。

### `engine_baidu.py`

- `_get_access_token(ak, sk)`：`POST https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=&client_secret=`，模块内缓存 + 落 `settings`（`baidu_access_token` / `baidu_token_expire_at`）以便重启复用。
- `process_file_iter(file_path, cfg, on_usage)`：
  1. 提交：`POST .../paddle-vl-parser/task?access_token=`，`Content-Type: application/x-www-form-urlencoded`，body `file_data`(base64) + `file_name`，选项 `analysis_chart=True`、`merge_tables=True`、`relevel_titles=True`、`recognize_seal=True`。
  2. 轮询：`POST .../paddle-vl-parser/task/query`，间隔 6s，最长 30 分钟；`status` 非 `success` 且非进行中 → 抛错（带 `error_msg`/`task_error`）。
  3. 下载 `parse_result_url` 的 JSON。
  4. 逐页适配后 yield `(page_idx, page_result)`。
- 页适配：
  - `width/height` ← `meta.page_width/page_height`
  - `position [x,y,w,h]` → `block_bbox = [x, y, x+w, y+h]`；有 `polygon` 时一并带上
  - 类型映射（Baidu type → 平台 label）：`doc_title→doc_title`，`paragraph_title/title→paragraph_title`，`text/aside_text/vertical_text→text`，`display_formula→formula`，`inline_formula→text`，`table→table`，`image/header_image/footer_image→image`，`chart→chart`，`seal→seal`，其余（`header/footer/number/footnote/reference/reference_content/content/abstract/algorithm/figure_title/formula_number`）保留原名
  - `table` 块内容 ← `tables[]` 按 `layout_id` 匹配的 `markdown`
  - `image` 块：下载 `data_url` → PIL 放入 `images` 字典，键名 `page_{n}_img_{k}.png`，块内容写 `<img src="page_{n}_img_{k}.png">`（正好匹配 `batch_manager._process_single_page` 现有的 `src="..."` 重写逻辑）
  - `markdown_text`：按 layouts 顺序拼装 —— 标题按 `sub_type` 层级输出 `#`/`##`/`###`（与本地 paddle 的整页 md 带 `#` 的约定一致），`display_formula` 包 `$$...$$`，表格原样插入，图片插 `<img>`，其余纯文本
  - `layout_det_res.boxes`：同坐标 + 映射后的 label + `order`，**无 `score` 键**
  - `json_data.res` 附 `engine:"baidu"`、`has_score:false`
- 计费：`on_usage(calls=1, billed_pages=len(pages))`，cost = 页数 × `BAIDU_PRICE_PER_PAGE`。
- 输入校验：仅放行百度支持的扩展名，PDF 提前用 `pdf_renderer.get_page_count` 检查 ≤500 页、文件 ≤100MB，超限直接给出明确错误。

---

## 改造现有文件

### `ocr_engine.py`

- 现有本地实现整体保留，`process_document_iter` 更名为 `_local_process_document_iter`。
- 新的分发器（`batch_manager` 唯一入口）：
  ```python
  def process_document_iter(file_path, *, engine="local", page_images=None, on_usage=None):
      if engine == "local":
          yield from _local_process_document_iter(file_path)
      elif engine == "siliconflow":
          yield from engine_siliconflow.process_pages_iter(page_images, cfg, on_usage)
      elif engine == "baidu":
          yield from engine_baidu.process_file_iter(file_path, cfg, on_usage)
      else:
          raise ValueError(...)
  ```
- 远程引擎模块**延迟 import**（函数内），保证选远程引擎时不触发 paddle 初始化。
- `_extract_page_data` 与 `get_pipeline` 不动。

### `batch_manager.py`

- `_EXPECTED_COLUMNS` 登记新列（`_migrate_columns` 自动补齐老库，AGENTS.md 已有此约定）：
  - `batches`: `engine TEXT DEFAULT 'local'`、`api_calls INTEGER DEFAULT 0`、`prompt_tokens INTEGER DEFAULT 0`、`completion_tokens INTEGER DEFAULT 0`、`billed_pages INTEGER DEFAULT 0`、`cost REAL DEFAULT 0`
  - `pages`: `api_calls INTEGER DEFAULT 0`、`prompt_tokens INTEGER DEFAULT 0`、`completion_tokens INTEGER DEFAULT 0`、`cost REAL DEFAULT 0`
  - 同步在 `CREATE TABLE` 语句中补上（新库）。
- `create_batch(uploaded_files, engine="local")` → INSERT 写入 `engine`。
- `get_batch()` / `list_batches()` 的 SELECT 增列并出现在返回 dict 中（`get_batch_summary` 用 `**batch` 展开，自动流向前端）。
- `_process_single_file`：
  1. 读取 `batch["engine"]`。
  2. `prepare_original_images` 之后立刻发 `cost_estimated` 事件 `{file_id, pages, engine, estimated_cost}`。
  3. 定义 `on_usage` 回调 → `settings_store.record_usage(...)` + 累加到 `batches`/`pages` 行 + 发 `usage_recorded` 事件 `{engine, calls, tokens, cost, batch_cost}`。
  4. 调 `ocr_engine.process_document_iter(str(file_path), engine=engine, page_images=original_images, on_usage=on_usage)`。
  5. `page_started` 事件增加 `stage` 字段（baidu 期间为 `"远程任务解析中"`），并且远程引擎的 `avg_page_time` 用该引擎的历史均值（`get_avg_page_time` 增加 `engine` 参数，按引擎分别统计）。
- `reset_interrupted_tasks` 不改：`engine` 存在 batches 行上，恢复后按原引擎续跑。

### `image_annotator.py`

- 新增 `LABEL_COLORS`（`text` 蓝 / `paragraph_title`·`doc_title` 紫 / `table` 橙 / `formula` 青 / `image`·`chart` 绿 / `seal` 红 / 其他 灰）+ `get_label_color(label)`。
- `annotate_image`：若所有 box 都没有 `score` 键 → 类型着色模式，标签只画类型名（不画分数）；否则保持现有置信度模式。
- `generate_legend(mode="score")` 增加 `mode="label"` 返回类型图例。

### `server.py`

- `POST /api/upload`：从 **query param** 读 `engine`（`qp.get("engine", None)`，Robyn 非文件表单字段解析不可靠）；缺省用 `engine_registry.default_engine()`；引擎未配置 → `jsonify({"error": "引擎 xxx 未配置 API Key"})`；`create_batch(..., engine=engine)`。
- 新端点：
  - `GET /api/engines` → 引擎列表（`id/name/billing/requires_key/configured/price/note/limitations`）
  - `GET /api/settings` / `POST /api/settings`（Key 掩码返回；空串=不修改）
  - `GET /api/usage?scope=today|month|all` → 按引擎分组 + 合计
  - `GET /api/usage/estimate?engine=&pages=` → 预估费用（无历史时返回 `null` + 说明）
  - `GET /api/legend?mode=label` → 类型图例
- `/api/batch/:batch_id/file/:file_id/page/:page_id` 返回体增加 `engine`、`has_score`（从 `json.res` 读取，缺省 `local`/`true`）。
- 全局 SSE 事件类型表增加 `cost_estimated`、`usage_recorded`（`event_bus` 无需改动，`publish` 已通吃）。

### 前端

- `static/index.html`
  - 侧边栏 header 加齿轮「设置」按钮
  - 上传区：`#engine-select` 分段控件（本地 / 硅基流动 / 百度）+ `#engine-note`（能力边界与计费说明）+ `#cost-estimate`
  - 上传区：`#usage-card`（今日 / 本月 / 累计的调用次数与费用，按引擎分行）
  - `#settings-modal`（默认引擎、各引擎 Key/BaseURL/模型名/并发、单价）
  - `#label-legend` 类型图例块（与 `#confidence-legend` 二选一显示）
  - 引入 `<script src="/static/js/settings.js">`
- **新增** `static/js/settings.js`：`Settings` 模块 —— 加载 `/api/engines` 与 `/api/settings`、保存、渲染用量卡片、弹窗交互；引擎选择存 `localStorage` 并回填。
- `static/js/upload.js`：上传 URL 改为 `/api/upload?engine=<selected>`；`QueuePanel` 卡片显示引擎徽标 + 实时费用；`handleEvent` 处理 `cost_estimated` / `usage_recorded`。
- `static/js/app.js`：`initGlobalEvents` 的事件类型数组补 `cost_estimated`、`usage_recorded`；转发给 `QueuePanel` 与 `Settings.onUsage`。
- `static/js/sidebar.js`：批次条目显示引擎徽标 + 该批次费用。
- `static/js/viewer.js`：`has_score === false` 时蒙层类名走 `LABEL_CLASS_MAP`（`t-text`/`t-title`/`t-table`/`t-formula`/`t-image`/`t-other`），tooltip 只显示类型名；顶栏显示本批次引擎与费用；根据 `has_score` 切换两个图例块。
- `static/css/style.css`：引擎徽标、分段控件、用量卡片、设置弹窗、`t-*` 类型色。
- `vendor.js` / bun 构建无需改动（不新增前端依赖）。

### 文档

- `AGENTS.md`：新增「引擎抽象层」小节（三引擎对比表、能力边界、分发入口）、`settings`/`api_usage` 表说明、新环境变量表、"新增列必须登记 `_EXPECTED_COLUMNS`" 提醒、"远程引擎模块禁止 import paddlex（保持免 paddle 依赖）"约定。
- `README.md`：三引擎配置与选择说明。

---

## 测试计划

1. **本地引擎回归**（无 Key 也能跑）：`testset/Weixin Image_20260718224411_18_1.jpg`、`testset/pdf_test.pdf` —— markdown、SVG 蒙层联动、置信度标注图、Word/Markdown 导出与改动前一致。
2. **老库迁移**：直接用现有 `batches/metadata.db` 启动，确认自动 ALTER 出新列、无 `no such column`。
3. **未配置校验**：未填 Key 时选远程引擎上传 → 返回明确错误、不创建批次。
4. **硅基流动**（需你提供 API Key）：单图先跑 —— 校验 spotting 解析出的行数与框位置、类型着色图例、tokens/调用次数/费用入库；再跑多页 PDF 校验并发下页序正确、无错页。
5. **百度**（需你提供 AK/SK）：单图 + `testset/pdf_test.pdf` —— 校验 layouts→蒙层坐标、表格 markdown、插图 data_url 下载与 md 内 `src` 重写、按页计费；轮询超时/失败路径给出可读错误。
6. **用量统计**：跑完后核对 `/api/usage?scope=today|all` 与 `api_usage` 明细、批次卡片费用一致。
7. **中断恢复**：远程批次处理中 kill 服务 → 重启后按原 `engine` 续跑，已完成页跳过。

## 假设

- 硅基流动 `PaddlePaddle/PaddleOCR-VL-1.5` 目前免费，价格默认 0；设置面板可填单价以便未来收费后统计。
- 百度单价我无法核实，默认 0，设置面板要求你按自己的计费方案填写 CNY/页，界面在未填时显示"未配置单价"而非编造数字。
- 硅基流动路径按你的选择实现为**纯远程 Spotting**：表格/公式结构、插图提取、置信度均不可用，UI 会如实标注。若后续想要与本地同等的解析质量，可再加 `remote-hybrid`（本地版面检测 + 远程识别）模式。