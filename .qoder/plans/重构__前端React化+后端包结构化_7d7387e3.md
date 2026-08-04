# MathOCR 重构: 框选浮动条优化 + 前端 React 化 + 后端包结构化

## 摘要与已确认决策

- **框选浮动条**: `#selection-bar` 现固定在左面板底部,右侧框选后须跨面板操作。改为单例浮动条,跟随用户最后框选的面板,浮在该面板底部中央。
- **前端重构**: React 19 + Vite + TypeScript + zustand(已确认)。目标: 模块化、职责单一;现有 5 个 vanilla JS(共 3129 行)+ 393 行 HTML + 1240 行 CSS 全量迁移;视觉观感与交互行为以现状为准(像素级保真)。
- **后端重组**: 现有 8 个平铺模块(共 4085 行)重组为 `app/` 包,Robyn 保留,`server.py` 留薄 shim 兼容启动命令。
- **Python 保持 3.13(uv 管理,不升 3.14)**: 已核实 Paddle 官方索引无任何 cp314 wheel(最新 3.3.1 最高 cp313);robyn/mlx/PyMuPDF/pillow 虽已有 cp314,但升级会永久禁用本地引擎,用户确认不升。`pyproject.toml` 声明 `requires-python = ">=3.13,<3.14"`,依赖集中由 uv 安装。
- **基线**: 上一轮 4 项改进(尺寸缩放/隐藏滚动条/锚块同步/右侧框选)代码已落地但 browser 冒烟被取消,阶段 0 先补基线验证再动刀。

## 前置状态

- 服务 http://localhost:7861 运行中;单测 26 例(test_layout_render 11 + test_richtext_multi 15)全过。
- 关键文件: `static/js/{app,viewer,sidebar,upload,settings}.js`、`static/index.html`、`static/css/style.css`;后端 `server.py / batch_manager.py / exporter.py / ocr_engine.py / engine_{registry,baidu,siliconflow}.py`(注意: 无独立 db.py,SQLite 逻辑在 batch_manager 内,执行期核实)。

---

## 阶段 0: 框选浮动条跟随 + 基线冒烟(当前 vanilla 栈,小改先行)

### 0.1 浮动条改造(`static/js/viewer.js` + `static/css/style.css`)

1. `bandStart(e, panel)` 内记录 `this._selPanel = panel`('img'/'result')。
2. `updateSelectionBar()`: 显示前把 bar 单例移动到当前面板——`const host = document.getElementById(this._selPanel === 'result' ? 'right-panel' : 'left-panel'); if (bar.parentElement !== host) host.appendChild(bar);`(`index.html` 中 bar 初始仍在 left-panel,无需改 HTML)。
3. CSS: `.selection-bar` 改 `position:absolute; bottom:12px; left:50%; transform:translateX(-50%); z-index:30;`(现有圆角深色 pill 样式保留);确认 `.panel { position:relative }`,缺则补。
4. 复制/清空/Esc/翻页清空逻辑不变;`#selection-bar` 的 `title` 即时提示不受影响。

### 0.2 基线冒烟(browser 子代理,7861,批次 20260801_223030 + 20260719_204929 双文件)

- 上轮 4 项: fit 对齐(img 宽=容器宽−32 ±4px、中线偏差 ±4px);两容器 `scrollbar-width:none` 且可滚;锚块同步(左右互滚后 `Viewer._anchorLeft()` 与 `_anchorRight()` 同 idx、offset 差 <40px,2 倍缩放后仍成立);右侧框选(按钮双 active、流式/版面拖框 N>0、单击 toggle、richtext API 200、清空、Esc)。
- 本轮浮动条: 右侧拖框后 `bar.parentElement.id === 'right-panel'` 且 bottom 浮动可见;复制/清空可点;左侧拖框后 bar 回到 left-panel。
- 控制台无 error;单测 26 例回归。

## 阶段 1: 后端包结构化(Python 3.13 + uv)

### 1.1 目标结构

```
app/
  __init__.py
  main.py              # create_app(): Robyn 实例、静态服务、路由注册、CLI(--port/--open-browser),原 server.py 尾部逻辑
  config.py            # BATCHES_DIR 等路径常量、环境变量读取(散点收拢)
  api/
    __init__.py        # register_routes(app) 汇总
    upload.py          # POST /api/upload
    batches.py         # /api/batches、/api/batch/:id(/file/:fid(/page/:pid))
    media.py           # /api/image/...、/api/page_image/...(含 basename 兜底)
    export.py          # /api/export、/api/page_richtext
    settings.py        # /api/settings、/api/engines、/api/legend
    events.py          # SSE 全局/单批次流
  services/
    __init__.py
    batch_manager.py   # 队列/进度/SQLite(_EXPECTED_COLUMNS/_migrate_columns)/落盘归一化(原 batch_manager.py 1014 行)
    exporter.py        # Word/MD/版面 HTML/richtext(原 exporter.py 976 行)
  engines/
    __init__.py
    base.py            # EngineError、引擎协议/数据类(从 engine_registry 拆出)
    registry.py        # 引擎注册/配置/用量/local_runtime_available
    local.py           # PaddleOCR-VL + MLX-VLM(原 ocr_engine.py)
    baidu.py
    siliconflow.py
  utils/
    __init__.py
    (按执行期实际散点收拢,如 latex/图片工具;无独立 db.py 则 SQLite 留在 services/batch_manager.py)
server.py              # 薄 shim: from app.main import main; main()(兼容 start.sh 与文档命令)
```

### 1.2 依赖与环境(uv)

- 根目录 `pyproject.toml` 补齐 `[project]`(name/version/`requires-python = ">=3.13,<3.14"`)+ `dependencies`: robyn、pillow、python-docx、PyMuPDF 等运行依赖;**paddlepaddle/paddleocr 不入 dependencies**(自定义索引 + 移除风险,AGENTS.md 排查 1 已有),start.sh 保留独立安装行。
- `start.sh`: `uv pip install -r pyproject.toml` 替代逐行列举;paddle 行不变;Python 仍 `uv venv --python python3.13`。
- import 全量改绝对导入(`from app.services.batch_manager import ...`);tests 同步改 import;必要时 `tests/conftest.py` 处理 sys.path。

### 1.3 验证

- `uv pip install -r pyproject.toml` 干净重装 .venv 后服务启动正常;单测 26 例全过;curl 冒烟(/、/api/batches、页面 API、richtext、export 各 1 条 200)。

## 阶段 2: 前端 React 重构(`web/` 新工程)

### 2.1 工程骨架

- `web/`: Vite + React 19 + TypeScript + zustand;包管理 bun(`bun install`);`vite build` 输出 `outDir: '../static'`(emptyOutDir),产物 `index.html + assets/`,Robyn 静态服务不变;开发用 `bunx vite build --watch` 或 vite dev server proxy 到 7861。
- marked / katex 改 npm 依赖直接 import(`import 'katex/dist/katex.min.css'`,字体由 Vite 打包),废除 `static/src/vendor.js` 手工 bun 打包与字体手拷;`static/package.json` 旧构建脚本随 vanilla 代码一并移除。
- hash 深链保持 `#batch/...` 与 `#/batch/...` 双格式兼容(自实现轻量 hash store,路由仅上传首页/批次详情两页,不引 react-router)。
- `.gitignore` 策略与现状一致(产物是否入库沿用现规则,必要时补 `static/assets/`)。

### 2.2 模块划分(职责单一)

```
web/src/
  main.tsx / App.tsx
  api/            # fetch 封装: batches.ts pages.ts export.ts settings.ts sse.ts(EventSource 封装,事件→store)
  stores/         # zustand: appStore(视图模式/当前批次文件页/深链) viewerStore(缩放/选中集/_selPanel/hover) queueStore(SSE 进度) settingsStore
  components/
    Sidebar/      # 批次树+时间分组+别名+引擎徽标
    Queue/        # 首页任务队列面板
    Upload/       # 拖拽上传+SSE/轮询进度
    TopBar/       # 视图互斥开关(data-mode)
    Viewer/
      SplitView.tsx       # 左右面板+divider 拖拽(localStorage 恢复+ResizeObserver 钳位)
      ImagePanel.tsx      # img+SVG 蒙层+fit/尺寸缩放+zoomAt 锚点校正
      OverlayPolygon.tsx
      ResultPanel.tsx     # 流式 FlowBlocks / 版面 LayoutCanvas(per-label 样式、shrink-to-fit)
      Lasso.tsx           # 双面板框选(左 bbox 求交/右 client-rect 求交)
      SelectionBar.tsx    # 浮动条,随 viewerStore.selPanel 渲染在对应面板
      BlockCopyButton.tsx # hover 浮动复制钮
      Tooltip.tsx         # overlay tooltip + 即时 title 提示
    Settings/     # 设置弹窗+用量费用
    Legends/      # 置信度/块类型图例
  lib/
    latex.ts      # normalizeLatexDelims + protectLeadingEnum + parseBlockMd(唯一入口,对应排查 16/18)
    blocks.ts     # LABEL_MAP/LABEL_CLASS_MAP/isPureImageBlock/blockAtPoint
    richtext.ts   # ClipboardItem 富文本写入+降级
    storage.ts    # localStorage key 集中(ocr_*)
  styles/         # CSS Modules 按组件拆分现有 style.css(变量 :root 保留为 global.css)
```

### 2.3 迁移里程碑(每个里程碑可构建+冒烟)

- **M1 框架与首页**: 工程脚手架、api/sse/stores、Sidebar/Queue/Upload/TopBar/Settings;上传→SSE 进度→批次直开链路通。
- **M2 查看器核心**: SplitView/ImagePanel/蒙层/hover 联动/尺寸缩放与 fit/divider/全屏/锚块同步滚动/Lasso 双面板框选 + SelectionBar 跟随浮动(含阶段 0 行为)。
- **M3 结果渲染与输出**: 流式分块渲染(KaTeX、标题样式、表格图片 API 前缀)、版面画布与 layoutZoom、块级/整页/框选复制到 Word(richtext API)、导出下拉、图例。
- 行为对齐基准: 以阶段 0 之后的 vanilla 版为准逐项对照(缩放数值、锚线 0.25、命中规则、Esc 顺序、tooltip、localStorage 键名不变)。

## 阶段 3: 全量回归与文档收尾

- 单测 26 例(import 更新后)+ browser 全矩阵冒烟(M1-M3 功能面: 上传/SSE/深链/对齐/滚动条/锚块同步/双面板框选/浮动条跟随/hover/复制/导出/视图互斥/divider/tooltip/图例/设置)。
- 删除 vanilla 残骸(`static/js/*`、`static/css/style.css`、`static/src/`、旧 `static/package.json`);确认 `static/` 仅含 React 构建产物。
- 文档: `AGENTS.md`(架构图改 app/ 包 + web/ 工程、构建命令 `cd web && bun run build`、浮动条说明、补一条"Python 暂不升 3.14: Paddle 无 cp314 wheel"决策记录);`README.md`(技术栈/启动命令/目录结构);`start.sh`(前端构建路径 static→web)。

## 假设与风险

- 功能冻结: 重构期间不加新功能;浮动条优化在阶段 0 先做是因为用户日常在用,React 版在 M2 等价实现。
- 视觉保真: style.css 全量迁移到 CSS Modules,逐组件对照;若个别全局选择器(滚动条/reset)无法模块化则留 global.css。
- Paddle 后续出 cp314 wheel 后,仅需改 requires-python 与 start.sh 的 venv 版本即可升 3.14(AGENTS.md 记录)。
- 后端拆分为纯移动+import 更新,不改任何业务逻辑;拆完必须 26 例全绿 + 启动冒烟过才进阶段 2。