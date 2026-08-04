"""Unit tests for exporter.page_to_richtext multi-block (lasso copy) mode.

Run with the project venv (no pytest needed):

    .venv/bin/python tests/test_richtext_multi.py

Fixtures are real persisted batches:
- 20260801_191209  baidu engine (titles / table / image blocks)
- 20260801_204109  siliconflow engine (83 line blocks, \\(...\\) formulas)
"""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import exporter

BAIDU_BATCH = "20260801_191209"
BAIDU_FILE = "Weixin_Image_20260718224411_18_1_5118"
SF_BATCH = "20260801_204109"
SF_FILE = "Weixin_Image_20260718224411_18_1_a6da"


def _skip_if_missing(batch_id):
    if not (Path(exporter.BATCHES_DIR) / batch_id).exists():
        raise unittest.SkipTest(f"批次不存在: {batch_id}")


class MultiBlockBaiduTest(unittest.TestCase):
    """Baidu batch: title + image + table blocks, passed out of order."""

    def setUp(self):
        _skip_if_missing(BAIDU_BATCH)
        # 9 = paragraph_title, 14 = image, 17 = table — reversed on purpose
        self.rt = exporter.page_to_richtext(BAIDU_BATCH, BAIDU_FILE, 0, block_idxs=[17, 14, 9])

    def test_title_becomes_h2(self):
        self.assertIn("<h2>", self.rt["html"])
        self.assertIn("知识点六", self.rt["html"])

    def test_table_html(self):
        self.assertIn("<table", self.rt["html"])
        self.assertIn("高线的位置", self.rt["html"])

    def test_image_embedded_base64(self):
        self.assertIn("data:image/", self.rt["html"])
        self.assertIn("base64", self.rt["html"])

    def test_reading_order_restored(self):
        """Output order must follow block_order (9 < 14 < 17), not the
        order the indices were passed in."""
        html = self.rt["html"]
        pos_title = html.find("知识点六")
        pos_img = html.find("data:image/")
        pos_table = html.find("<table")
        self.assertTrue(-1 < pos_title < pos_img < pos_table)

    def test_text_paragraphs_joined(self):
        # Plain-text channel joins blocks with a blank line (Word paragraphs)
        self.assertIn("\n\n", self.rt["text"])

    def test_dedupe(self):
        rt = exporter.page_to_richtext(BAIDU_BATCH, BAIDU_FILE, 0, block_idxs=[9, 9, 10])
        self.assertEqual(rt["html"].count("<h2>"), 2)


class MultiBlockSiliconflowTest(unittest.TestCase):
    """SiliconFlow batch: line blocks with \\(...\\) inline formulas."""

    def setUp(self):
        _skip_if_missing(SF_BATCH)
        # Blocks 15/16 carry \triangle / \perp / \angle / ^\circ formulas
        self.rt = exporter.page_to_richtext(SF_BATCH, SF_FILE, 0, block_idxs=[15, 16, 1])

    def test_paren_latex_converted(self):
        self.assertNotIn("\\(", self.rt["html"])
        self.assertNotIn("\\(", self.rt["text"])
        self.assertNotIn("triangle", self.rt["text"])
        self.assertNotIn("perp", self.rt["text"])

    def test_unicode_symbols(self):
        self.assertIn("△", self.rt["text"])
        self.assertIn("⊥", self.rt["text"])
        self.assertIn("∠", self.rt["text"])
        self.assertIn("°", self.rt["text"])

    def test_order_restored(self):
        # Passed [15, 16, 1] — output must start with block 1's content
        self.assertTrue(self.rt["text"].startswith("因为 BC + AB > AC"))


class ErrorCasesTest(unittest.TestCase):
    def test_out_of_bounds(self):
        _skip_if_missing(BAIDU_BATCH)
        with self.assertRaises(ValueError):
            exporter.page_to_richtext(BAIDU_BATCH, BAIDU_FILE, 0, block_idxs=[999])

    def test_empty_set(self):
        _skip_if_missing(BAIDU_BATCH)
        with self.assertRaises(ValueError):
            exporter.page_to_richtext(BAIDU_BATCH, BAIDU_FILE, 0, block_idxs=[])

    def test_bad_page(self):
        with self.assertRaises(ValueError):
            exporter.page_to_richtext(BAIDU_BATCH, BAIDU_FILE, 999)


class RegressionTest(unittest.TestCase):
    """Single-block and full-page modes must be unaffected."""

    def test_single_block(self):
        _skip_if_missing(BAIDU_BATCH)
        rt = exporter.page_to_richtext(BAIDU_BATCH, BAIDU_FILE, 0, block_idx=9)
        self.assertIn("<h2>", rt["html"])
        self.assertNotIn("<table", rt["html"])

    def test_full_page(self):
        _skip_if_missing(BAIDU_BATCH)
        rt = exporter.page_to_richtext(BAIDU_BATCH, BAIDU_FILE, 0)
        self.assertIn("<table", rt["html"])
        self.assertNotIn("\\(", rt["html"])
        self.assertNotIn("$", rt["text"])

    def test_full_page_siliconflow_clean(self):
        _skip_if_missing(SF_BATCH)
        rt = exporter.page_to_richtext(SF_BATCH, SF_FILE, 0)
        self.assertNotIn("\\(", rt["html"])
        self.assertNotIn("\\(", rt["text"])
        self.assertIsNone(re.search(r"\\[A-Za-z]", rt["text"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
