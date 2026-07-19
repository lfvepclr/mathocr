# 任务队列与交互增强计划

## Summary

1. 侧边栏「新建解析」按钮支持拖拽文件直接创建任务（处理文档时不被打断）
2. 创建任务后历史批次立即刷新；批次行内显示页级实时进度（目前只有首页有）
3. 首页新增任务队列面板：列出排队/处理中批次并实时更新，刷新页面后自动恢复显示；任务完成后侧边栏状态同步
4. 图片面板支持 Ctrl+滚轮与触摸板双指捏合缩放
5. 收缩态 FAB 重设计：贴边弧形圆角拉手 + 上传语义图标，保留点击展开

**架构关键**：新增全局 SSE 通道 `GET /api/events`（event_bus 支持 `"*"` 通配订阅），前端 App 级单连接分发事件到侧边栏与首页队列面板——不再依赖 Uploader 按批次开的 SSE，刷新页面后依然实时。

## 1. 后端：全局事件通道

### [event_bus.py](file:///Users/spencer/workspace/qoder/mathocr/event_bus.py)
- `publish()`：event 注入 `"batch_id": batch_id` 字段；除投递给该 batch 的订阅者外，同时投递给 `"*"`（全局）订阅者
  ```python
  event = {"type": event_type, "batch_id": batch_id, "data": data, "timestamp": ...}
  subs = list(self._subscribers.get(batch_id, [])) + list(self._subscribers.get("*", []))
  ```

### [server.py](file:///Users/spencer/workspace/qoder/mathocr/server.py)
- 新增 `GET /api/events`（无 batch_id）：`event_bus.subscribe("*")`，流式格式与现有 `batch_events` 完全一致（事件名 = type，data = 含 batch_id 的 payload，ping 保活）

### [job_queue.py](file:///Users/spencer/workspace/qoder/mathocr/job_queue.py)
- `enqueue()` 末尾 `event_bus.publish(batch_id, "batch_queued", {"batch_id": batch_id})`，让首页/侧边栏即时出现排队卡片（无需等刷新）

## 2. 侧边栏拖拽创建任务（需求 1）

### [upload.js](file:///Users/spencer/workspace/qoder/mathocr/static/js/upload.js)
- `uploadFiles(fileList, opts = { autoOpen: true })`：存 `this._autoOpen = opts.autoOpen`
- `startSSE` / `startPolling` 的 `batch_completed` 分支：`if (this._autoOpen) setTimeout(() => App.openBatch(batchId), 500)`，否则仅 `Sidebar.loadBatches()`（侧边栏拖入时不跳走，用户继续看当前文档）
- `init()` 新增：侧边栏 `#new-parsing-btn` 作为 drop zone（复用 FAB 的三段监听模式）：
  ```javascript
  const npBtn = document.getElementById('new-parsing-btn');
  npBtn.addEventListener('dragover', e => { e.preventDefault(); npBtn.classList.add('dragover'); });
  npBtn.addEventListener('dragleave', () => npBtn.classList.remove('dragover'));
  npBtn.addEventListener('drop', e => {
    e.preventDefault(); npBtn.classList.remove('dragover');
    if (e.dataTransfer.files.length) this.uploadFiles(e.dataTransfer.files, { autoOpen: false });
  });
  ```
  （点击行为不变，仍跳首页上传视图）
- 上传成功拿到 batch_id 后立即 `Sidebar.loadBatches()` + `QueuePanel.refresh()`（需求 2 的"立即刷新"）

### [style.css](file:///Users/spencer/workspace/qoder/mathocr/static/css/style.css)
- `.btn-primary.dragover`：虚线描边高亮（`outline: 2px dashed #fff; outline-offset: -4px; background: var(--primary-hover)`），按钮 title 改为「点击或拖拽文件到此处新建解析」

## 3. FAB 重设计（需求 6：弧形圆角 + 上传语义图标）

### [index.html](file:///Users/spencer/workspace/qoder/mathocr/static/index.html)
- `#sidebar-fab` 结构改为贴左缘弧形拉手，两个图标按钮：
  - `#fab-new`：图标换成**上传语义**（托盘+向上箭头，即 upload 图标），去掉「新建」文字（用户：文字不重要），`title="新建解析：点击或拖拽文件到此处"`
  - `#fab-expand`：chevron-right 图标，`title="展开侧边栏"`（点击展开功能保留，逻辑不变）

### [style.css](file:///Users/spencer/workspace/qoder/mathocr/static/css/style.css)
- `.sidebar-fab` 改为贴边弧形：`left: 0; top: 14px; border-radius: 0 26px 26px 0; padding: 8px 14px 8px 10px;`，去掉原 `left: 12px; border-radius: 24px`，视觉为从屏幕左缘伸出的半圆拉手；dragover 高亮逻辑保留
- `.fab-new` 调整为图标按钮形态（去文字后 `padding: 7px 10px`），`.fab-expand` 不变

## 4. 侧边栏批次级实时进度（需求 2/3）

### [sidebar.js](file:///Users/spencer/workspace/qoder/mathocr/static/js/sidebar.js)
- `renderBatchItem()`：`processing`/`queued` 批次在 header 下追加批次级进度行（未展开也可见）：
  ```html
  <div class="batch-progress" style="display:none">
    <div class="batch-progress-text">排队中...</div>
    <div class="file-progress-bar"><div class="file-progress-fill batch-progress-fill"></div></div>
  </div>
  ```
  `data-file-count="${batch.file_count}"` 存到 batch-item 上
- 新增 `Sidebar.batchProgress = {}` 缓存：`{batchId: {totalFiles, doneFiles, text}}`
- 新增 `handleGlobalEvent(type, data)`（由 App 全局 SSE 分发，data 含 batch_id）：
  - `batch_queued` → 显示进度行「排队中…」
  - `file_started` → 状态徽章就地改「处理中」，文本「解析中: filename」
  - `page_started`/`page_completed` → 文本「解析中 done/total 页 · 文件 n/N」，进度条宽度按 `(doneFiles + 页进度)/totalFiles`；若该批次处于 expanded，继续调现有 `handleProgressEvent` 更新 file-item 行（两者幂等共存）
  - `file_completed` → doneFiles++，刷新文本/进度条
  - `batch_completed` → `loadBatches()`（徽章变「完成」，进度行消失；满足"完成后历史批次更新状态"）
- 进度文本更新做 300ms 节流，避免页事件高频重排

### [style.css](file:///Users/spencer/workspace/qoder/mathocr/static/css/style.css)
- `.batch-progress { margin-top: 6px; } .batch-progress-text { font-size: 11px; color: var(--primary); }`（进度条复用 `.file-progress-bar/.file-progress-fill`）

## 5. 首页任务队列面板（需求 4）

### [index.html](file:///Users/spencer/workspace/qoder/mathocr/static/index.html)
- upload-view 内 `#upload-progress` 之后新增：
  ```html
  <div id="task-queue" class="task-queue" style="display:none">
    <div class="task-queue-title">任务队列</div>
    <div id="task-queue-list"></div>
  </div>
  ```

### [upload.js](file:///Users/spencer/workspace/qoder/mathocr/static/js/upload.js) 新增 `QueuePanel` 对象
- `refresh()`：`fetch('/api/batches')` 过滤 `queued`/`processing`，渲染卡片；空则隐藏整个区域
- 卡片内容：别名/批次号、状态徽章（排队/处理中）、进度文本（当前文件+页进度）、进度条；点击卡片 `App.openBatch(batchId)`
- `handleEvent(type, data)`（全局 SSE 驱动）：
  - `batch_queued` → refresh 或就地新增卡片
  - `file_started`/`page_started`/`page_completed`/`file_completed` → 更新对应卡片进度（缓存结构同 Sidebar）
  - `batch_completed` → 卡片标记完成并 1.5s 后移除（同时 `Sidebar.loadBatches()`）
- 页面加载时 `App.init` 调 `QueuePanel.refresh()` → **刷新页面后处理中任务自动恢复显示**

### [app.js](file:///Users/spencer/workspace/qoder/mathocr/static/js/app.js) `init()`
- 建立全局单连接并分发（Uploader 的 per-batch SSE 保留不动，用于首页大进度条/时间估算）：
  ```javascript
  const es = new EventSource('/api/events');
  ['batch_queued','file_started','page_started','page_completed','file_completed','batch_completed']
    .forEach(type => es.addEventListener(type, (e) => {
      const data = JSON.parse(e.data);
      Sidebar.handleGlobalEvent(type, data);
      QueuePanel.handleEvent(type, data);
    }));
  // EventSource 自带断线重连；onerror 时启动 5s 轮询 QueuePanel.refresh() 兜底，恢复后停止
  QueuePanel.refresh();
  ```

### [style.css](file:///Users/spencer/workspace/qoder/mathocr/static/css/style.css)
- `.task-queue { width: 480px; max-width: 90vw; margin-top: 24px; }` 卡片 `.task-card`（白底圆角 12px、边框、padding 12px、hover 阴影、cursor pointer）：名称行 + 状态徽章 + 进度文本 + 3px 进度条

## 6. 图片滚轮 / 双指捏合缩放（需求 5）

### [viewer.js](file:///Users/spencer/workspace/qoder/mathocr/static/js/viewer.js) `init()`
- `#image-container` 监听 wheel（`{ passive: false }`）：
  ```javascript
  container.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;   // 触摸板捏合上报 ctrlKey=true；鼠标为 Ctrl+滚轮
    e.preventDefault();
    this.zoomAt(e, Math.exp(-e.deltaY * 0.002));
  }, { passive: false });
  ```
- Safari 兼容：`gesturestart` 记 `_gestureZoom = App.state.zoom` 并 preventDefault；`gesturechange` → `App.state.zoom = clamp(_gestureZoom * e.scale)` + applyZoom
- 新增 `zoomAt(e, factor)`：clamp [0.25, 5]；transform-origin 设为光标在 wrapper 内的百分比位置（`((e.clientX-rect.left)/rect.width*100)%`），缩放逐帧平滑；缩放后 margin 规则沿用（>1 → `margin:0`，≤1 → `margin:0 auto`）
- `applyZoom(origin)` 加可选参数：传入时用该 origin，否则维持原 top-left/top-center 逻辑；zoom 按钮行为不变
- 缩放时 img 与 SVG 蒙层同 wrapper 一起变换，天然不错位

## 测试计划

1. **拖拽建任务**：打开批次 A 的结果页 → 拖文件到侧边栏「新建解析」→ 不离开当前页；侧边栏顶部出现新批次「排队」→「处理中」；首页上传区拖入仍自动跳转（回归）
2. **侧边栏进度**：处理中批次未展开时行内显示「解析中 3/11 页 · 文件 1/3」+ 进度条实时推进；展开后 file-item 进度同步；完成后徽章变「完成」并显示耗时
3. **首页队列**：上传两个批次 → 首页队列两张卡片实时进度；**刷新页面** → 队列卡片仍在并继续实时更新；全部完成 → 卡片消失、侧边栏状态变完成
4. **缩放**：Ctrl+滚轮与触摸板捏合均可缩放（0.25x–5x），缩放中心跟随光标；蒙层与原图不错位；缩放按钮/重置不受影响
5. **FAB**：收缩侧边栏 → 贴边弧形拉手显示；点击上传图标跳首页；拖拽文件到拉手触发上传；点击箭头展开侧边栏
6. **回归**：蒙层 hover 双向联动、块级复制、蒙层开关、深链接翻页（上一计划已完成代码，一并验证）

## 文件变更汇总

| 文件 | 改动 |
|------|------|
| `event_bus.py` | publish 注入 batch_id + "*" 通配投递 |
| `server.py` | 新增 `GET /api/events` 全局 SSE |
| `job_queue.py` | enqueue 发 `batch_queued` 事件 |
| `static/js/app.js` | init 建全局 EventSource 分发 + QueuePanel.refresh |
| `static/js/sidebar.js` | 批次级进度行 + handleGlobalEvent + 节流 |
| `static/js/upload.js` | uploadFiles autoOpen 参数、侧边栏 dropzone、QueuePanel 对象 |
| `static/js/viewer.js` | wheel/捏合缩放 zoomAt + gesture 兼容 |
| `static/index.html` | #task-queue 容器、FAB 结构（上传图标/去文字） |
| `static/css/style.css` | FAB 弧形、dragover 高亮、批次进度行、任务卡片 |

## Assumptions

- 侧边栏拖入创建任务后**不自动跳转**新批次（不打断当前阅读），仅更新侧边栏与队列面板；首页上传保持现有自动跳转
- 鼠标缩放采用 **Ctrl+滚轮**（滚轮默认保留滚动图片功能）；双指捏合在 macOS Chrome/Edge 上报为 ctrlKey wheel，Safari 走 gesture 事件
