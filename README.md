# MathOCR — PaddleOCR-VL 文档解析平台

基于 PaddleOCR-VL-1.6 的文档智能解析平台,支持 PDF/图片多格式输入,队列化 OCR 识别,原图与解析结果对比(含置信度色块标注 + SVG 蒙层联动),历史批次管理,任务队列实时进度,Markdown/Word 导出。
![图片](assets/Snipaste_2026-07-19_15-57-47.png)
![图片](assets/Snipaste_2026-07-19_14-18-24.png)

## 功能特性

- **多文件批量上传** — 支持同时上传多个文件,自动生成批次号(年月日时分秒)
- **队列化 OCR 识别** — SQLite 持久化任务队列,单工作线程串行处理,崩溃重启自动恢复中断批次
- **原图对比查看** — 左右分栏对比原图(带边界框标注)与解析结果,支持全屏放大
- **SVG 蒙层联动** — 原图上叠加识别区域多边形蒙层(置信度四色,可开关),hover 图片框 ↔ Markdown 块双向高亮联动
- **块级复制** — hover 任一识别块显示复制按钮,一键复制该块 Markdown 源码(含公式)
- **任务队列面板** — 首页实时列出排队/处理中任务及页级进度,刷新页面自动恢复显示
- **拖拽建任务** — 侧边栏「新建解析」按钮与收缩态 FAB 均为拖放区,处理文档中也能添加任务
- **批次级进度** — 侧边栏批次行内实时显示页级进度(解析中 x/y 页 · 文件 n/N),无需展开
- **置信度色块** — 每个识别区域以颜色标注置信度(绿/蓝/黄/红),快速定位低置信度内容
- **历史批次管理** — SQLite 存储元数据,支持别名、按状态筛选、处理耗时追踪
- **实时进度推送** — 全局 SSE (Server-Sent Events) 单连接推送所有批次事件,无需轮询
- **滚轮/捏合缩放** — 原图面板支持 Ctrl+滚轮与触摸板双指捏合缩放,缩放中心跟随光标
- **多格式导出** — Markdown(图片 base64 内嵌,自包含可分享)和 Word(.docx,LaTeX 公式转 Unicode 符号)导出
- **侧边栏可收起** — 点击收起按钮展开/收起侧边栏,状态持久化;收缩后为贴边弧形拉手
- **魔搭模型源** — 默认从 ModelScope 下载模型,国内访问更稳定

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端框架 | Robyn | Rust 内核 Python Web 框架,高性能 |
| OCR 引擎 | PaddleOCR-VL-1.6 | 百度飞桨文档解析模型 |
| 推理加速 | MLX-VLM (可选) | Apple Silicon GPU 推理后端,VLM 识别提速数倍 |
| 元数据存储 | SQLite | 内置于 Python 标准库,轻量 OLTP |
| 实时推送 | SSE | Server-Sent Events,Robyn StreamingResponse |
| 任务队列 | SQLite 持久化队列 | 单工作线程串行处理,重启自动恢复中断 |
| PDF 渲染 | PyMuPDF | 高性能 PDF 页面渲染 |
| 前端构建 | Bun | 高性能 JS 运行时与打包工具 |
| 前端渲染 | marked.js + KaTeX | Markdown + LaTeX 公式渲染 |
| 包管理 | UV (Python) + Bun (前端) | |

## 快速开始

### 一键启动

```bash
./start.sh
```

脚本会自动完成:
1. 检查并安装 UV、Bun
2. 创建 Python 虚拟环境
3. 安装所有依赖 (PaddlePaddle, PaddleOCR, Robyn, SQLite 等)
4. 安装 MLX-VLM 推理后端 (Apple Silicon 加速,可选)
5. 安装前端依赖并构建
6. 配置魔搭 ModelScope 模型源
7. 后台启动 MLX-VLM 推理服务 (端口 8111,预加载模型)
8. 启动服务器并打开浏览器

> 首次运行时,PaddleOCR-VL-1.6 模型 (~2GB) 会自动从 ModelScope 下载;
> MLX-VLM 首次启动也会从 ModelScope 下载 MLX 格式模型 (~2GB, 国内 CDN 约 5 分钟),完成前 OCR 自动回退 CPU 推理。

### Apple Silicon 加速 (MLX-VLM)

在 Apple Silicon (M1/M2/M3/M4) 上,版面分析仍由 PaddlePaddle (CPU) 完成,但耗时最长的 VLM 识别阶段可外包给 MLX-VLM 服务,利用 Apple GPU 大幅提速:

- `start.sh` 自动安装 mlx-vlm 与 modelscope,首次从 ModelScope 下载模型到 `~/.cache/mlx_models/PaddlePaddle/PaddleOCR-VL-1.6` (HuggingFace 直连在国内易卡死,故走 ModelScope CDN),随后后台启动 MLX-VLM 服务 (端口 8111, 预加载模型)
- Web 服务初始化 OCR 引擎时自动探测 `http://localhost:8111/`,探测成功即启用 `mlx-vlm-server` 后端,否则回退本地 CPU 推理
- 环境变量可覆盖默认行为: `OCR_VL_REC_BACKEND`、`OCR_VL_REC_SERVER_URL`、`OCR_VL_REC_API_MODEL_NAME`、`OCR_VL_REC_MAX_CONCURRENCY`
- MLX 服务日志: `/tmp/mlx_vlm_server.log`

### 手动安装

```bash
# 1. 创建虚拟环境
uv venv --python python3.13

# 2. 安装 PaddlePaddle (CPU)
uv pip install paddlepaddle==3.2.1 \
    --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/

# 3. 安装 PaddleOCR
uv pip install -U "paddleocr[doc-parser]"

# 4. 安装其他依赖
uv pip install "robyn>=0.63" "pillow>=10.0" "python-docx>=1.1" "PyMuPDF>=1.24"

# 5. 安装前端依赖并构建
cd static && bun install && bun run build && cd ..

# 6. 启动
export PADDLE_PDX_LOCAL_MODEL_SOURCE="ModelScope"
.venv/bin/python server.py --open-browser
```

## 使用指南

### 上传文件

1. 打开页面后,默认显示上传区域
2. 点击上传区域或拖拽文件到此处
3. 也可直接拖拽文件到侧边栏「新建解析」按钮(结果页中不打断当前阅读)或收缩态 FAB 上
4. 支持格式: PDF / PNG / JPG / BMP / GIF / TIFF / WEBP
5. 支持多文件同时上传,任务按队列顺序处理
6. 首页「任务队列」面板实时显示排队/处理中任务及页级进度,点击卡片直达批次;刷新页面自动恢复

### 查看解析结果

- **对比视图** — 左侧显示带边界框标注的原图,右侧显示解析后的 Markdown(按识别块分块渲染,带中文标签)
- **蒙层联动** — 原始图片模式下叠加 SVG 识别区域蒙层(四色置信度);hover 蒙层多边形 ↔ hover Markdown 块双向高亮,图片侧 hover 自动滚动到对应文本并显示标签+置信度
- **块级复制** — hover 任一识别块,右上角浮现复制按钮,复制该块 Markdown 源码(含 `$...$` 公式)
- **蒙层开关** — 点击 layers 图标显示/隐藏识别区域框,状态持久化;标注图模式下自动隐藏
- **视图模式** — 可切换"对比"、"仅原图"、"仅结果"三种模式
- **全屏放大** — 点击面板右上角全屏按钮,放大到整个页面方便复制
- **同步滚动** — 左右面板可同步滚动,方便对照
- **缩放** — 原图面板支持放大/缩小/重置按钮,以及 Ctrl+滚轮、触摸板双指捏合缩放(中心跟随光标)
- **标注切换** — 点击太阳图标切换"标注原图"与"原始图片"
- **页面导航** — 使用左右箭头或键盘 ← → 键翻页

### 置信度色块

原图标注中,每个识别区域以颜色标注置信度:

| 颜色 | 含义 | 置信度范围 |
|---|---|---|
| 绿色 | 高置信度 | ≥ 90% |
| 蓝色 | 中高置信度 | 75% – 90% |
| 黄色 | 中低置信度 | 60% – 75% |
| 红色 | 低置信度 | < 60% (需人工校对) |

### 历史批次

- 左侧侧边栏显示所有历史批次,按时间倒序排列
- 处理中/排队的批次行内直接显示实时进度(解析中 x/y 页 · 文件 n/N + 进度条),无需展开
- 点击批次可展开查看文件列表和进度
- 每个文件显示: 状态、页数进度、处理耗时
- 点击编辑图标可设置批次别名
- 可删除不需要的批次

### 导出

- **Markdown 导出** — 点击 "MD" 按钮下载;文档内图片以 base64 data URI 内嵌,单文件自包含,可脱离平台分享
- **Word 导出** — 点击 "Word" 按钮下载 .docx,还原布局含表格图片;LaTeX 公式自动转换为 Unicode 符号(300+ 符号表,如 `\triangle`→△、`\perp`→⊥),Word 中直接可读
- 导出文件名格式: `{批次号}_{文件序号}_{文件名}.docx`

## 项目结构

```
mathocr/
├── server.py              # Robyn 主服务器
├── ocr_engine.py          # PaddleOCR-VL 封装 (并行处理)
├── batch_manager.py       # 批次管理 (SQLite 元数据)
├── image_annotator.py     # 原图标注 (bbox + 置信度色块)
├── pdf_renderer.py        # PDF 页面渲染 (PyMuPDF)
├── exporter.py            # Markdown(base64图片内嵌) / Word 导出
├── latex_utils.py         # LaTeX → Unicode 符号转换 (Word 导出)
├── event_bus.py           # SSE 事件总线 (支持 "*" 全局订阅)
├── job_queue.py           # SQLite 持久化任务队列 (中断恢复)
├── start.sh               # 一键启动脚本
├── setup.sh               # 手动安装脚本
├── pyproject.toml         # Python 依赖配置
├── app.py                 # 旧 Gradio 应用 (备份)
├── AGENTS.md              # AI 代理交接文档
├── static/                # 前端资源
│   ├── package.json       # Bun 依赖配置
│   ├── src/vendor.js      # 前端依赖入口
│   ├── dist/              # 构建产物
│   ├── css/style.css      # 样式
│   └── js/                # 前端逻辑
│       ├── app.js         # 主逻辑 + 全局 SSE 分发
│       ├── sidebar.js     # 侧边栏 (批次级实时进度)
│       ├── upload.js      # 上传 (SSE) + 首页任务队列面板
│       └── viewer.js      # 对比查看器 (蒙层联动/块复制/滚轮缩放)
├── batches/               # 批次数据 (gitignored)
│   ├── metadata.db        # SQLite 元数据库
│   └── YYYYMMDD_HHMMSS/   # 每个批次一个文件夹
│       ├── uploads/       # 原始上传文件
│       └── results/       # OCR 结果
│           └── {file_id}/
│               ├── page_0_original.png
│               ├── page_0_annotated.png
│               ├── page_0.json
│               ├── page_0.md
│               └── page_0_images/
└── testset/               # 测试文件
```

## API 文档

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | 上传文件,创建批次,入队处理 |
| GET | `/api/batches` | 列出所有批次 (支持 `?status=completed` 筛选) |
| GET | `/api/batch/:batch_id` | 获取批次详情 (含文件和页面信息) |
| DELETE | `/api/batch/:batch_id` | 删除批次 |
| POST | `/api/batch/:batch_id/alias` | 设置批次别名 |
| GET | `/api/batch/:batch_id/file/:file_id` | 获取文件页面列表 |
| GET | `/api/batch/:batch_id/file/:file_id/page/:page_id` | 获取页面 Markdown + JSON |
| GET | `/api/image/:batch_id/:file_id/:page_id?type=original\|annotated` | 获取页面图片 |
| GET | `/api/page_image/:batch_id/:file_id/:page_id/:img_name` | 获取文档中提取的图片 |
| GET | `/api/export/:batch_id?format=md\|docx&file_id=xxx` | 导出 |
| GET | `/api/events` | 全局 SSE 事件流 (所有批次,含 `batch_queued`) |
| GET | `/api/events/:batch_id` | 单批次 SSE 实时事件流 |
| GET | `/api/queue/status` | 队列状态 |
| GET | `/api/legend` | 获取置信度色块图例 |

## 开发

### 前端开发

```bash
cd static
bun install
bun run dev  # watch 模式,自动重建 vendor.js
```

### 后端开发

```bash
.venv/bin/python server.py  # 启动开发服务器
```

## 参考

- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
- [PaddleOCR-VL-Apple-Silicon]https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.md)
- [MinerU](https://github.com/opendatalab/MinerU) — UI 设计参考
- [Robyn](https://github.com/sparckles/robyn) — Rust 内核 Python Web 框架
- [ModelScope](https://modelscope.cn) — 模型下载源
