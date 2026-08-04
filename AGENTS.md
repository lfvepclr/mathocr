# AGENTS.md — AI 代理交接文档

本文档为后续 AI 代理(模型)提供项目上下文,帮助快速理解和迭代开发。

## 项目概述

MathOCR 是基于 PaddleOCR-VL 的文档智能解析平台。用户上传 PDF/图片,系统按持久化队列串行 OCR 识别,生成带置信度色块标注的原图对比和分块 Markdown 结果(SVG 蒙层双向联动 + 块级复制 + 双面板框选多选),首页任务队列实时显示进度,支持历史批次管理、Word(LaTeX→Unicode)/Markdown(base64 图片内嵌)/版面 HTML(绝对定位还原布局,可打印)导出,以及一键复制到 Word 的整页/块级/框选富文本。结果区支持「流式|版面」双视图,版面模式按 bbox 绝对定位还原原文档布局。

识别引擎可选 **本地 PaddleOCR-VL-1.6**、**硅基流动在线 API**、**百度文档解析在线 API**;在线引擎按批次记录调用次数与费用,首页展示今日/本月/累计用量。

## 架构

```
用户浏览器 ←→ Robyn (Rust HTTP) ←→ Python 后端
                    ↓
              Job Queue (SQLite 持久化队列,单工作线程,重启恢复)
                    ↓
              Batch Manager (SQLite + 文件系统) — 批次内文件串行处理
                    ↓
              ocr_engine.process_document_iter(engine=...)  ← 引擎分发器
                ├─ local        PaddleOCR-VL-1.6 本地 pipeline (完整版面解析)
                ├─ siliconflow  engine_siliconflow  整页 Spotting 远程识别
                └─ baidu        engine_baidu        云端异步整档解析
                    ↓
              Event Bus (批次频道 + "*" 全局频道) → SSE → 浏览器实时更新
```

### 数据流

1. 用户上传文件 → `POST /api/upload?engine=<id>` → `batch_manager.create_batch(files, engine)` → `job_queue.enqueue()`(发布 `batch_queued` 事件)
2. Job Queue 工作线程 → `batch_manager.process_batch_background()`(从 batches 行读回 `engine`)
3. 批次内文件**串行**处理: PDF渲染 → 发 `cost_estimated` → `ocr_engine.process_document_iter(engine=...)` 流式逐页 → 每页保存JSON/MD/图片 → 标注原图 → 写SQLite
4. 每页完成 → `event_bus.publish("page_completed")` → 批次 SSE + 全局 SSE 推送 → 侧边栏/队列面板/上传进度实时更新
5. 在线引擎每次 API 调用 → `on_usage()` → 写 `api_usage` 表 + 累加 batches 行 → 发 `usage_recorded` → 前端实时更新费用
6. 批次完成 → `event_bus.publish("batch_completed")` → 前端自动跳转结果页(侧边栏拖入创建的任务不跳转,仅刷新状态)
7. 服务器重启 → `job_queue.recover_interrupted()` 重新入队中断批次,已完成页面自动跳过(resume guard),按原 `engine` 续跑

## 核心文件

### 后端

| 文件 | 职责 | 关键函数 |
|------|------|----------|
| `server.py` | Robyn HTTP 服务器,所有 API 端点 | `upload()`, `global_events()` (全局 SSE), `batch_events()` (SSE), `set_batch_alias()`, `list_engines()`, `post_settings()`, `get_usage()`, `page_richtext()` |
| `batch_manager.py` | 批次/文件/页面 CRUD,后台 OCR 流水线(串行),用量累加 | `create_batch()`, `process_batch_background()`, `_process_single_file()`, `_process_single_page()`, `accumulate_batch_usage()` |
| `ocr_engine.py` | 引擎分发器 + 本地 PaddleOCR-VL 封装 | `process_document_iter(engine=, page_images=, on_usage=)`, `get_pipeline()`, `_extract_page_data()` |
| `engine_registry.py` | 引擎描述表、配置解析(env 默认 + settings 覆盖)、费用计算、本地运行时探测 | `list_engines()`, `get_config()`, `is_configured()`, `compute_cost()`, `estimate_cost()`, `apply_settings()`, `local_runtime_available()` |
| `engine_siliconflow.py` | 硅基流动纯远程 Spotting 引擎(不依赖 paddle) | `process_pages_iter()`, `parse_spotting()`, `_prepare_image()` |
| `engine_baidu.py` | 百度异步文档解析引擎 + 结果适配(不依赖 paddle) | `process_file_iter()`, `_adapt_page()`, `_get_access_token()` |
| `settings_store.py` | `settings` KV 表 + `api_usage` 明细表(独立连接) | `get()`, `set()`, `record_usage()`, `aggregate()`, `aggregate_batch()` |
| `image_annotator.py` | 原图标注 (bbox + 置信度色块 / 块类型色块) | `annotate_image()`, `get_confidence_color()`, `get_label_color()`, `generate_legend(mode)` |
| `pdf_renderer.py` | PDF 页面渲染 (PyMuPDF) | `render_pdf_pages()`, `prepare_original_images()` |
| `exporter.py` | Markdown(base64 图片内嵌) / Word / 版面 HTML 导出,页面富文本生成 | `export_word()`, `export_markdown()`, `export_layout_html()`, `page_to_richtext()`, `_resolve_image_src()` |
| `latex_utils.py` | LaTeX → Unicode 符号转换 (Word 导出) | `latex_to_unicode()`, CLI: `python latex_utils.py <dir>` 扫描漏网命令 |
| `event_bus.py` | SSE 事件总线 (进程内, `"*"` 全局订阅) | `subscribe()`, `publish()` (注入 batch_id) |
| `job_queue.py` | SQLite 持久化任务队列 (单工作线程) | `enqueue()` (发 `batch_queued`), `recover_interrupted()` |

### 前端

| 文件 | 职责 |
|------|------|
| `static/index.html` | 主页面结构 (侧边栏 + 引擎选择器 + 上传/结果视图 + 任务队列 + 用量卡片 + 设置弹窗 + FAB) |
| `static/css/style.css` | 全部样式 (CSS变量 + 侧边栏收起 + 蒙层/分块/队列卡片/FAB 弧形/引擎选择器/用量表/弹窗) |
| `static/js/app.js` | 主协调器 (状态管理,路由,全局 SSE `initGlobalEvents()` 分发) |
| `static/js/settings.js` | 引擎选择器、设置弹窗、用量与费用展示 (`Settings`) |
| `static/js/sidebar.js` | 批次列表,批次级实时进度 (`handleGlobalEvent`),别名管理,引擎徽标 |
| `static/js/upload.js` | 拖拽上传(带 `?engine=`),SSE实时进度 (含轮询降级),`QueuePanel` 首页任务队列面板 |
| `static/js/viewer.js` | 对比查看器 (流式/版面双视图,分块渲染,SVG 蒙层联动,复制到 Word 富文本 + 块级复制 + 双面板框选多选复制,滚轮/捏合缩放,全屏,锚块同步滚动,KaTeX,图例切换) |
| `static/src/vendor.js` | Bun 打包入口 (marked.js + KaTeX) |

## 关键设计决策

### SQLite 而非 DuckDB
- DuckDB 是 OLAP 分析型数据库,本场景是简单 CRUD
- SQLite 内置于 Python 标准库,零额外依赖
- SQLite 原生支持 `INTEGER PRIMARY KEY AUTOINCREMENT`
- 连接: `sqlite3.connect(path, check_same_thread=False)` + `RLock` 保证线程安全

### SSE 而非 WebSocket
- SSE 是单向推送 (服务器→客户端),适合进度通知场景
- 基于 HTTP,无需特殊协议,浏览器原生 `EventSource` 支持
- Robyn `StreamingResponse` + 生成器 yield 实现
- 降级: SSE 连接失败时自动回退到 2 秒轮询

### SQLite schema 自动迁移
- `_init_db` 在建表后调用 `_migrate_columns`: 对照 `_EXPECTED_COLUMNS` 声明式列清单,用 `PRAGMA table_info` 检测缺失列并 `ALTER TABLE ADD COLUMN` 补齐
- 幂等、仅增补(不改既有数据),解决 `CREATE TABLE IF NOT EXISTS` 不会给老库加新列导致的 `no such column` 崩溃;新增列时只需在 `_EXPECTED_COLUMNS` 中登记

### SQLite 持久化队列而非 Celery/Redis
- 单进程场景,无需分布式队列;队列状态存于 batches 表 status 列(queued/processing/completed/error)
- 单工作线程 FIFO;`threading.Event` 唤醒避免轮询延迟
- 重启后 `recover_interrupted()` 将 processing 状态批次重新入队;已完成的文件/页面全部跳过(resume guard),仅中断中的当前文件会整篇重跑(VLM 推理无法从中间页续跑),但已持久化页结果保留不丢
- worker 拾起批次时发布 `batch_started` 全局事件(前端即刻翻转 排队→处理中);`/api/batches` 对 processing 与 queued 均附加 `progress` 快照,刷新页面后立即显示百分比

### 批次内文件串行而非并行
- PaddleOCR-VL pipeline 的 `predict_iter` 非线程安全,多 worker 并发调用共享 pipeline 会崩溃(实测多图上传报错)
- 改为串行 for 循环逐文件处理;用户明确指示"如果无法并行,就按队列顺序执行"

### 全局 SSE 频道
- `event_bus.publish()` 将事件同时投递给批次订阅者和 `"*"` 全局订阅者,payload 注入 `batch_id`
- `GET /api/events` 全局流:前端 App 单连接驱动侧边栏批次进度 + 首页 `QueuePanel`,刷新页面后自动恢复实时更新
- 单批次流 `GET /api/events/:batch_id` 保留给上传大进度条/时间估算
- `job_queue.enqueue()` 发布 `batch_queued`,新任务即时出现在侧边栏与队列面板

### 蒙层联动数据结构
- 前端蒙层/分块渲染数据来自页面 API 返回的 `json.res.parsing_res_list`(块)与 `json.res.layout_det_res.boxes`(置信度)
- 两者按 `box.order === block.block_order` 配对;坐标系用 json 的 `width/height`,SVG `viewBox` + `preserveAspectRatio="none"` 自适应显示尺寸
- 标题块 `block_content` 无 `#` 前缀(paddlex 拼接整页 md 时才加),前端按 `data-label` 用 CSS 补标题样式

### 框选复制 (lasso,双面板)

- 左面板 `#select-mode-btn` 与右面板 `#select-mode-btn-r` 共用同一 `Viewer.selectMode`:开启时 `#image-container` 与 `#markdown-container` 都加 `select-mode` 类(crosshair + `user-select:none`),并自动切到原始图片模式(标注图下蒙层隐藏无法命中);再点任一按钮或 Esc 退出
- 橡皮筋: 左侧 `#select-band` 是 `#image-wrapper` 内百分比定位的 div,随缩放同步,无需坐标换算;右侧 `#select-band-r` 是 `#markdown-container`(`position:relative`)内 px 定位的 div,按容器内容坐标定位(含 scrollLeft/scrollTop),随内容滚动
- 命中规则:位移 <5px 视为点击 → 左侧命中的 polygon 块 toggle、右侧 `e.target.closest('.md-block,.layout-block')` toggle;否则左侧框选矩形与 `block_bbox` 求交(不用多边形精确命中,边缘误选由点击取消兜底),右侧与当前视图块元素的 `getBoundingClientRect()` 求交;命中的块都并入 `Viewer.selectedBlocks`(Set,翻页清空)
- 选中态 `sel` 类(橙色,与 hover 蓝色区分)三侧同步:SVG polygon / `#markdown-content .md-block` / `#layout-content .layout-block`,由 `renderSelection()` 统一刷新
- 浮动条 `#selection-bar`(左面板底部,两面板共用):`已选 N 块` +「复制到 Word」+「清空」;复制 fetch `?blocks=[...]` → `ClipboardItem({text/html, text/plain})`,失败降级为选中块 `block_content` 纯文本拼接
- 共存规则:select 模式下 hover 不弹块级复制按钮(`setHover` 判断)但保留高亮;Esc 先清空选中再退出模式;缩放与同步滚动不受影响

### 版面视图与版面 HTML

- 前端结果区「流式|版面」开关(`viewer.viewMode`,localStorage `ocr_view_mode`):版面模式把每个块按 `block_bbox` 百分比绝对定位在 `aspect-ratio: w/h` 画布上,文字块字号 shrink-to-fit(初值按 bbox 估算,×0.92 迭代 ≤15 次,下限 6px;仅跳过纯图片块,含插图表格照常 fit);hover 联动、块级复制与流式视图完全共用
- 缩放解耦: 图片面板默认适应宽度(`Viewer.fitZoom` = (容器宽−32)/原图宽,图片 load 后及窗口 resize 时在未手动缩放(`_userZoomed`)下重算,重置按钮回 fit);版面画布用独立的 `Viewer.layoutZoom`(仅右面板 Ctrl/⌘+滚轮),`zoomAt` 按目标分别读写,避免 fit 大图时误缩版面画布
- 图片缩放用尺寸法不用 transform: `applyZoom()` 直接设 `img.style.width = naturalWidth × zoom`,布局尺寸=视觉尺寸,`.image-wrapper` 的 `fit-content + margin:0 auto` 天然居中(fit)或左对齐滚动(放大);`zoomAt` 图像分支缩放前后各读一次 `getBoundingClientRect()`,按指针不动点校正 scrollLeft/scrollTop;版面画布宽=容器宽,仍用 transform 无此问题(见排查 21)
- 版面块按 `data-label` 有 per-label 语义样式(doc_title 居中加粗、figure_title/table_title 居中小字、header/footer/number 灰小字、formula 居中、formula_number 右对齐、vertical_text `writing-mode: vertical-rl`、footnote/reference_content 小字),`exporter._LAYOUT_TEMPLATE` 内嵌同一套 CSS,导出与界面观感一致
- `exporter.export_layout_html()` 生成同原理的自包含 HTML(图片 base64、内嵌 shrink-to-fit JS、`@media print` 分页),公式用 `latex_to_unicode` 转 Unicode 符号而不内嵌 KaTeX,控制文件体积
- `exporter.page_to_richtext()` 供 `GET /api/page_richtext/:batch_id/:file_id/:page_id[?block=idx|?blocks=1,5,7]` 使用,前端写入 `ClipboardItem({text/html, text/plain})` 实现 Word 富文本粘贴;`blocks` 与 `block` 互斥且 `blocks` 优先,多块按 `block_order` 排序去重后逐块转换拼接(HTML 以 `\n`、text 以 `\n\n` 连接,Word 中为独立段落),空集/越界/非法格式均报错
- 前端两个视图的公式渲染依赖 `viewer.normalizeLatexDelims()` 在 `marked.parse()` 前把 `\(...\)`/`\[...\]` 改写为 `$...$`/`$$...$$`(见排查 16)
- 两者都是纯展示层,不改块数据、markdown 落盘内容与既有流式视图

### 结果页交互约定

- 视图开关两组互斥: 顶部「对比|原图|结果」(`data-mode`,`App.setViewMode`,空 mode 直接 return)与结果区「流式|版面」(`data-rmode`,`Viewer.setViewMode`);事件绑定与激活态刷新的选择器必须带属性过滤(`.btn-toggle[data-mode]`),否则全局 `.btn-toggle` 会让两组按钮互相点亮(双激活 bug)
- 面板工具按钮即时提示: `viewer.initInstantTooltips()` 启动时把 `#left-panel/#right-panel .panel-controls`、`#top-bar .top-bar-controls` 内的 `title` 转 `data-tip`(消除原生延迟气泡),mouseover 立即显示 `.instant-tooltip`(fixed,按钮下方居中),click/scroll 隐藏;新增按钮照常写 `title` 即可
- 侧边栏批次按 `created_at`(UTC 字符串 → 本地日期)分组插入 `.batch-group-title` 组头: 今天/昨天/近 7 天/近 30 天/更早(`Sidebar.batchGroupLabel()`);已完成批次的首次点击在 `expandBatch` 之外直接 `App.openBatch()`(直开第一个文件第一页),进行中/排队批次仅展开(文件行自带进度)
- `#split-divider`(左右面板之间,6px,col-resize)拖拽调宽: 左面板改 `flex: 0 0 px`(两侧各 ≥280px),宽度持久化 localStorage `ocr_split_left` 并启动恢复;`App.setViewMode` 非 split 时隐藏;拖拽结束若未手动缩放则重算 fit
- 锚块同步滚动: `Viewer.handleScroll()` 不按高度百分比映射;锚线=源面板 25% 高度(`ANCHOR_RATIO`),取最后顶边 ≤ 锚线的块(左侧 `block_bbox × (img显示宽/coordW)`,右侧当前视图 `.md-block`/`.layout-block` 的 client rect 换算内容坐标),目标面板把同 idx 块对齐到同一偏移;三侧块同 `data-block-idx` 一一对应,缩放/翻页/视图切换后仍精确;无块数据、目标缺该 idx 元素或版面缩放(layoutZoom≠1 时 transform 下 client rect 不可线性换算)回退原比例同步;`scrollSyncLock` 50ms 防循环
- 对比视图两容器隐藏滚动条: `.image-container/.markdown-container` 设 `scrollbar-width:none` + `::-webkit-scrollbar{display:none}`,滚动功能保留,侧边栏/弹窗等其余滚动条不受影响

### PaddleOCR-VL 模型源
- `os.environ.setdefault("PADDLE_PDX_LOCAL_MODEL_SOURCE", "ModelScope")` 在 `ocr_engine.py` 中设置
- 首次 OCR 自动从魔搭下载模型 (~2GB)
- 模型缓存在 `~/.paddlex/` 目录

### VLM 识别后端 (MLX-VLM, Apple Silicon 加速)
- PaddleOCR-VL 分两阶段: 版面分析 (PaddlePaddle CPU) + VLM 识别 (可外包)
- `ocr_engine.py` 初始化时探测 `OCR_VL_REC_SERVER_URL` (默认 `http://localhost:8111/`),可达则启用 `vl_rec_backend="mlx-vlm-server"`,VLM 识别走 Apple GPU,否则回退本地 CPU
- `vl_rec_api_model_name` 默认 `PaddlePaddle/PaddleOCR-VL-1.6` (必须与服务端 /v1/models 报告的 id 一致;start.sh 从本地路径 `~/.cache/mlx_models/...` 预加载后,其模型 id 即为此名)
- `start.sh` 首次用 modelscope SDK 从 ModelScope 下载模型 (~2GB, 国内 CDN; HF 直连在国内易卡死),再以 `--model` 预加载方式后台启动 `mlx_vlm.server` (端口 8111),并检测/重启无模型的旧实例
- 环境变量: `OCR_VL_REC_BACKEND`、`OCR_VL_REC_SERVER_URL`、`OCR_VL_REC_API_MODEL_NAME`、`OCR_VL_REC_MAX_CONCURRENCY` (默认 4)
- MLX 服务日志: `/tmp/mlx_vlm_server.log`
- 实测性能 (Apple M4, 11 页数学教材 PDF 含表格公式): CPU ~76s/页 vs MLX-VLM ~8.3s/页 (总耗时 91.75s), 提速 ~9x

## 引擎抽象层

### 三引擎能力边界 (实现前必读)

| 引擎 | markdown 结构 | bbox 蒙层 | 置信度 | 插图提取 | 表格/公式 | 计费 |
|------|---------------|-----------|--------|----------|-----------|------|
| `local` | 完整 | 有 (多边形) | **有**(版面检测 score) | 有 | 结构化 | 免费 |
| `siliconflow` | 行级纯文本 | 有 (4 点多边形) | **无** | **无** | **无结构** | token |
| `baidu` | 完整(含表格 md) | 有 (矩形) | **无** | 有 | 结构化 | 页 |

关键事实: **置信度分数来自本地版面检测模型 (PP-DocLayout) 的 `box.score`,不是 VLM 给的。** 两个在线引擎都不经过本地版面检测,所以没有分数;它们在 `json.res` 里写 `has_score: false` 且 boxes **不写 `score` 键**,下游据此切到按块类型着色:
- `image_annotator.annotate_image()`: `any("score" in box)` 为假 → `LABEL_COLORS` 模式,标签只画类型名
- `viewer.js`: `has_score === false` → 蒙层类名走 `LABEL_CLASS_MAP` (`t-text`/`t-title`/...),图例切到 `#label-legend`

两处颜色必须保持一致 (`image_annotator.LABEL_COLORS` ↔ `style.css` 的 `.t-*` ↔ `viewer.LABEL_CLASS_MAP`)。

### 引擎分发入口

`batch_manager` 只调 `ocr_engine.process_document_iter(path, engine=, page_images=, on_usage=)`:
- `local` 吃 `file_path`(pipeline 原生支持 PDF)
- `siliconflow` 吃 `page_images`(已渲染的页图;不上传原始大文件)
- `baidu` 吃 `file_path`(整档提交)

三者返回的 `page_result` 结构完全同构 (`markdown_text` / `json_data` / `images` / `page_data`),所以 `_process_single_page()`、标注、导出、查看器全部复用。

### 远程引擎禁止 import paddlex/paddle

`engine_siliconflow.py` / `engine_baidu.py` 必须可在无本地推理栈的机器上工作。spotting 解析的正则是从 `paddlex/inference/pipelines/paddleocr_vl/uilts.py` **拷过来的**,不是 import 的;升级 paddleocr 后如果输出文法变了,要同步改 `engine_siliconflow.parse_spotting()`。

### 本地引擎运行时探测

- `engine_registry.local_runtime_available()` 用 `importlib.util.find_spec("paddleocr")` + `find_spec("paddle")` 探测本地推理栈,不实际 import
- 无 paddle 的机器(如 `./start_remote.sh` 轻量启动): `list_engines()` 中 local `configured=false` 且 note 说明原因,前端选择器置灰;`default_engine()` 跳过不可用引擎,回退到第一个已配置引擎
- `ocr_engine` 分发器对 engine=local 但运行时不可用的请求抛可读错误(提示改用在线引擎或 start.sh 完整安装),不让用户面对 ImportError 堆栈
- `start_remote.sh` 仅安装 `robyn pillow python-docx PyMuPDF`,不装 paddle/mlx-vlm、不下载模型、不起 MLX 服务,适配无法跑本地推理的电脑

### Spotting 输出文法 (硅基流动路径)

```
<|TEXT_START|>文本<|TEXT_END|><|LOC_BEGIN|><|LOC_x1|><|LOC_y1|>…共 8 个(4 个点)…<|LOC_END|>
```
- 坐标归一化到 **0–1000**,反归一化时乘**原始页图**尺寸(不是上采样后的尺寸)
- 备用解析路径: 连续 8 个裸 LOC token,文本取其前的 span
- 预处理对齐 paddlex `pre_process_for_spotting`: `w<1500 且 h<1500` → LANCZOS ×2;总像素超 `1605632` 再缩回
- prompt 固定为 `"Spotting:"`(参 `paddlex/.../paddleocr_vl/pipeline.py`)

### 百度结果适配要点

- 异步双接口: `POST .../paddle-vl-parser/task` → `.../task/query` 轮询(提交 QPS 2 / 查询 QPS 5,本实现 6s 间隔)
- `position [x, y, w, h]` → `block_bbox [x, y, x+w, y+h]`
- 表格内容在 `tables[]`,按 `layout_id` 关联;插图在 `images[].data_url`(30 天有效)
- 插图写成 `<img src="page_N_img_K.png">`,**正好匹配 `_process_single_page()` 已有的 `src="…"` 重写逻辑**,图片名格式不能随意改
- 表格 markdown 内的 `<img src="http(s)…">` 由 `_localize_table_images()` 在适配期下载进 `images` dict,复用同一重写机制落盘;下载失败保留原 URL(bcebos 30 天授权,逾期由 exporter 下载兜底)
- 标题层级由 `_title_level()` 启发式给出(doc_title→1;`sub_type` 尾部数字;内容匹配 `N.`/`N、` 编号且层级 ≤2 → 3;缺省 2);image 块与紧随的 figure_title/table_title 块 md 片段包居中 div
- `LABEL_MAP` 只翻译真等价名(`title→paragraph_title`、`display_formula→formula`、`content→contents`),其余类型全部透传保留语义(aside_text/vertical_text/inline_formula/header_image/footer_image **不再合并**为 text/image);`IMAGE_TYPES` 含 `seal`(无 data_url 时容错为空内容)。百度 27 种 layout 类型(abstract/algorithm/aside_text/chart/content/display_formula/doc_title/figure_title/footer/footer_image/footnote/formula_number/header/header_image/image/inline_formula/number/paragraph_title/reference/reference_content/seal/table/text/title/vertical_text)与平台标签一一对应,中文名/颜色三组同步: `viewer.LABEL_MAP`+`LABEL_CLASS_MAP` ↔ `style.css` `.t-*` ↔ `image_annotator.LABEL_COLORS`。层级靠提交参数 `relevel_titles=True`(`sub_type`→`_title_level`),API 无父子字段,阅读顺序即百度返回顺序;LABEL_MAP 变更只影响新批次,旧落库数据不回刷
- access_token 缓存在模块 + `settings` 表(`baidu.access_token` / `baidu.token_expire_at`),提前一天续签

### 配置优先级与环境变量

`settings` 表(界面保存) > 环境变量 > 代码默认值。全部字段在 `engine_registry._FIELDS` 里声明式登记。

设置弹窗中两个在线引擎为折叠卡片(头部 = 引擎名 + `已配置/未配置` 徽标 +「获取 Key →」外链 + 展开箭头,主体默认收起,独立开合不互斥);外链新标签打开且 `stopPropagation` 不触发折叠:硅基流动 `https://cloud.siliconflow.cn/me/account/ak`,百度 `https://console.bce.baidu.com/ai-engine/ocr/app/list`。徽标取自 `GET /api/engines` 的 `configured`,`open()` 与保存成功后刷新。「默认引擎」select 区块不折叠。

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `OCR_DEFAULT_ENGINE` | `local` | 新任务默认引擎 |
| `SILICONFLOW_API_KEY` | — | 必填 |
| `SILICONFLOW_BASE_URL` | `https://api.siliconflow.cn/v1` | OpenAI 兼容端点 |
| `SILICONFLOW_MODEL` | `PaddlePaddle/PaddleOCR-VL-1.5` | 官方目前上线的是 1.5 |
| `SILICONFLOW_MAX_CONCURRENCY` | `4` | 单文件内页级并发 |
| `SILICONFLOW_PRICE_IN` / `_OUT` | `0` / `0` | CNY / 1M tokens |
| `BAIDU_OCR_API_KEY` / `BAIDU_OCR_SECRET_KEY` | — | 必填 |
| `BAIDU_PRICE_PER_PAGE` | `0` | CNY/页,需用户按自己计费方案填 |

API Key 绝不明文返回: `GET /api/settings` 只给掩码 + `*_configured` 布尔;`POST` 时空字符串 = 不修改(界面只能看到掩码,无法回传真值)。

### settings / api_usage 表

`settings_store.py` 用**自己的**连接和 `RLock` 访问同一个 `batches/metadata.db`,目的是避开 import 环 (`batch_manager` → `ocr_engine` → `engine_registry` → `settings_store`)。不要把这两张表搬回 `batch_manager`。

- `settings(key, value, updated_at)` — key 形式 `<scope>.<field>`,如 `siliconflow.api_key`
- `api_usage(ts, batch_id, file_id, page_id, engine, calls, prompt_tokens, completion_tokens, billed_pages, cost)` — 每次 API 调用一行,是费用审计的唯一真相;`batches` 行上的聚合列只是展示缓存
- token 计费引擎每页一行(`page_id` 非空);页计费引擎整档一行(`page_id` 为空),所以百度批次的 `pages.cost` 为 0 而 `batches.cost` 正确

### 费用预估的诚实原则

`engine_registry.estimate_cost()` 在无法给出可信数字时返回 `cost: None` + `basis`/`note`,**不编造数字**:
- `no_price`: 页计费引擎未配单价
- `no_history`: token 计费引擎有单价但无历史 tokens/页数据
- `free_model` / `free`: 当前定价为 0

## PaddleOCR-VL JSON 结构

本地模型的 `res.json` 返回结构:
```json
{
  "res": {
    "width": 1101,
    "height": 2653,
    "parsing_res_list": [
      {
        "block_label": "text",
        "block_content": "...",
        "block_bbox": [x1, y1, x2, y2],
        "block_polygon_points": [[x,y], [x,y], [x,y], [x,y]],
        "block_id": 1,
        "block_order": 1
      }
    ],
    "layout_det_res": {
      "boxes": [
        {
          "cls_id": 13,
          "label": "text",
          "score": 0.875,
          "order": 1,
          "coordinate": [x1, y1, x2, y2],
          "polygon_points": [[x,y], ...]
        }
      ]
    }
  }
}
```

关键: `_extract_page_data()` 函数处理 `res` 键的嵌套。如果 PaddleOCR 更新后 JSON 结构变化,首先检查此函数。

## 常见问题排查

### 1. `uv run` 移除 PaddlePaddle
`uv run` 会同步 `pyproject.toml` 中的依赖,移除未声明的包。PaddlePaddle 需从自定义索引安装,不能放入 `pyproject.toml`。
**解决**: 使用 `.venv/bin/python` 直接运行,不用 `uv run`。

### 2. Robyn `QueryParams.get()` 需要默认值
Robyn 的 `QueryParams.get(key)` 必须传 `default` 参数,否则报 `TypeError`。
**解决**: 始终使用 `qp.get("key", None)` 或 `qp.get("key", "default")`。

### 3. PaddlePaddle 模块名
Python 模块名是 `paddle`,不是 `paddlepaddle`。`import paddlepaddle` 会失败。
**正确**: `import paddle` 或 `from paddleocr import PaddleOCRVL`。

### 4. SQLite 线程安全
SQLite 连接默认只能在创建线程使用。需要 `check_same_thread=False` + `RLock` 保护所有操作。
`batch_manager._db_lock` 是一个 `threading.RLock`,所有 DB 操作都在 `with _db_lock:` 块中。

### 5. DuckDB → SQLite 迁移注意
- DuckDB 的 `GENERATED BY DEFAULT AS IDENTITY` 不兼容 SQLite
- SQLite 使用 `INTEGER PRIMARY KEY AUTOINCREMENT` 原生自增
- DuckDB 的 `BOOLEAN` 在 SQLite 中存为 `INTEGER` (0/1),读取时用 `bool()` 转换
- DuckDB 的 `DOUBLE` → SQLite 的 `REAL`

### 6. 前端 vendor.js 构建失败
KaTeX auto-render 的导入路径是 `katex/dist/contrib/auto-render.mjs`,不是 `katex/contrib/auto-render/auto-render.js`。
构建命令: `cd static && bun run build`

### 7. SSE 连接在批次完成后关闭
单批次 SSE 端点在收到 `batch_completed` 事件后自动关闭流。前端 `EventSource.onerror` 会触发,此时应检查批次状态而非重连。`upload.js` 中 `onerror` 回退到轮询。
全局 SSE `/api/events` 不主动关闭(10 分钟超时后断开,浏览器 EventSource 自动重连)。

### 8. 多文件并行 OCR 崩溃
批次内多个 worker 并发调用共享 PaddleOCR-VL pipeline 的 `predict_iter` 会报错(非线程安全)。
**解决**: `process_batch_background()` 已改为串行 for 循环,不要恢复 ThreadPoolExecutor 并行。

### 9. 导出 Markdown 图片失效
页面 MD 中图片是 `/api/page_image/...` API URL,离开平台无法显示。
**解决**: `exporter._embed_images_base64()` 在导出时替换为 base64 data URI;新增导出格式时注意保持此处理。

### 10. 新增 SQLite 列必须登记 `_EXPECTED_COLUMNS`
`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加新列。在 `batch_manager` 的建表语句里加列后,**必须同时在 `_EXPECTED_COLUMNS` 登记**,否则老库启动会 `no such column` 崩溃。`_migrate_columns()` 会幂等地 `ALTER TABLE ADD COLUMN` 补齐。

### 11. 上传时的 engine 走 query param 而非表单字段
Robyn 的 multipart 解析只暂露 `request.files`,非文件表单字段拿不到。
**解决**: `POST /api/upload?engine=<id>`,后端用 `qp.get("engine", None)` 读。

### 12. 未配置的在线引擎必须在创建批次前拦下
`upload()` 先跑 `engine_registry.is_configured()`,不通过就直接返回错误,**不创建批次也不落盘文件**。否则会留下一堆 error 状态的垃圾批次。

### 13. 远程引擎失败的错误信息要可读
`engine_*.EngineError` 统一用中文描述(含 HTTP 状态码与服务端 detail),`_process_single_file` 将其写入 `files.error_message`。不要改成统一的 "Processing exception"。

### 14. 导出与富文本必须处理 http 图片 URL
百度老批次的表格内图片是 bcebos 远程 URL(30 天授权)。`_resolve_image_src()` 对 http(s) 要下载到临时文件(15s 超时,失败返回 None 占位跳过,不能静默丢图也不拖死导出);`_embed_images_base64()` 链尾 `_embed_remote_images_base64()` 把 http img 转 data URI 保持 MD 导出/富文本自包含。新批次由 `_localize_table_images()` 在适配期就本地化,远程下载只是兼容老批次的兜底。

### 15. 判断本地引擎可用性走 `local_runtime_available()`
无 paddle 的机器必须能正常起服务(在线引擎照常用)。`ocr_engine.get_pipeline()` 内已延迟 import paddleocr;探测一律用 `engine_registry.local_runtime_available()`(`find_spec`,无副作用),不要 try-import paddle 来判断。

### 16. marked 会吞掉 `\(` 的反斜杠(硅基流动公式不渲染)
marked 按 CommonMark 规则把 `\(` 当作转义括号,输出 HTML 只剩 `(...)`,KaTeX auto-render 找不到定界符,`\triangle` 等命令以纯文本残留(硅基流动批次全是 `\(...\)` 定界;百度 `$...$` 不受影响)。**解决**: `viewer.normalizeLatexDelims()` 在所有 `marked.parse()` 之前把 `\(...\)`/`\[...\]` 改写为 `$...$`/`$$...$$`(流式分块/流式整页/版面三处调用点都要走这个函数)。

### 17. 深链 hash 兼容两种格式
`handleRoute()` 对 `window.location.hash` 先 `slice(1)` 再 `replace(/^\//, '')`,`#batch/...` 与 `#/batch/...` 都能路由;空 hash 与 `#upload`/`#/upload` 都回上传首页。

### 18. marked 把行首 `N.` 吞成 `<ol>`(标题序号消失)
`3. 三角形…` 这类单行标题被 marked 解析为 `<ol start="3"><li>`,全局 reset `*{padding:0}` 使 ol 无 padding-left,outside 序号落在内容盒外(流式不可见、版面被 `overflow:hidden` 裁剪)。数据本身完整。**解决**: `viewer.protectLeadingEnum()` 在 `marked.parse()` 前转义单行块行首 `^\d{1,9}[.)]`(`3.`→`3\.`),多行块不动(真列表仍需解析);CSS 侧 `.lb-body/.md-block-body/.markdown-content` 的 `ol/ul` 统一 `list-style-position:inside;padding-left:0` 兜底。块级解析一律走 `viewer.parseBlockMd()`(normalizeLatexDelims + protectLeadingEnum 都含),不要再直接调 `marked.parse`。

### 19. 含 `<img>` 的表格会被误判为图片块
表格单元格插图使 `block_content.includes('<img')` 为真,旧的图片分支判断把整块表格当图片,`replace(/^<img/)` 无操作后输出原始 pipe 文本。**解决**: `viewer.isPureImageBlock()` — 仅当 label ∈ IMG_LABELS(image/chart/seal/header_image/footer_image)或 trim 后整体匹配 `/^<img[^>]*\/?>$/` 才走图片分支,其余一律 marked.parse(表格内 img 由统一的相对路径补 API 前缀循环处理);`fitLayoutBlocks` 同理只跳过纯图片块,表格恢复字号自适应。

### 20. 本地引擎表格图片的 `imgs/` 前缀(404 / 导出丢图)
本地 pipeline 输出的表格块 `block_content` 内嵌 `<img src="imgs/img_in_image_box_*.jpg">`,但 `page_N_images/` 平铺保存(无 `imgs/` 子目录),前端补 API 前缀后与导出侧 `_resolve_image_src`(`"/" not in src` 才解析)双双落空。三层修复: `_process_single_page()` 落盘 JSON 前把 block_content 的 `src="imgs/x"` 归一为平名(新批次数据干净);`serve_extracted_image` 找不到时按 basename 重试(旧批次显示兼容);`_resolve_image_src` 对含 `/` 的 src 按 basename + exists 兜底(旧批次导出/富文本不再丢图)。

### 21. transform:scale 不改布局尺寸(图片偏右)
图片面板旧实现用 `transform: scale(z)` 缩放:transform 不改变布局尺寸,`.image-wrapper`(`width:fit-content`)布局宽恒为原图宽(如 1101px),超出容器(~600px)时 `margin:0 auto` 失效左对齐,而 `transformOrigin:'top center'` 以 1101px 盒中心缩放,视觉图片偏右约 (原图宽−容器宽)/2,右缘被裁。**解决**: `applyZoom()` 改为直接设 `img.style.width = naturalWidth × zoom`,布局尺寸=视觉尺寸,fit 时 margin auto 居中、放大时左对齐可滚动;`.image-wrapper` 不再需要 transform transition(wheel 高频会闪)。

## 开发环境

```bash
# Python 虚拟环境
uv venv --python python3.13
uv pip install paddlepaddle==3.2.1 --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
uv pip install -U "paddleocr[doc-parser]"
uv pip install "robyn>=0.63" "pillow>=10.0" "python-docx>=1.1" "PyMuPDF>=1.24"

# 前端
cd static && bun install && bun run build && cd ..

# 启动
export PADDLE_PDX_LOCAL_MODEL_SOURCE="ModelScope"
# 在线引擎可预先给默认值(也可在界面设置中填写)
# export SILICONFLOW_API_KEY="sk-..."
# export BAIDU_OCR_API_KEY="..." BAIDU_OCR_SECRET_KEY="..."
.venv/bin/python server.py --port 7860 --open-browser
```

## 测试文件

- `testset/Weixin Image_20260718224411_18_1.jpg` — 数学教材图片,含表格和公式
- `testset/pdf_test.pdf` — 多页 PDF,含图表和 LaTeX 公式
- `testset/pdf_test.json` — PaddleOCR 在线 API 的 JSON 输出样例
- `testset/pdf_test.md` — PaddleOCR 在线 API 的 Markdown 输出样例

## 已知限制

1. **串行吞吐**: 批次间、批次内文件均为串行处理(本地 pipeline 非线程安全),大批次耗时线性增长;硅基流动引擎在**单文件内**按页并发(默认 4)
2. **推理速度**: 默认 CPU 推理每页约 76 秒;安装并启动 MLX-VLM 服务后 (start.sh 自动处理),VLM 识别走 Apple GPU 约 8.3 秒/页 (实测提速 ~9x, Apple M4)。MLX 模型 (~2GB) 首次需从 ModelScope 下载,期间回退 CPU
3. **Word 公式**: LaTeX 公式转为 Unicode 符号文本(非 OMML 原生公式),复杂排版(矩阵/多层分式)可能损失结构
4. **SSE 超时**: SSE 连接最长 10 分钟,超时后浏览器自动重连
5. **文件名编码**: 中文文件名在 URL 中需正确编码,`generate_file_id()` 已处理
6. **硅基流动引擎的结构损失**: 纯远程 Spotting 只能拿到行级文本 + 坐标,表格/公式不结构化、不提取插图、无置信度。行级还原同样适用于版面视图与复制链路(版面模式按行块 bbox 逐行摆放、复制按行块拼接),md 中公式为 `\(...\)` 定界,前端 KaTeX 与 exporter 的 LaTeX→Unicode 均已覆盖该定界符。需要与本地同等质量时可另加 remote-hybrid 模式(本地版面检测 + 远程识别,`PaddleOCRVL(vl_rec_backend="vllm-server", vl_rec_server_url=..., vl_rec_api_key=...)`)
7. **百度引擎无逐页进度**: 云端整档解析,轮询期间前端只能显示"远程任务解析中",任务返回后才有页级事件
8. **在线单价需手动配置**: 代码不内置任何真实单价(避免过期后误导);未填时界面显示"未配置单价"而不估算
