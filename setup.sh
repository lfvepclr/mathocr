#!/bin/bash
# ============================================================
# Setup script for PaddleOCR-VL-1.6 on Apple Silicon with UV
# ============================================================
set -e

echo "=== Setting up PaddleOCR-VL-1.6 environment with UV ==="

# Ensure UV is installed
if ! command -v uv &> /dev/null; then
    echo "UV is not installed. Installing UV..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # Reload shell environment
    source "$HOME/.local/bin/env" 2>/dev/null || true
    export PATH="$HOME/.cargo/bin:$PATH"
fi

echo "UV version: $(uv --version)"

# Remove old venv if it exists
rm -rf .venv

# Create virtual environment (Python 3.10-3.13 required by paddlepaddle)
echo "=== Creating virtual environment (Python 3.13) ==="
uv venv --python python3.13

echo "=== Installing PaddlePaddle (CPU version for Apple Silicon) ==="
uv pip install paddlepaddle==3.2.1 \
    --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
    --index-strategy unsafe-best-match

echo "=== Installing PaddleOCR with doc-parser support ==="
uv pip install -U "paddleocr[doc-parser]"

echo "=== Installing Gradio and other dependencies ==="
uv pip install gradio>=4.0 pillow>=10.0

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To activate the environment:"
echo "  source .venv/bin/activate"
echo ""
echo "To run the Gradio app:"
echo "  uv run python app.py"
echo ""
echo "Optional: For faster inference with MLX-VLM backend:"
echo "  uv pip install 'mlx-vlm>=0.3.11'"
echo "  mlx_vlm.server --port 8111 &"
echo "  # Then update app.py to use vl_rec_backend='mlx-vlm-server'"
