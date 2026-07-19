"""
PDF page rendering and image file handling.

Uses PyMuPDF (fitz) for high-performance PDF rendering.
For image files, copies them directly as page originals.
"""

import logging
import shutil
from pathlib import Path

from PIL import Image

logger = logging.getLogger(__name__)

# Render DPI — balances clarity and file size
RENDER_DPI = 200

# Supported image extensions (lowercase, with dot)
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tiff", ".tif", ".webp"}


def is_pdf(file_path: str | Path) -> bool:
    """Check if a file is a PDF."""
    return Path(file_path).suffix.lower() == ".pdf"


def is_image(file_path: str | Path) -> bool:
    """Check if a file is a supported image format."""
    return Path(file_path).suffix.lower() in IMAGE_EXTENSIONS


def render_pdf_pages(pdf_path: str | Path, output_dir: str | Path) -> list[str]:
    """
    Render each page of a PDF as a PNG image.

    Parameters
    ----------
    pdf_path : str | Path
        Path to the PDF file.
    output_dir : str | Path
        Directory to save the rendered page images.

    Returns
    -------
    list[str]
        List of paths to the rendered page images, one per page.
    """
    import fitz  # PyMuPDF

    pdf_path = Path(pdf_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    page_images: list[str] = []
    doc = fitz.open(str(pdf_path))

    try:
        zoom = RENDER_DPI / 72.0  # 72 DPI is PDF default
        mat = fitz.Matrix(zoom, zoom)

        for i in range(len(doc)):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img_path = str(output_dir / f"page_{i}_original.png")
            pix.save(img_path)
            page_images.append(img_path)
            logger.debug("Rendered page %d -> %s", i, img_path)
    finally:
        doc.close()

    logger.info("Rendered %d pages from %s", len(page_images), pdf_path.name)
    return page_images


def copy_image_as_page(
    image_path: str | Path, output_path: str | Path
) -> str:
    """
    Copy an image file as a page original.

    Converts to PNG for consistency if needed.

    Returns the path to the saved image.
    """
    image_path = Path(image_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # If already PNG, just copy
    if image_path.suffix.lower() == ".png":
        shutil.copy2(str(image_path), str(output_path))
    else:
        # Convert to PNG via PIL
        img = Image.open(str(image_path))
        if img.mode == "RGBA":
            # Flatten to RGB for consistency
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3] if img.mode == "RGBA" else None)
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")
        img.save(str(output_path), format="PNG")

    return str(output_path)


def get_page_count(file_path: str | Path) -> int:
    """Return the number of pages in a PDF, or 1 for images."""
    if is_pdf(file_path):
        import fitz

        doc = fitz.open(str(file_path))
        try:
            return len(doc)
        finally:
            doc.close()
    return 1


def prepare_original_images(
    file_path: str | Path, output_dir: str | Path
) -> list[str]:
    """
    Prepare original page images for a document.

    For PDFs: renders each page as PNG.
    For images: copies/converts to PNG as page_0_original.png.

    Returns list of original image paths.
    """
    file_path = Path(file_path)
    output_dir = Path(output_dir)

    if is_pdf(file_path):
        return render_pdf_pages(file_path, output_dir)
    else:
        out_path = output_dir / "page_0_original.png"
        return [copy_image_as_page(file_path, out_path)]
