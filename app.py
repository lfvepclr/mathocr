"""
PaddleOCR-VL-1.6 Document Parsing Web App
==========================================
A Gradio-based web interface for uploading document images,
running PaddleOCR-VL-1.6 recognition, and previewing structured
Markdown results with LaTeX math and embedded images.

Usage:
    uv run python app.py
"""

import base64
import io
import time
import traceback
from pathlib import Path

import gradio as gr

# ---------------------------------------------------------------------------
# Pipeline (lazy singleton)
# ---------------------------------------------------------------------------
_pipeline = None


def get_pipeline():
    """Return the global PaddleOCRVL pipeline, creating it on first call."""
    global _pipeline
    if _pipeline is None:
        from paddleocr import PaddleOCRVL

        _pipeline = PaddleOCRVL(
            device="cpu",            # Apple Silicon → CPU inference
            use_layout_detection=True,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_chart_recognition=False,
        )
    return _pipeline


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------
def _pil_to_base64(pil_image) -> str:
    """Convert a PIL Image to a base64 data URI string."""
    buf = io.BytesIO()
    # Preserve original format if available, otherwise use JPEG
    fmt = pil_image.format or "JPEG"
    pil_image.save(buf, format=fmt)
    data = base64.b64encode(buf.getvalue()).decode("utf-8")
    mime = f"image/{fmt.lower()}"
    return f"data:{mime};base64,{data}"


def _embed_images(markdown_text: str, images: dict) -> str:
    """
    Replace local image paths in markdown text with base64 data URIs.

    The model output contains `<img src="imgs/...jpg">` references. This
    function finds those paths in ``images`` and inlines the actual image
    data as base64 so the browser can display them without a file server.
    """
    result = markdown_text
    for filename, pil_img in images.items():
        # The filename may appear as-is or with a directory prefix
        b64_uri = _pil_to_base64(pil_img)
        # Replace: src="<path>" → src="<base64>"
        result = result.replace(f'src="{filename}"', f'src="{b64_uri}"')
        # Also try the basename only (in case path differs)
        basename = Path(filename).name
        if basename != filename:
            result = result.replace(f'src="{basename}"', f'src="{b64_uri}"')
    return result


def process_image(image):
    """
    Run PaddleOCR-VL on the uploaded image and return rendered markdown.

    Parameters
    ----------
    image : str | numpy.ndarray | None
        File path to the uploaded image, or None.

    Returns
    -------
    str
        Rendered markdown content to display in the Gradio Markdown component.
    """
    if image is None:
        return "### 请先上传一张图片"

    start_time = time.time()

    try:
        pipeline = get_pipeline()

        # Determine input path
        if isinstance(image, str):
            image_path = image
        else:
            # Gradio may pass a numpy array – save to a temp file
            from PIL import Image
            import tempfile

            pil_image = Image.fromarray(image)
            tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
            pil_image.save(tmp.name)
            image_path = tmp.name

        # Run document parsing
        output = pipeline.predict(image_path)

        # Build markdown for each page, embedding images as base64
        md_parts = []
        total_images = 0
        for res in output:
            md = res.markdown  # dict with keys: markdown_texts, markdown_images, ...
            if not md:
                continue

            text = md.get("markdown_texts", "")
            images = md.get("markdown_images", {})

            if images:
                text = _embed_images(text, images)
                total_images += len(images)

            if text:
                md_parts.append(text)

        elapsed = time.time() - start_time

        if not md_parts:
            return (
                "### 未检测到内容\n\n"
                "模型没有返回任何可识别的内容，请尝试另一张图片。"
            )

        combined_md = "\n\n".join(md_parts)

        # Build the final markdown with a header
        header = (
            f"> **识别完成**  |  "
            f"耗时: {elapsed:.1f}s  |  "
            f"内嵌图片: {total_images}\n\n---\n\n"
        )
        result = header + combined_md

        # Cleanup temp file if we created one
        if not isinstance(image, str):
            try:
                Path(image_path).unlink()
            except OSError:
                pass

        return result

    except Exception:
        trace = traceback.format_exc()
        return (
            "### 识别失败\n\n"
            "处理过程中发生错误：\n\n"
            f"```\n{trace}\n```"
        )


# ---------------------------------------------------------------------------
# Gradio UI
# ---------------------------------------------------------------------------

CUSTOM_CSS = """
.markdown-preview {
    min-height: 60vh;
    max-height: 85vh;
    overflow-y: auto;
    padding: 16px;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    background: #fafafa;
}
.footer {
    text-align: center;
    color: #888;
    font-size: 0.85em;
    margin-top: 12px;
}
"""


def build_ui():

    with gr.Blocks(
        title="PaddleOCR-VL-1.6 - Document Parsing",
    ) as demo:
        gr.Markdown(
            """
            # PaddleOCR-VL-1.6 Document Parsing

            Upload a document image to extract structured content —
            including **text**, **tables**, **formulas (LaTeX)**, and **embedded figures**.
            """
        )

        with gr.Row(equal_height=False):
            # ---- Left: Upload & Controls ----
            with gr.Column(scale=1, min_width=320):
                input_image = gr.Image(
                    label="Upload Document Image",
                    type="filepath",
                    sources=["upload", "clipboard"],
                )
                btn = gr.Button(
                    "Recognize Document",
                    variant="primary",
                    size="lg",
                )
                gr.Markdown(
                    """
                    **Tips**:
                    - Supports common image formats (JPG, PNG, etc.)
                    - First run will download model weights (~2 GB)
                    - Processing may take 30-120s depending on image complexity
                    """
                )

            # ---- Right: Result Preview ----
            with gr.Column(scale=2, min_width=480):
                result_md = gr.Markdown(
                    value="### Waiting for input...\n\nUpload an image and click **Recognize Document**.",
                    latex_delimiters=[
                        {"left": "$", "right": "$", "display": False},
                        {"left": "$$", "right": "$$", "display": True},
                    ],
                    elem_classes=["markdown-preview"],
                    sanitize_html=True,
                )

        # Bind the button
        btn.click(
            fn=process_image,
            inputs=[input_image],
            outputs=[result_md],
        )

        # Footer
        gr.HTML(
            '<div class="footer">'
            "Powered by PaddleOCR-VL-1.6 &nbsp;|&nbsp; Apple Silicon (CPU mode)"
            "</div>"
        )

    return demo


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    demo = build_ui()
    demo.launch(
        server_name="0.0.0.0",
        server_port=7860,
        share=False,
        show_error=True,
        theme=gr.themes.Soft(),
        css=CUSTOM_CSS,
    )
