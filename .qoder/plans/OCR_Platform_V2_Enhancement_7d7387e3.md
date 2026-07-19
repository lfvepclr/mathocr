# OCR 平台 4 项问题修复

## Summary

1. Word 导出 LaTeX 符号未转换(显示 `\triangle` `\perp` 源码) → 新增 LaTeX→Unicode 转换器
2. 侧边栏收起仍占 48px 且标注图左侧被遮挡 → 收起改为左上角 FAB(新建+拖拽上传),修复图片 flex 居中裁剪
3. 处理中断后重启任务丢失 → SQLite 持久化队列 + 启动时恢复中断批次/文件
4. 单页处理耗时长无反馈 → 改用 `predict_iter` 流式逐页处理 + 页级精确进度 + 单页时间估算百分比

## 1. LaTeX → Unicode 转换(Word 导出)

**根因**: [exporter.py](file:///Users/spencer/workspace/qoder/mathocr/exporter.py) `_add_formatted_paragraph()` 中 `LATEX_INLINE_RE.sub(lambda m: m.group(1).strip(), text)` 仅去掉 `$`,留下 `\triangle ABC` 源码。Markdown 导出已是 `$...$` 包裹的正确格式(支持 KaTeX 渲染),保持不变。

### 新建 `latex_utils.py`

```python
LATEX_SYMBOLS = {
    # 几何/关系: triangle→△ perp→⊥ angle→∠ parallel→∥ cong→≌ sim→∼
    # 运算: times→× div→÷ cdot→· pm→± leq→≤ geq→≥ neq→≠ approx→≈
    # 希腊: alpha→α beta→β gamma→γ theta→θ pi→π Delta→Δ Omega→ω ...
    # 其他: infty→∞ sum→∑ int→∫ because→∵ therefore→∴ in→∈ ...
}
SUPERSCRIPT_MAP = {'0':'⁰','1':'¹','2':'²','3':'³','n':'ⁿ','+':'⁺','-':'⁻', ...}
SUBSCRIPT_MAP = {'0':'₀','1':'₁','2':'₂','i':'ᵢ','n':'ₙ', ...}

def latex_to_unicode(s: str) -> str:
    # 1. \\frac{a}{b} → a/b;  \\sqrt{x} → √(x)
    # 2. \\text{}/\\mathrm{}/\\mathbf{} → 保留内容
    # 3. ^\\circ → °; ^{...}/^x → Unicode 上标; _x → 下标
    # 4. 符号表替换(正则 \\cmd(?![a-zA-Z]),长命令优先)
    # 5. 清理 \\left \\right \\, \\; \\quad \\displaystyle 及残留 {}
```

### 修改 `exporter.py`
- `_add_formatted_paragraph()`: `LATEX_BLOCK_RE`/`LATEX_INLINE_RE` 替换回调改为 `latex_to_unicode(m.group(1))`
- 标题处理(`_add_markdown_to_doc` header 分支)同样应用转换
- `_add_table_to_doc()` 单元格文本应用转换(表格内可能含公式)

**验证用例**: `$\triangle ABC$`→△ABC; `$AD \perp BC$`→AD ⊥ BC; `$\angle BDA = \angle CDA = 90^\circ$`→∠BDA = ∠CDA = 90°

## 2. 侧边栏收起改为 FAB + 图片遮挡修复

### 图片遮挡根因
[style.css](file:///Users/spencer/workspace/qoder/mathocr/static/css/style.css) `.image-container` 用 `display:flex; justify-content:center`,图片宽于容器时左侧溢出到负坐标区域,`overflow:auto` 无法滚动到 → 左边缘被裁。

### 修改 `static/index.html` — 新增 FAB
```html
<div id="sidebar-fab" class="sidebar-fab" style="display:none">
  <button id="fab-new" class="fab-btn fab-new" title="新建解析(可拖拽文件到此处)">
    <svg>+ 图标</svg><span>新建</span>
  </button>
  <button id="fab-expand" class="fab-btn" title="展开侧边栏">
    <svg>» 图标</svg>
  </button>
</div>
```

### 修改 `static/css/style.css`
- `#sidebar.collapsed { width: 0; min-width: 0; border-right: none; }`(完全隐藏)
- `.sidebar-fab`: `position:fixed; top:12px; left:12px; z-index:900; border-radius:24px; padding:6px 10px; box-shadow:var(--shadow-lg); background:var(--surface); display:flex; gap:4px;`(沿用 indigo 设计系统)
- `.sidebar-fab.dragover { border-color:var(--primary); background:var(--primary-light); }`
- `.fab-new`: 主按钮样式(primary 色 + 图标 + "新建"文字)
- `.image-container { display:block; }`,`.image-container img { margin:0 auto; }`(窄图居中、宽图从左起可滚动)

### 修改 `static/js/app.js`
- 收起时显示 `#sidebar-fab`,展开时隐藏(与 localStorage 状态联动)

### 修改 `static/js/upload.js`
- `init()` 中为 FAB 绑定: 点击 `fab-new` → `App.showUploadView()`; 点击 `fab-expand` → 展开侧边栏; dragover/dragleave/drop → 高亮 + `uploadFiles()`

### 修改 `static/js/viewer.js` — `applyZoom()`
```javascript
if (App.state.zoom > 1) {
  img.style.transformOrigin = 'top left'; img.style.margin = '0';
} else {
  img.style.transformOrigin = 'top center'; img.style.margin = '0 auto';
}
```

## 3. SQLite 持久化队列 + 中断恢复

### 重写 `job_queue.py`(SQLite 为队列存储)
- `enqueue(batch_id)`: `UPDATE batches SET status='queued' WHERE batch_id=?` + `threading.Event` 唤醒 worker
- worker 循环: `SELECT batch_id FROM batches WHERE status='queued' ORDER BY created_at ASC LIMIT 1` → 取到则置 `processing` 后调用 `batch_manager.process_batch_background()`; 无任务时 `event.wait(1s)`
- `recover_interrupted()`: 启动时执行
  - `UPDATE batches SET status='queued' WHERE status='processing'`
  - `UPDATE files SET status='pending' WHERE status='processing'`
  - 返回恢复批次数量
- `get_status()`/`get_all_status()` 改从 DB 查询(重启后状态不丢)

### 修改 `batch_manager.py`
- `process_batch_background()`: 文件列表过滤 `status != 'completed'`(已完成文件不重复 OCR);最终状态判断仍基于全部文件
- `_process_single_file()` 开头防御: 若 `total_pages > 0` 且 pages 表已有 `>= total_pages` 条 `has_result=1` 记录且 md 文件存在 → 直接置 `completed` 并 return(覆盖"页面保存完但文件状态未更新"的中断场景);页级结果靠 `INSERT OR REPLACE` 自然覆盖,无需额外处理

### 修改 `server.py`
- 启动时 `job_queue.start()` 前调用 `recover_interrupted()` 并日志输出恢复数量

### 前端
- [sidebar.js](file:///Users/spencer/workspace/qoder/mathocr/static/js/sidebar.js) 已支持 `queued` 状态("排队"标签),无需改动

## 4. 页级精确进度 + 单页估算百分比

**关键发现**: `PaddleOCRVL.predict()` 本质是 `list(self.predict_iter(...))`,底层 paddlex pipeline 是生成器,**每页推理完成即 yield 一页**。可流式消费,第一页结果即时可见。VLM 单页内部(`infer.generate`)无回调,单页进度用时间估算。

### 修改 `ocr_engine.py`
```python
def process_document_iter(file_path: str):
    """流式逐页处理,每页推理完成即 yield (page_idx, page_result)"""
    pipeline = get_pipeline()
    for idx, res in enumerate(pipeline.predict_iter(file_path)):
        # 复用现有单页解析逻辑(markdown/json/page_data)
        yield idx, page_result
```
- 保留 `process_document()`(内部改为 `list(process_document_iter(...))` 收集)兼容旧调用

### 修改 `batch_manager.py`
- `_process_single_file()` 改为流式消费:
  - 渲染原图得 `total_pages` 后,`for page_idx, page_result in enumerate(ocr_engine.process_document_iter(...))`
  - 每页立即 `_process_single_page()` 保存 + 发布 `page_completed`(补充 `total_pages`、`completed_pages` 字段)
  - 每页保存后发布下一页 `page_started {file_id, page_id, total_pages, avg_page_time}`
- 新增 `get_avg_page_time()`: `SELECT AVG(processing_time) FROM pages WHERE processing_time > 0`(无数据默认 60s),用于前端估算

### 修改 `static/js/upload.js`
- SSE 新增监听 `page_started`: 记录起始时间 + `avg_page_time`,启动本地 interval 平滑更新估算百分比 `pct = min(elapsed/avg, 95)%`
- 总进度条 = `(completedPages + 当前页估算比例) / totalPages`
- `progress-text` 显示: `正在解析第 3/11 页 · 约 45% · 已用 12s`
- 修复附带 bug: `App.openBatch()` 调用 `startPolling(batchId)` 时缺少 progressFill/Text 参数 → `startSSE`/`startPolling` 内部参数缺失时自行 `getElementById` 获取;`openBatch` 改用 `startSSE`

### 修改 `static/js/sidebar.js`
- 暴露 `Sidebar.handleProgressEvent(type, data)`: processing 文件项实时更新 `已解析 X/N 页` 进度条(upload.js 的 SSE 处理器中调用)
- `page_started` 时文件项进度条按估算值微调

## 测试计划

1. **LaTeX 转换**: 重导出批次 `20260719_135810` 的 Word → 验证 △ABC、AD ⊥ BC、∠BDA = ∠CDA = 90°;导出 md 仍含 `$...$`
2. **FAB**: 收起侧边栏 → FAB 出现在左上角;点"新建"→上传视图;拖文件到 FAB → 高亮并上传;点 » 展开;刷新页面状态保持
3. **图片遮挡**: 打开批次确认标注图左边缘完整可见,放大后四向可滚动
4. **中断恢复**: 上传多页 PDF,处理中 kill 服务 → 重启 → 批次自动重新入队;已 completed 文件不重复 OCR;处理中文件从头重跑该文件
5. **进度显示**: 上传多页 PDF,观察上传区/侧边栏显示"第 X/N 页"及估算百分比;第一页完成即出结果

## 文件变更汇总

| 文件 | 操作 | 改动 |
|------|------|------|
| `latex_utils.py` | 新建 | LaTeX→Unicode 符号/上下标/分式转换 |
| `exporter.py` | 修改 | Word 导出正文/标题/表格应用 LaTeX 转换 |
| `job_queue.py` | 重写 | SQLite 持久化队列 + 中断恢复 |
| `batch_manager.py` | 修改 | 流式处理、page_started 事件、完成文件跳过、avg_page_time |
| `ocr_engine.py` | 修改 | 新增 process_document_iter 流式接口 |
| `server.py` | 修改 | 启动时恢复中断批次 |
| `static/index.html` | 修改 | 新增 sidebar-fab |
| `static/css/style.css` | 修改 | collapsed 隐藏、FAB 样式、image-container 修复 |
| `static/js/app.js` | 修改 | FAB 显隐联动 |
| `static/js/upload.js` | 修改 | FAB 拖拽上传、page_started 估算进度、参数容错 |
| `static/js/sidebar.js` | 修改 | 实时进度更新接口 |
| `static/js/viewer.js` | 修改 | applyZoom 原点/边距修复 |
