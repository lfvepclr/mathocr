# PaddleOCR 文档解析平台升级

## Summary

将现有 Gradio 单图 OCR 应用升级为 Robyn (Rust 内核 Python 框架) 后端 + 原生 HTML/CSS/JS 前端的完整文档解析平台,支持多文件批次管理、原图与 OCR 结果对比(含置信度色块标注)、历史批次浏览、Word/Markdown 导出,UI 风格参考 MinerU。

## 架构与技术栈

- **后端**: Robyn (Rust runtime Python web framework) + PaddleOCR-VL-1.6 (本地模型)
- **前端**: 原生 HTML/CSS/JS (无构建步骤) + CDN 加载 marked.js (Markdown 渲染) + KaTeX (LaTeX 渲染)
- **数据存储**: 文件系统,`batches/` 目录下按批次号管理
- **异步处理**: 后台线程处理 OCR,前端轮询状态

## 项目结构

```
mathocr/
├── server.py                    # Robyn 主服务器入口
├── ocr_engine.py                # PaddleOCR-VL 封装 (从 app.py 提取)
├── batch_manager.py             # 批次文件夹管理
├── image_annotator.py           # 原图标注 (bbox + 置信度色块)
├── pdf_renderer.py              # PDF 页面渲染 (PyMuPDF)
├── exporter.py                  # Markdown / Word 导出
├── pyproject.toml               # 更新依赖
├── setup.sh                     # 更新安装脚本
├── README.md                    # 重写文档
├── .gitignore                   # 添加 batches/
├── app.py                       # 保留旧 Gradio 应用 (不修改,作为备份)
├── static/                      # 前端资源
│   ├── index.html               # 主页面
│   ├── css/
│   │   └── style.css            # 全部样式
│   └── js/
│       ├── app.js               # 主逻辑 (路由、状态管理)
│       ├── upload.js            # 文件上传、拖拽
│       ├── viewer.js            # 对比查看器 (同步滚动、全屏放大)
│       └── sidebar.js           # 批次历史侧边栏
├── batches/                     # 批次输出目录 (gitignored)
│   └── YYYYMMDD_HHMMSS/         # 每个批次一个文件夹
│       ├── uploads/             # 原始上传文件
│       ├── results/             # OCR 结果 (按文件分目录)
│       │   └── {filename}/
│       │       ├── meta.json    # 文件级元数据
│       │       ├── page_0_original.png   # 原始页面图片
│       │       ├── page_0_annotated.png  # 标注后图片 (bbox+置信度)
│       │       ├── page_0.json           # PaddleOCR JSON 报文
│       │       ├── page_0.md             # Markdown 输出
│       │       └── page_0_images/        # 从文档中提取的图片
│       └── batch_meta.json     # 批次元数据
└── testset/                     # 现有测试文件 (不修改)
```

## 数据模型

### batch_meta.json
```json
{
  "batch_id": "20260719_143022",
  "created_at": "2026-07-19T14:30:22",
  "status": "processing|completed|error",
  "files": [
    {
      "file_id": "document1_pdf",
      "original_name": "document1.pdf",
      "file_type": "pdf",
      "file_size": 5020000,
      "page_count": 3,
      "status": "completed",
      "pages": [
        {"page_id": 0, "has_result": true, "block_count": 15},
        {"page_id": 1, "has_result": true, "block_count": 12}
      ]
    }
  ]
}
```

### 文件夹命名规则
- 批次号: `YYYYMMDD_HHMMSS` (如 `20260719_143022`)
- 文件 ID: 原始文件名去掉扩展名 + `_<随机4字符>` 避免重名 (如 `document1_a3b2`)
- 页面文件: `page_{N}_original.png`, `page_{N}_annotated.png`, `page_{N}.json`, `page_{N}.md`

## 后端实现

### 1. `ocr_engine.py` — PaddleOCR 封装
- 从现有 `app.py` 提取 `get_pipeline()` 单例逻辑
- 新增 `process_document(file_path) -> list[PageResult]` 函数:
  - 调用 `pipeline.predict(file_path)`,遍历每页结果
  - 从 `res.markdown` 提取 `markdown_texts` 和 `markdown_images`
  - 从 `res.json` 提取完整 JSON (含 `parsing_res_list` 的 bbox 和 `layout_det_res.boxes` 的 score)
  - 返回每页的 `(markdown_text, json_data, images_dict)`
- 将 `markdown_images` 中的 PIL 图片保存到 `page_N_images/` 目录,替换 markdown 中的图片引用为本地路径
- 异步执行: 在后台线程中调用,通过批次状态字段报告进度

### 2. `pdf_renderer.py` — PDF 页面渲染
- 使用 `PyMuPDF` (fitz) 将 PDF 每页渲染为 PNG 图片
- `render_pdf_pages(pdf_path, output_dir) -> list[str]`: 返回每页图片路径
- 渲染分辨率: DPI=200 (平衡清晰度和文件大小)
- 图片文件命名: `page_{N}_original.png`
- 对于图片文件 (PNG/JPG/BMP/GIF/TIFF/WEBP): 直接复制为 `page_0_original.png`

### 3. `image_annotator.py` — 原图标注
- `annotate_image(original_image_path, json_data, output_path)` 函数:
  - 用 PIL 加载原始图片
  - 遍历 `json_data["layout_det_res"]["boxes"]` (或 `parsing_res_list`):
    - 获取 `coordinate` (bbox) 和 `score` (置信度)
    - 绘制半透明填充矩形 (alpha=60) + 实线边框 (width=2)
    - 颜色按置信度分级:
      - score >= 0.90: 绿色 `#22c55e` (高置信度)
      - 0.75 <= score < 0.90: 蓝色 `#3b82f6` (中高)
      - 0.60 <= score < 0.75: 黄色 `#eab308` (中低)
      - score < 0.60: 红色 `#ef4444` (低,需人工检查)
    - 在矩形左上角绘制标签: `{block_label} {score:.2f}` (白底黑字,字号12)
  - 保存标注后图片为 `page_{N}_annotated.png`
- 新增图例图片生成功能,在前端显示颜色含义

### 4. `batch_manager.py` — 批次管理
- `create_batch(files: list[bytes, str]) -> str`: 创建批次文件夹,保存上传文件,返回批次号
- `get_batch_status(batch_id) -> dict`: 读取 `batch_meta.json`
- `list_batches() -> list[dict]`: 列出所有批次 (按时间倒序)
- `get_batch_file_page(batch_id, file_id, page_id) -> dict`: 获取指定页面的所有数据路径
- `update_batch_meta(batch_id, updates)`: 更新批次元数据
- 批次号生成: `datetime.now().strftime("%Y%m%d_%H%M%S")`

### 5. `exporter.py` — 导出
- `export_markdown(batch_id, file_id) -> str`: 合并所有页面的 markdown,返回文件路径
- `export_word(batch_id, file_id) -> str`: 使用 `python-docx` 生成 Word 文档:
  - 遍历每页的 `parsing_res_list` (按 `block_order` 排序):
    - `paragraph_title` → Word Heading (根据 `#` 数量确定级别)
    - `text` → Word Paragraph (保留加粗、斜体等格式)
    - `table` (HTML) → 解析 HTML 表格 → Word Table
    - `image` → 插入对应图片 (从 `page_N_images/` 加载)
    - `formula` → 作为文本插入 (LaTeX 原文)
  - 每页之间插入分页符
  - 设置页面大小基于原始文档尺寸 (从 `width`/`height` 字段)
- `export_batch_markdown(batch_id) -> str`: 导出批次内所有文件的 markdown (合并)

### 6. `server.py` — Robyn 主服务器

**静态文件服务**:
- 使用 Robyn 的 `serve_html()` 服务 `static/index.html`
- 通过路由处理器服务 CSS/JS/图片等静态文件 (读取文件返回 `Response`)
- 或使用 Robyn 的静态目录配置 (`app.set_static_directory`)

**API 端点**:

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/` | 返回 `static/index.html` |
| GET | `/static/*` | 服务静态资源 (CSS/JS) |
| POST | `/api/upload` | 接收多文件上传,创建批次,启动后台 OCR 处理 |
| GET | `/api/batches` | 列出所有历史批次 |
| GET | `/api/batch/:batch_id` | 获取批次详情 (含文件列表、页面信息) |
| GET | `/api/batch/:batch_id/file/:file_id` | 获取文件内所有页面的摘要 |
| GET | `/api/batch/:batch_id/file/:file_id/page/:page_id` | 获取指定页面的 markdown + JSON |
| GET | `/api/image/:batch_id/:file_id/:page_id?type=original\|annotated` | 服务页面图片 |
| GET | `/api/page_image/:batch_id/:file_id/:page_id/:img_name` | 服务从文档中提取的图片 |
| GET | `/api/export/:batch_id?format=md\|docx&file_id=xxx` | 导出 Markdown 或 Word |
| DELETE | `/api/batch/:batch_id` | 删除批次 |

**上传处理** (`POST /api/upload`):
- 从 `request.files` 获取上传文件 (dict: `{filename: bytes}`)
- 调用 `batch_manager.create_batch()` 创建批次文件夹并保存文件
- 启动后台线程处理 OCR:
  ```
  for each file:
      if PDF: render pages with PyMuPDF
      else: copy image as page_0_original
      for each page:
          run PaddleOCR predict()
          save JSON, markdown, extracted images
          generate annotated image
          update batch_meta.json
  update batch status to "completed"
  ```
- 立即返回批次号,前端轮询状态

## 前端实现

### 页面布局 (参考 MinerU)

```
+----------------------------------------------------------+
| Sidebar (240px)  |  Top Bar                              |
|                  |  [File Tabs]  [< 1/3 >]  [MD] [Word]  |
| - App Title      |----------------------------------------|
| - + 新建解析     |  Left Panel (50%)  |  Right Panel (50%) |
|                  |  Annotated Original|  Rendered Markdown |
| - Batch History  |  (with bbox colors)|  (with KaTeX)      |
|   - 0719_143022  |                    |                    |
|   - 0718_091500  |                    |                    |
|     - file1.pdf  |                    |                    |
|     - image.png  |                    |                    |
|                  |  [Zoom +/-] [Full] |  [Full] [Sync Scroll]|
+----------------------------------------------------------+
```

### `static/index.html`
- 加载 CDN: marked.js, KaTeX (with auto-render), highlight.js (可选)
- 页面结构: `<aside>` 侧边栏 + `<main>` 主区域
- 主区域分为: 上传视图 (默认) 和结果视图 (选中批次/文件后)

### `static/css/style.css`
- 设计原则 (参考 ui-ux-pro-max 规范):
  - 色彩: 主色 `#6366f1` (indigo), 背景 `#f8fafc`, 文字 `#0f172a`
  - 侧边栏: `bg-white`, 右侧 `border-right`, 宽度 `240px`
  - 卡片/面板: `border-radius: 8px`, `border: 1px solid #e2e8f0`
  - 所有可点击元素: `cursor: pointer`, hover 时 `background-color` 变化
  - 字体: `system-ui, -apple-system, sans-serif`
- 关键样式:
  - `.split-view`: `display: flex`, 两个面板各占 `50%`
  - `.panel-fullscreen`: `position: fixed; inset: 0; z-index: 9999`
  - `.confidence-legend`: 图例浮动框,显示颜色含义
  - `.upload-zone`: 虚线边框,拖拽高亮

### `static/js/app.js` — 主逻辑
- 状态管理: `state = { currentBatch, currentFile, currentPage, viewMode }`
- 路由: hash-based (`#/upload`, `#/batch/:id`, `#/batch/:id/file/:fid/page/:pid`)
- 初始化: 加载批次列表到侧边栏,默认显示上传视图
- 视图切换: 上传视图 ↔ 结果视图

### `static/js/upload.js` — 上传处理
- 拖拽区域: `dragover`/`drop` 事件监听
- 文件选择: `<input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.bmp,.gif,.tiff,.webp">`
- 上传: `fetch('/api/upload', { method: 'POST', body: formData })`
- 上传后: 轮询 `/api/batch/:id` 获取状态,显示进度条
- 状态完成后: 自动切换到结果视图

### `static/js/viewer.js` — 对比查看器
- **页面加载**: `loadPage(batchId, fileId, pageId)` → fetch markdown + JSON
- **Markdown 渲染**: 用 marked.js 解析,KaTeX 自动渲染公式
- **图片显示**: 原始图片和标注图片可切换,标注图片上叠加 bbox 色块
- **全屏放大**: 点击面板右上角按钮,添加 `.panel-fullscreen` 类,显示关闭按钮
- **同步滚动**: 监听 `scroll` 事件,按比例同步另一面板 (可切换开关)
- **页面导航**: `< 上一页 | 1/N | 下一页 >` 按钮
- **文件切换**: 顶部 file tabs,点击切换文件
- **视图模式**: "对比" (左右分栏) | "仅原图" | "仅结果"
- **缩放**: 对原图面板支持 zoom in/out (CSS transform: scale)

### `static/js/sidebar.js` — 侧边栏
- **批次列表**: `fetch('/api/batches')` 加载历史批次
- **批次展开**: 点击批次显示其文件列表
- **新建解析**: 点击按钮回到上传视图
- **批次删除**: 每个批次项右侧删除按钮
- 时间格式化: `07-19 14:30` (月日时分)

## 置信度色块方案

在标注原图上,每个检测到的文本块用半透明色块覆盖:
- 绿色 `#22c55e` (score >= 0.90): 高置信度,识别可信
- 蓝色 `#3b82f6` (0.75 <= score < 0.90): 中高置信度
- 黄色 `#eab308` (0.60 <= score < 0.75): 中低置信度,需留意
- 红色 `#ef4444` (score < 0.60): 低置信度,建议人工校对

色块样式: 半透明填充 (alpha=60/255) + 2px 实线边框 + 左上角标签 `{类型} {分数}`

前端右侧浮动图例面板,鼠标悬停色块时高亮对应 markdown 区域 (可选增强)。

## PaddleOCR 协议与布局还原

- 直接使用 PaddleOCR-VL 输出的 markdown,其中已包含:
  - `## / ###` 标题层级
  - `$...$` 和 `$$...$$` LaTeX 公式
  - `<table>` HTML 表格
  - `<img>` 图片标签 (替换为本地路径)
  - `<div style="text-align: center;">` 居中等布局
- 前端用 marked.js 渲染时保留 HTML 标签 (`sanitize: false`)
- Word 导出时,按 `parsing_res_list` 的 `block_order` 顺序还原文档结构

## 依赖更新

### `pyproject.toml` 新增依赖
```toml
dependencies = [
    "gradio>=4.0",        # 保留,旧 app.py 使用
    "pillow>=10.0",
    "robyn>=0.63",
    "python-docx>=1.1",
    "PyMuPDF>=1.24",
]
```

### `setup.sh` 更新
在现有 PaddlePaddle + PaddleOCR 安装步骤后,新增:
```bash
uv pip install robyn python-docx PyMuPDF
```

## 清理

- 删除 `=10.0` 和 `=4.0` (误创建的空文件,来自 `pip install pillow>=10.0` 命令错误)
- `.gitignore` 添加 `batches/`

## 实现步骤

1. **清理与配置**: 删除 `=10.0`、`=4.0`,更新 `.gitignore`、`pyproject.toml`、`setup.sh`
2. **后端模块**: 创建 `ocr_engine.py`、`pdf_renderer.py`、`image_annotator.py`、`batch_manager.py`、`exporter.py`
3. **Robyn 服务器**: 创建 `server.py`,实现所有 API 端点
4. **前端页面**: 创建 `static/index.html`、`static/css/style.css`
5. **前端逻辑**: 创建 `static/js/app.js`、`upload.js`、`viewer.js`、`sidebar.js`
6. **README.md**: 重写文档,包含安装、使用、架构说明
7. **测试**: 使用 testset 中的 PDF 和图片测试完整流程

## 测试计划

1. **环境验证**: `uv run python server.py` 启动无报错
2. **图片测试**: 上传 `testset/Weixin Image_20260718224411_18_1.jpg`,验证:
   - 批次文件夹正确创建
   - 标注图片有色块覆盖
   - Markdown 正确渲染 (含公式、表格、图片)
   - 可全屏放大对比
3. **PDF 测试**: 上传 `testset/pdf_test.pdf`,验证:
   - 多页正确渲染
   - 页面导航正常
   - 每页都有标注和 Markdown
4. **多文件测试**: 同时上传多个文件,验证:
   - 批次内文件切换正常
   - 滚动浏览模式正常
5. **历史批次**: 刷新页面,验证侧边栏显示历史批次,可点击查看
6. **导出测试**: 导出 Markdown 和 Word,验证内容完整性和布局还原
7. **置信度色块**: 验证不同置信度的块显示不同颜色,图例正确

## 文件变更汇总

| 文件 | 操作 | 说明 |
|------|------|------|
| `server.py` | 新建 | Robyn 主服务器,所有 API 端点 |
| `ocr_engine.py` | 新建 | PaddleOCR-VL 封装,从 app.py 提取核心逻辑 |
| `batch_manager.py` | 新建 | 批次文件夹管理 |
| `image_annotator.py` | 新建 | 原图标注 (bbox + 置信度色块) |
| `pdf_renderer.py` | 新建 | PDF 页面渲染 (PyMuPDF) |
| `exporter.py` | 新建 | Markdown / Word 导出 |
| `static/index.html` | 新建 | 前端主页面 |
| `static/css/style.css` | 新建 | 全部样式 |
| `static/js/app.js` | 新建 | 主逻辑 |
| `static/js/upload.js` | 新建 | 上传逻辑 |
| `static/js/viewer.js` | 新建 | 对比查看器 |
| `static/js/sidebar.js` | 新建 | 侧边栏逻辑 |
| `pyproject.toml` | 修改 | 新增 robyn, python-docx, PyMuPDF 依赖 |
| `setup.sh` | 修改 | 新增依赖安装步骤 |
| `.gitignore` | 修改 | 添加 batches/ |
| `README.md` | 重写 | 完整项目文档 |
| `=10.0` | 删除 | 误创建的空文件 |
| `=4.0` | 删除 | 误创建的空文件 |
| `app.py` | 不修改 | 保留旧 Gradio 应用作为备份 |
