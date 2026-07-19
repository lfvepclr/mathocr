# PaddleOCR-VL-1.6 + Gradio Web App

## Summary

Set up a UV-managed Python project, install PaddleOCR-VL-1.6 for Apple Silicon (CPU mode), and build a Gradio web interface that uploads images, runs document parsing via `PaddleOCRVL`, and renders the Markdown output with LaTeX math, HTML tables, and embedded images.

## Environment Setup (UV)

1. Initialize UV project in workspace root
2. Configure pyproject.toml with Python >= 3.10
3. Add dependencies:
   - `paddlepaddle==3.2.1` (CPU version via the paddlepaddle.org.cn index)
   - `paddleocr[doc-parser]`
   - `gradio>=4.0`
4. Create `.venv` via UV and install all dependencies
5. Document the install commands in a `setup.sh` helper script for reproducibility

## Gradio App (`app.py`)

### Pipeline Initialization
- Singleton `PaddleOCRVL(device="cpu")` pipeline loaded at startup
- Lazy initialization with progress feedback

### UI Layout
- **Left panel**: Image upload (`gr.Image`) + OCR trigger button
- **Right panel**: `gr.Markdown` component for rendering the result
- Support both click-to-upload and drag-and-drop

### Processing Logic
- Accept uploaded image path or numpy array
- Call `pipeline.predict(input_image_path)` 
- Extract markdown content via `res.markdown` attribute (dict with page-level markdown strings)
- Render the combined markdown in the output panel

### Markdown Rendering
- Gradio's `gr.Markdown` supports LaTeX via `latex_delimiters` parameter
- Set delimiters: `[{left: "$", right: "$", display: False}, {left: "$$", right: "$$", display: True}]`
- The model's output already includes HTML `<img>` tags (external CDN URLs) and `<table>` tags, which Gradio's Markdown component renders natively
- No additional transformation needed -- the model output is already valid Markdown+HTML

### State Management
- Track processing state (idle/processing/done/error)
- Show elapsed time
- Handle errors gracefully (display error message in the markdown panel)

## Test Plan

- Run the Gradio app with `python app.py`
- Upload the test image: `/Users/spencer/Documents/workspace/mathocr/Weixin Image_20260718224411_18_1.jpg`
- Verify the markdown output matches the reference: `Weixin Image_20260718224411_18_1.md`
- Verify LaTeX formulas render correctly
- Verify inline images load from CDN
- Verify tables render correctly

## File Changes

| File | Action | Purpose |
|------|--------|---------|
| `pyproject.toml` | NEW | UV project configuration with dependencies |
| `setup.sh` | NEW | One-command environment setup script |
| `app.py` | NEW | Gradio web application |
| `.gitignore` | NEW | Exclude .venv, output files, caches |
