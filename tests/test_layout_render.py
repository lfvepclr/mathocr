"""Unit tests for the Baidu 27-type label mapping and layout rendering.

Run with the project venv (no pytest needed):

    .venv/bin/python tests/test_layout_render.py

- engine_baidu._adapt_page: synthetic page dicts — semantic labels pass
  through LABEL_MAP, image branches behave, an empty seal does not explode.
- exporter.export_layout_html on the real persisted batch 20260801_223030
  (the rendering-regression baseline): table renders as <table> with 4
  rows, table images are data URIs, the numbered title keeps its literal
  "3.", and the header block carries data-label="header".
"""

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.engines import baidu as engine_baidu
from app.services import exporter

BAIDU_BATCH = "20260801_223030"
BAIDU_FILE = "Weixin_Image_20260718224411_18_1_e41e"


def _layout(type_, text="", layout_id=None, position=(10, 10, 200, 40)):
    return {
        "type": type_,
        "text": text,
        "layout_id": layout_id,
        "position": list(position),  # [x, y, w, h]
        "polygon": [],
    }


def _page(layouts, images=None):
    return {
        "meta": {"page_width": 1000, "page_height": 2000},
        "layouts": layouts,
        "tables": [],
        "images": images or [],
    }


def _blocks(result):
    return result["json_data"]["res"]["parsing_res_list"]


def _labels(result):
    return [b["block_label"] for b in _blocks(result)]


class AdaptPageLabelTest(unittest.TestCase):
    """Semantic layout types pass through LABEL_MAP untouched."""

    def test_semantic_types_pass_through(self):
        result = engine_baidu._adapt_page(
            _page(
                [
                    _layout("vertical_text", "竖排文本"),
                    _layout("aside_text", "旁注"),
                    _layout("formula_number", "(3)"),
                    _layout("figure_title", "图 1"),
                    _layout("header", "页眉"),
                    _layout("abstract", "摘要"),
                    _layout("reference_content", "文献内容"),
                ]
            ),
            0,
        )
        self.assertEqual(
            _labels(result),
            [
                "vertical_text",
                "aside_text",
                "formula_number",
                "figure_title",
                "header",
                "abstract",
                "reference_content",
            ],
        )

    def test_true_equivalents_mapped(self):
        """Only genuinely equivalent names are translated."""
        result = engine_baidu._adapt_page(
            _page(
                [
                    _layout("title", "节标题"),
                    _layout("display_formula", "E=mc^2"),
                    _layout("content", "目录项"),
                ]
            ),
            0,
        )
        self.assertEqual(_labels(result), ["paragraph_title", "formula", "contents"])

    def test_inline_formula_wrapped_once(self):
        result = engine_baidu._adapt_page(
            _page(
                [
                    _layout("inline_formula", "x^2+y^2"),
                    _layout("inline_formula", "$a+b$"),
                ]
            ),
            0,
        )
        md = result["markdown_text"]
        self.assertIn("$x^2+y^2$", md)  # bare content gets delimiters
        self.assertIn("$a+b$", md)  # already delimited — untouched
        self.assertNotIn("$$a+b$$", md)

    def test_display_formula_display_math(self):
        result = engine_baidu._adapt_page(
            _page(
                [
                    _layout("display_formula", "E=mc^2"),
                ]
            ),
            0,
        )
        self.assertIn("$$E=mc^2$$", result["markdown_text"])

    def test_image_types_without_data_url(self):
        """seal/header_image/footer_image with no data_url keep their
        labels and stay empty instead of exploding or merging into text."""
        result = engine_baidu._adapt_page(
            _page(
                [
                    _layout("seal", layout_id=1),
                    _layout("header_image", layout_id=2),
                    _layout("footer_image", layout_id=3),
                ]
            ),
            0,
        )
        self.assertEqual(_labels(result), ["seal", "header_image", "footer_image"])
        self.assertEqual(result["images"], {})
        for block in _blocks(result):
            self.assertEqual(block["block_content"], "")

    def test_header_image_with_data_url(self):
        """A data_url downloads into the images dict and an <img> block."""
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (2, 2), (255, 0, 0)).save(buf, format="PNG")
        png = buf.getvalue()
        orig = engine_baidu._download
        engine_baidu._download = lambda url: png  # ty: ignore[invalid-assignment] — test stub
        try:
            result = engine_baidu._adapt_page(
                _page(
                    [_layout("header_image", layout_id=7)],
                    images=[{"layout_id": 7, "data_url": "https://x/y.png"}],
                ),
                0,
            )
        finally:
            engine_baidu._download = orig
        block = _blocks(result)[0]
        self.assertEqual(block["block_label"], "header_image")
        self.assertEqual(block["block_content"], '<img src="page_0_img_0.png">')
        self.assertIn("page_0_img_0.png", result["images"])

    def test_figure_title_centred(self):
        result = engine_baidu._adapt_page(
            _page(
                [
                    _layout("figure_title", "图 1 示意"),
                ]
            ),
            0,
        )
        self.assertIn("text-align: center", result["markdown_text"])
        self.assertIn("图 1 示意", result["markdown_text"])


class LayoutHtmlExportTest(unittest.TestCase):
    """Real batch 20260801_223030 — the rendering-regression baseline."""

    @classmethod
    def setUpClass(cls):
        if not (Path(exporter.BATCHES_DIR) / BAIDU_BATCH).exists():
            raise unittest.SkipTest(f"批次不存在: {BAIDU_BATCH}")
        out = exporter.export_layout_html(BAIDU_BATCH, BAIDU_FILE)
        cls.html = Path(out).read_text(encoding="utf-8")

    def test_table_renders_as_table(self):
        self.assertIn("<table", self.html)
        self.assertEqual(self.html.count("<tr"), 4)

    def test_table_images_are_data_uris(self):
        """Layout HTML is self-contained: no relative page_N_*.png src
        may leak through; every image is a data URI."""
        self.assertNotIn('src="page_', self.html)
        self.assertIn("data:image/", self.html)

    def test_numbered_title_keeps_literal_number(self):
        self.assertIn("3. 三角形三条高线的位置", self.html)

    def test_header_label_present(self):
        self.assertIn('data-label="header"', self.html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
