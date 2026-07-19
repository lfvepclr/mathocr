# AGENTS.md — AI 代理交接文档

本文档为后续 AI 代理(模型)提供项目上下文,帮助快速理解和迭代开发。

## 项目概述

MathOCR 是基于 PaddleOCR-VL-1.6 的文档智能解析平台。用户上传 PDF/图片,系统按持久化队列串行 OCR 识别,生成带置信度色块标注的原图对比和分块 Markdown 结果(SVG 蒙层双向联动 + 块级复制),首页任务队列实时显示进度,支持历史批次管理和 Word(LaTeX→Unicode)/Markdown(base64 图片内嵌)导出。

## 架构

```
用户浏览器 ←→ Robyn (Rust HTTP) ←→ Python 后端
                    ↓
              Job Queue (SQLite 持久化队列,单工作线程,重启恢复)
                    ↓
              Batch Manager (SQLite + 文件系统) — 批次内文件串行处理
                    ↓
              PaddleOCR-VL-1.6 (本地模型,魔搭源)
                    ↓
              Event Bus (批次频道 + "*" 全局频道) → SSE → 浏览器实时更新
```

### 数据流

1. 用户上传文件 → `POST /api/upload` → `batch_manager.create_batch()` → `job_queue.enqueue()`(发布 `batch_queued` 事件)
2. Job Queue 工作线程 → `batch_manager.process_batch_background()`
3. 批次内文件**串行**处理(共享 pipeline 非线程安全): PDF渲染 → `ocr_engine.process_document_iter()` 流式逐页 → 每页保存JSON/MD/图片 → 标注原图 → 写SQLite
4. 每页完成 → `event_bus.publish("page_completed")` → 批次 SSE + 全局 SSE 推送 → 侧边栏/队列面板/上传进度实时更新
5. 批次完成 → `event_bus.publish("batch_completed")` → 前端自动跳转结果页(侧边栏拖入创建的任务不跳转,仅刷新状态)
6. 服务器重启 → `job_queue.recover_interrupted()` 重新入队中断批次,已完成页面自动跳过(resume guard)

## 核心文件

### 后端

| 文件 | 职责 | 关键函数 |
|------|------|----------|
| `server.py` | Robyn HTTP 服务器,所有 API 端点 | `upload()`, `global_events()` (全局 SSE), `batch_events()` (SSE), `set_batch_alias()` |
| `batch_manager.py` | 批次/文件/页面 CRUD,后台 OCR 流水线(串行) | `create_batch()`, `process_batch_background()`, `_process_single_file()`, `_process_single_page()` |
| `ocr_engine.py` | PaddleOCR-VL 封装,流式逐页推理 | `get_pipeline()`, `process_document_iter()`, `_extract_page_data()` |
| `image_annotator.py` | 原图标注 (bbox + 置信度色块) | `annotate_image()`, `get_confidence_color()` |
| `pdf_renderer.py` | PDF 页面渲染 (PyMuPDF) | `render_pdf_pages()`, `prepare_original_images()` |
| `exporter.py` | Markdown(base64 图片内嵌) / Word 导出 | `export_word()`, `_embed_images_base64()`, `export_markdown()` |
| `latex_utils.py` | LaTeX → Unicode 符号转换 (Word 导出) | `latex_to_unicode()`, CLI: `python latex_utils.py <dir>` 扫描漏网命令 |
| `event_bus.py` | SSE 事件总线 (进程内, `"*"` 全局订阅) | `subscribe()`, `publish()` (注入 batch_id) |
| `job_queue.py` | SQLite 持久化任务队列 (单工作线程) | `enqueue()` (发 `batch_queued`), `recover_interrupted()` |

### 前端

| 文件 | 职责 |
|------|------|
| `static/index.html` | 主页面结构 (侧边栏 + 上传/结果视图 + 任务队列容器 + FAB) |
| `static/css/style.css` | 全部样式 (CSS变量 + 侧边栏收起 + 蒙层/分块/队列卡片/FAB 弧形) |
| `static/js/app.js` | 主协调器 (状态管理,路由,全局 SSE `initGlobalEvents()` 分发) |
| `static/js/sidebar.js` | 批次列表,批次级实时进度 (`handleGlobalEvent`),别名管理 |
| `static/js/upload.js` | 拖拽上传,SSE实时进度 (含轮询降级),`QueuePanel` 首页任务队列面板 |
| `static/js/viewer.js` | 对比查看器 (分块渲染,SVG 蒙层联动,块级复制,滚轮/捏合缩放,全屏,同步滚动,KaTeX) |
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

### SQLite 持久化队列而非 Celery/Redis
- 单进程场景,无需分布式队列;队列状态存于 batches 表 status 列(queued/processing/completed/error)
- 单工作线程 FIFO;`threading.Event` 唤醒避免轮询延迟
- 重启后 `recover_interrupted()` 将 processing 状态批次重新入队;`_process_single_file()` 的 resume guard 跳过已完成页面,零重复 OCR

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
.venv/bin/python server.py --port 7860 --open-browser
```

## 测试文件

- `testset/Weixin Image_20260718224411_18_1.jpg` — 数学教材图片,含表格和公式
- `testset/pdf_test.pdf` — 多页 PDF,含图表和 LaTeX 公式
- `testset/pdf_test.json` — PaddleOCR 在线 API 的 JSON 输出样例
- `testset/pdf_test.md` — PaddleOCR 在线 API 的 Markdown 输出样例

## 已知限制

1. **串行吞吐**: 批次间、批次内均为串行处理(pipeline 非线程安全),大批次耗时线性增长
2. **推理速度**: 默认 CPU 推理每页约 1-2 分钟;安装并启动 MLX-VLM 服务后 (start.sh 自动处理),VLM 识别走 Apple GPU 显著提速。MLX 模型 (~2GB) 首次需从 ModelScope 下载,期间回退 CPU
3. **Word 公式**: LaTeX 公式转为 Unicode 符号文本(非 OMML 原生公式),复杂排版(矩阵/多层分式)可能损失结构
4. **SSE 超时**: SSE 连接最长 10 分钟,超时后浏览器自动重连
5. **文件名编码**: 中文文件名在 URL 中需正确编码,`generate_file_id()` 已处理
