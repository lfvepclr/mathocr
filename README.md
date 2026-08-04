# MathOCR — PaddleOCR-VL 文档解析平台

基于 PaddleOCR-VL 的文档智能解析平台,支持 PDF/图片多格式输入,队列化 OCR 识别,原图与解析结果对比(含置信度色块标注 + SVG 蒙层联动),历史批次管理,任务队列实时进度,Markdown/Word 导出。

识别引擎可在**本地推理**与**在线 API**(硅基流动 / 百度文档解析)之间逐批次切换,在线引擎带调用次数与费用统计。
![图片](assets/Snipaste_2026-07-19_15-57-47.png)
![图片](assets/Snipaste_2026-07-19_14-18-24.png)

## 功能特性

- **多文件批量上传** — 支持同时上传多个文件,自动生成批次号(年月日时分秒)
- **本地/在线双模式引擎** — 上传前可选本地 PaddleOCR-VL-1.6、硅基流动 API 或百度文档解析 API,选择随批次持久化
- **调用次数与费用统计** — 在线引擎逐次记录 tokens/页数与费用,首页展示今日/本月/累计用量,批次卡片实时显示当前费用与预估
- **队列化 OCR 识别** — SQLite 持久化任务队列,单工作线程串行处理,崩溃重启自动恢复中断批次
- **原图对比查看** — 左右分栏对比原图(带边界框标注)与解析结果,支持全屏放大
- **SVG 蒙层联动** — 原图上叠加识别区域多边形蒙层(置信度四色,可开关),hover 图片框 ↔ Markdown 块双向高亮联动
- **块级复制** — hover 任一识别块显示复制按钮,一键复制该块 Markdown 源码(含公式)
- **复制到 Word** — 结果区一键复制整页富文本,粘贴到 Word 保留标题层级/表格/图片,公式转 Unicode 符号;块级复制同享富文本通道
- **框选复制** — 原图或解析结果面板上拖框多选识别块(或逐个点选),选中集三侧高亮联动,一键复制为 Word 富文本
- **版面视图** — 结果区「流式|版面」切换,版面模式按识别框位置绝对定位还原原文档布局,字号自适应,蒙层联动与缩放两种模式通用
- **任务队列面板** — 首页实时列出排队/处理中任务及页级进度,刷新页面自动恢复显示
- **拖拽建任务** — 侧边栏「新建解析」按钮与收缩态 FAB 均为拖放区,处理文档中也能添加任务
- **批次级进度** — 侧边栏批次行内实时显示页级进度(解析中 x/y 页 · 文件 n/N),无需展开
- **置信度色块** — 每个识别区域以颜色标注置信度(绿/蓝/黄/红),快速定位低置信度内容
- **历史批次管理** — SQLite 存储元数据,按时间分组(今天/昨天/近 7 天/近 30 天/更早),支持别名、按状态筛选、处理耗时追踪
- **实时进度推送** — 全局 SSE (Server-Sent Events) 单连接推送所有批次事件,无需轮询
- **适应宽度缩放** — 原图默认缩放至面板宽度,页面中线与窗口中线对齐,Ctrl+滚轮与触摸板双指捏合缩放(中心跟随光标),重置键回到适应宽度;版面画布独立缩放
- **面板宽度可调** — 对比视图左右面板间的中线可拖拽调宽,宽度自动记忆
- **多格式导出** — Markdown(图片 base64 内嵌,自包含可分享)、Word(.docx,LaTeX 公式转 Unicode 符号)和版面 HTML(还原原始布局,可打印/另存 PDF)导出
- **侧边栏可收起** — 点击收起按钮展开/收起侧边栏,状态持久化;收缩后为贴边弧形拉手
- **魔搭模型源** — 默认从 ModelScope 下载模型,国内访问更稳定

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端框架 | Robyn | Rust 内核 Python Web 框架,高性能 |
| OCR 引擎 (本地) | PaddleOCR-VL-1.6 | 百度飞桨文档解析模型,完整版面解析 |
| OCR 引擎 (在线) | 硅基流动 / 百度文档解析 | OpenAI 兼容 Spotting / 云端异步整档解析 |
| 推理加速 | MLX-VLM (可选) | Apple Silicon GPU 推理后端,VLM 识别提速数倍 |
| 元数据存储 | SQLite | 内置于 Python 标准库,轻量 OLTP;启动时自动迁移补齐新增列,升级不影响旧数据 |
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

### 轻量启动 (无本地模型)

无法安装本地推理栈 (PaddlePaddle 安装失败 / 模型下载受限) 的电脑:

```bash
./start_remote.sh
```

仅安装 Web 服务依赖 (robyn / pillow / python-docx / PyMuPDF),不装 PaddlePaddle、不下载模型、不启动 MLX 服务。本地引擎自动显示为“不可用”并置灰,仅可使用在线引擎 (硅基流动 / 百度文档解析,需在设置中配置 Key);误通过 API 指定本地引擎时会收到可读错误提示。

### Apple Silicon 加速 (MLX-VLM)

在 Apple Silicon (M1/M2/M3/M4) 上,版面分析仍由 PaddlePaddle (CPU) 完成,但耗时最长的 VLM 识别阶段可外包给 MLX-VLM 服务,利用 Apple GPU 大幅提速。

实测数据 (Apple M4, 样本为 11 页数学教材 PDF, 含表格与公式):

| 推理后端 | 单页平均耗时 | 11 页总耗时 | 提速 |
|---|---|---|---|
| CPU (PaddlePaddle 本地推理) | ~76 秒/页 | ~14 分钟 | 1x |
| MLX-VLM (Apple GPU) | ~8.3 秒/页 | 91.75 秒 | **~9x** |

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

### 识别引擎选择

上传区上方可选择本次任务的识别引擎。三者能力不同,请按需选择:

| 引擎 | markdown 结构 | 区域蒙层 | 置信度 | 插图提取 | 表格/公式 | 计费 |
|---|---|---|---|---|---|---|
| 本地 PaddleOCR-VL-1.6 | 完整 | 有 | **有** | 有 | 结构化 | 免费 |
| 硅基流动 | 行级纯文本 | 有 | 无 | 无 | 无结构 | 按 token |
| 百度文档解析 | 完整(含表格) | 有 | 无 | 有 | 结构化 | 按页 |

> 置信度分数由本地版面检测模型给出,两个在线引擎不经过该模型。在线引擎的标注图与蒙层改为**按块类型着色**(正文/标题/表格/公式/图片/印章),图例自动切换。

### 配置在线引擎

点击侧边栏「设置」(或引擎选择器右侧的「配置」)填写 Key 与单价。两个在线引擎为折叠卡片,头部显示配置状态徽标与「获取 Key →」官方入口:

- 硅基流动: <https://cloud.siliconflow.cn/me/account/ak>
- 百度文档解析: <https://console.bce.baidu.com/ai-engine/ocr/app/list>

也可用环境变量给默认值(界面设置优先级更高):

```bash
export OCR_DEFAULT_ENGINE="local"                 # local | siliconflow | baidu

# 硅基流动
export SILICONFLOW_API_KEY="sk-..."
export SILICONFLOW_MODEL="PaddlePaddle/PaddleOCR-VL-1.5"
export SILICONFLOW_MAX_CONCURRENCY="4"            # 单文件内页级并发
export SILICONFLOW_PRICE_IN="0"                   # CNY / 1M tokens
export SILICONFLOW_PRICE_OUT="0"

# 百度文档解析
export BAIDU_OCR_API_KEY="..."
export BAIDU_OCR_SECRET_KEY="..."
export BAIDU_PRICE_PER_PAGE="0"                   # CNY / 页
```

单价默认均为 `0`,**代码不内置任何真实报价**。请按你在对应平台的实际计费方案填写;未填写时界面显示“未配置单价”而不估算费用。API Key 保存后界面只以掩码展示,编辑时留空即表示不修改。

未配置 Key 的在线引擎无法选中,上传会被直接拒绝(不会创建垃圾批次)。

### 查看解析结果

- **对比视图** — 左侧显示带边界框标注的原图,右侧显示解析后的 Markdown(按识别块分块渲染,带中文标签)
- **蒙层联动** — 原始图片模式下叠加 SVG 识别区域蒙层(四色置信度);hover 蒙层多边形 ↔ hover Markdown 块双向高亮,图片侧 hover 自动滚动到对应文本并显示标签+置信度
- **块级复制** — hover 任一识别块,右上角浮现复制按钮,复制该块 Markdown 源码(含 `$...$` 公式)
- **蒙层开关** — 点击 layers 图标显示/隐藏识别区域框,状态持久化;标注图模式下自动隐藏
- **视图模式** — 可切换"对比"、"仅原图"、"仅结果"三种模式
- **流式/版面切换** — 结果区左上角「流式|版面」开关:流式为重排的 Markdown 阅读视图;版面按识别框位置绝对定位,还原原文档布局(类 PDF),hover 联动、缩放、块级复制两种模式通用,选择持久化
- **复制到 Word** — 结果区复制按钮一键复制整页富文本,粘贴到 Word 保留标题层级/表格/图片,公式转为 Unicode 符号;块级复制按钮同样写入富文本(非安全上下文自动降级纯文本)
- **全屏放大** — 点击面板右上角全屏按钮,放大到整个页面方便复制
- **同步滚动** — 左右面板按识别块位置锚定同步滚动(缩放后仍精确对齐),方便对照;对比视图滚动条自动隐藏
- **缩放** — 原图默认适应面板宽度,图片宽度始终等于面板宽度、左右中线对齐;提供放大/缩小/重置按钮(重置回适应宽度),以及 Ctrl+滚轮、触摸板双指捏合缩放(中心跟随光标);窗口或面板宽度变化时自动重算(手动缩放后保持不动);「版面」模式下结果画布用 Ctrl+滚轮独立缩放
- **面板拖拽** — 对比视图左右面板间的中线可左右拖拽调宽(两侧最小 280px),宽度自动记忆
- **即时提示** — 面板工具按钮悬停立即显示功能说明
- **标注切换** — 点击太阳图标切换"标注原图"与"原始图片"
- **页面导航** — 使用左右箭头或键盘 ← → 键翻页

#### 框选复制到 Word

1. 点击左面板或右面板工具栏的「框选」开关进入框选模式(自动切到原始图片,两面板光标均变为十字线)
2. 在原图或解析结果(流式/版面均可)上**拖框**,与框相交的识别块批量加入选中集;也可**单击**某个块切换其选中状态(误选时点一下即可取消)
3. 选中的块在原图蒙层、流式结果、版面视图三侧同步橙色高亮,底部浮动条显示「已选 N 块」
4. 点浮动条「复制到 Word」,选中块按原文顺序拼接为富文本写入剪贴板,粘贴到 Word 为独立段落(公式转 Unicode 符号);「清空」一键归零
5. 再点一次开关或按 Esc 退出框选模式(Esc 先清空选中,再按退出);翻页自动清空选中集

### 置信度色块

本地引擎的原图标注中,每个识别区域以颜色标注置信度:

| 颜色 | 含义 | 置信度范围 |
|---|---|---|
| 绿色 | 高置信度 | ≥ 90% |
| 蓝色 | 中高置信度 | 75% – 90% |
| 黄色 | 中低置信度 | 60% – 75% |
| 红色 | 低置信度 | < 60% (需人工校对) |

在线引擎不返回置信度,改为按块类型着色:

| 颜色 | 块类型 |
|---|---|
| 蓝色 | 正文 / 旁注 / 竖排文本 |
| 紫色 | 标题 |
| 橙色 | 表格 |
| 青色 | 公式 / 行内公式 / 公式编号 |
| 绿色 | 图片 / 图表 / 页眉图 / 页脚图 |
| 红色 | 印章 |
| 翠绿 | 图题 / 表题 |
| 灰蓝 | 页眉 / 页脚 / 页码 |
| 灰色 | 其他 |

### 历史批次

- 左侧侧边栏显示所有历史批次,按时间倒序排列,并按「今天/昨天/近 7 天/近 30 天/更早」分组
- 处理中/排队的批次行内直接显示实时进度(解析中 x/y 页 · 文件 n/N + 进度条),无需展开
- 点击批次可展开查看文件列表和进度;已完成的批次点击即直接打开第一个文件的解析结果
- 每个文件显示: 状态、页数进度、处理耗时
- 点击编辑图标可设置批次别名
- 可删除不需要的批次

### 导出

- **Markdown 导出** — 点击 "MD" 按钮下载;文档内图片以 base64 data URI 内嵌,单文件自包含,可脱离平台分享
- **Word 导出** — 点击 "Word" 按钮下载 .docx,还原布局含表格图片;LaTeX 公式自动转换为 Unicode 符号(300+ 符号表,如 `\triangle`→△、`\perp`→⊥),Word 中直接可读
- **版面 HTML 导出** — 导出菜单选「版面 HTML」下载自包含 .html,按原始版面绝对定位还原文本/图片/表格(公式为 Unicode 符号),浏览器直接打开、打印或另存 PDF
- 导出文件名格式: `{批次号}_{文件序号}_{文件名}.docx`

## 项目结构

```
mathocr/
├── server.py              # Robyn 主服务器
├── ocr_engine.py          # 引擎分发器 + 本地 PaddleOCR-VL 封装
├── engine_registry.py     # 引擎描述/配置解析/费用计算
├── engine_siliconflow.py  # 硅基流动远程 Spotting 引擎
├── engine_baidu.py        # 百度异步文档解析引擎
├── settings_store.py      # 设置 KV 表 + API 用量明细表
├── batch_manager.py       # 批次管理 (SQLite 元数据)
├── image_annotator.py     # 原图标注 (bbox + 置信度/类型色块)
├── pdf_renderer.py        # PDF 页面渲染 (PyMuPDF)
├── exporter.py            # Markdown(base64图片内嵌) / Word 导出
├── latex_utils.py         # LaTeX → Unicode 符号转换 (Word 导出)
├── event_bus.py           # SSE 事件总线 (支持 "*" 全局订阅)
├── job_queue.py           # SQLite 持久化任务队列 (中断恢复)
├── start.sh               # 一键启动脚本
├── start_remote.sh        # 轻量启动脚本 (无本地模型,仅在线引擎)
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
│       ├── settings.js    # 引擎选择器 / 设置弹窗 / 用量与费用
│       ├── sidebar.js     # 侧边栏 (批次级实时进度)
│       ├── upload.js      # 上传 (SSE) + 首页任务队列面板
│       └── viewer.js      # 对比查看器 (蒙层联动/块复制/滚轮缩放)
├── batches/               # 批次数据 (gitignored)
│   ├── metadata.db        # SQLite 元数据库 (含 settings / api_usage 表)
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
| POST | `/api/upload?engine=local\|siliconflow\|baidu` | 上传文件,创建批次,入队处理(缺省用默认引擎) |
| GET | `/api/batches` | 列出所有批次 (支持 `?status=completed` 筛选) |
| GET | `/api/batch/:batch_id` | 获取批次详情 (含文件和页面信息) |
| DELETE | `/api/batch/:batch_id` | 删除批次 |
| POST | `/api/batch/:batch_id/alias` | 设置批次别名 |
| GET | `/api/batch/:batch_id/file/:file_id` | 获取文件页面列表 |
| GET | `/api/batch/:batch_id/file/:file_id/page/:page_id` | 获取页面 Markdown + JSON |
| GET | `/api/image/:batch_id/:file_id/:page_id?type=original\|annotated` | 获取页面图片 |
| GET | `/api/page_image/:batch_id/:file_id/:page_id/:img_name` | 获取文档中提取的图片 |
| GET | `/api/export/:batch_id?format=md\|docx\|html&file_id=xxx` | 导出 (html = 版面还原自包含网页) |
| GET | `/api/page_richtext/:batch_id/:file_id/:page_id?block=idx\|blocks=1,5,7` | 页面/单块/多块 Word 友好富文本 `{html, text}`(`blocks` 优先于 `block`,多块按阅读顺序拼接) |
| GET | `/api/events` | 全局 SSE 事件流 (所有批次,含 `batch_queued`) |
| GET | `/api/events/:batch_id` | 单批次 SSE 实时事件流 |
| GET | `/api/queue/status` | 队列状态 |
| GET | `/api/legend?mode=score\|label` | 获取置信度色块或块类型图例 |
| GET | `/api/engines` | 引擎列表 (含配置状态与单价) |
| GET | `/api/settings` | 读取设置 (API Key 仅掩码) |
| POST | `/api/settings` | 保存设置 (空字符串 = 不修改密钥) |
| GET | `/api/usage?scope=today\|month\|all` | 调用次数与费用统计 (按引擎分组) |
| GET | `/api/usage/batch/:batch_id` | 单批次用量与费用 |
| GET | `/api/usage/estimate?engine=&pages=` | 费用预估 (无法估算时返回 `cost: null`) |

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
- [PaddleOCR-VL-Apple-Silicon](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.md)
- [MinerU](https://github.com/opendatalab/MinerU) — UI 设计参考
- [Robyn](https://github.com/sparckles/robyn) — Rust 内核 Python Web 框架
- [ModelScope](https://modelscope.cn) — 模型下载源
