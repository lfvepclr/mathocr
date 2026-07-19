"""
Image annotation module — draws bounding boxes with confidence color coding
on original page images.

Color scheme:
    score >= 0.90  → green   #22c55e  (high confidence)
    0.75 – 0.90    → blue    #3b82f6  (medium-high)
    0.60 – 0.75    → yellow  #eab308  (medium-low)
    score < 0.60   → red     #ef4444  (low, needs review)
"""

import logging
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

# Confidence → (fill_rgb, border_rgb, label)
CONFIDENCE_LEVELS = [
    (0.90, (34, 197, 94), "High"),     # green
    (0.75, (59, 130, 246), "Medium"),   # blue
    (0.60, (234, 179, 8), "Low"),       # yellow
    (0.0, (239, 68, 68), "Review"),     # red
]

FILL_ALPHA = 60  # 0-255, semi-transparent fill
BORDER_WIDTH = 3
LABEL_FONT_SIZE = 13


def get_confidence_color(score: float) -> tuple[tuple[int, int, int], str]:
    """Return (rgb, level_label) for a given confidence score."""
    for threshold, color, label in CONFIDENCE_LEVELS:
        if score >= threshold:
            return color, label
    return CONFIDENCE_LEVELS[-1][0], CONFIDENCE_LEVELS[-1][2]


def _get_font(size: int = LABEL_FONT_SIZE) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Try to load a TrueType font, fall back to default."""
    font_candidates = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for fp in font_candidates:
        try:
            return ImageFont.truetype(fp, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def annotate_image(
    original_image_path: str | Path,
    page_data: dict[str, Any],
    output_path: str | Path,
) -> str:
    """
    Draw bounding boxes with confidence color coding on an original page image.

    Parameters
    ----------
    original_image_path : str | Path
        Path to the original page image (PNG).
    page_data : dict
        Extracted page data containing 'boxes', 'width', 'height'.
    output_path : str | Path
        Where to save the annotated image.

    Returns
    -------
    str
        Path to the saved annotated image.
    """
    original_image_path = Path(original_image_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Load original image
    img = Image.open(str(original_image_path)).convert("RGBA")
    img_w, img_h = img.size

    # Create overlay layer for semi-transparent fills
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Create a separate layer for borders and labels (fully opaque)
    label_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    label_draw = ImageDraw.Draw(label_layer)

    font = _get_font()

    # Get JSON coordinate dimensions for scaling
    json_w = page_data.get("width", 0)
    json_h = page_data.get("height", 0)

    # Scale factor: JSON coords → rendered image coords
    if json_w > 0 and json_h > 0:
        scale_x = img_w / json_w
        scale_y = img_h / json_h
    else:
        scale_x = scale_y = 1.0

    boxes = page_data.get("boxes", [])
    for box in boxes:
        score = box.get("score", 0.0)
        label = box.get("label", "unknown")
        coord = box.get("coordinate", box.get("bbox", []))

        if len(coord) != 4:
            continue

        x1, y1, x2, y2 = coord
        # Scale to image dimensions
        x1 = int(x1 * scale_x)
        y1 = int(y1 * scale_y)
        x2 = int(x2 * scale_x)
        y2 = int(y2 * scale_y)

        # Clamp to image bounds
        x1 = max(0, min(x1, img_w - 1))
        y1 = max(0, min(y1, img_h - 1))
        x2 = max(0, min(x2, img_w - 1))
        y2 = max(0, min(y2, img_h - 1))

        if x2 <= x1 or y2 <= y1:
            continue

        color_rgb, level_label = get_confidence_color(score)

        # Semi-transparent fill
        fill_rgba = color_rgb + (FILL_ALPHA,)
        draw.rectangle([x1, y1, x2, y2], fill=fill_rgba)

        # Solid border
        label_draw.rectangle([x1, y1, x2, y2], outline=color_rgb + (255,), width=BORDER_WIDTH)

        # Label text: "type score"
        text = f"{label} {score:.2f}"
        try:
            bbox = label_draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        except AttributeError:
            tw, th = font.getsize(text)

        # Label background
        ly1 = max(0, y1 - th - 4)
        ly2 = ly1 + th + 4
        label_draw.rectangle([x1, ly1, x1 + tw + 8, ly2], fill=color_rgb + (255,))
        label_draw.text((x1 + 4, ly1 + 1), text, fill=(255, 255, 255, 255), font=font)

    # Composite: original + overlay (fills) + label_layer (borders + labels)
    result = Image.alpha_composite(img, overlay)
    result = Image.alpha_composite(result, label_layer)

    # Convert to RGB for saving as PNG (smaller, no alpha needed)
    result = result.convert("RGB")
    result.save(str(output_path), format="PNG")

    logger.debug("Annotated image saved: %s", output_path)
    return str(output_path)


def generate_legend() -> dict:
    """Return legend data for frontend display."""
    return {
        "levels": [
            {"threshold": 0.90, "color": "#22c55e", "label": "高置信度 (≥90%)"},
            {"threshold": 0.75, "color": "#3b82f6", "label": "中高 (75%-90%)"},
            {"threshold": 0.60, "color": "#eab308", "label": "中低 (60%-75%)"},
            {"threshold": 0.0, "color": "#ef4444", "label": "低置信度 (<60%, 需人工校对)"},
        ]
    }
