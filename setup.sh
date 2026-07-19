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

echo "=== Installing Robyn (Rust-based Python web framework) ==="
uv pip install "robyn>=0.63"

echo "=== Installing Gradio and other dependencies ==="
uv pip install "gradio>=4.0" "pillow>=10.0"

echo "=== Installing document export dependencies ==="
uv pip install "python-docx>=1.1" "PyMuPDF>=1.24"

# Apple Silicon acceleration: MLX-VLM serves the VLM recognition model on the
# Apple GPU (much faster than local CPU inference). The web server auto-detects
# a running MLX-VLM server at http://localhost:8111/ and uses it automatically.
echo "=== Installing MLX-VLM (Apple Silicon GPU inference backend) ==="
uv pip install "mlx-vlm>=0.3.11" || \
    echo "WARNING: mlx-vlm install failed; OCR will use local CPU inference"

# ModelScope SDK: downloads the MLX model from the China CDN (much faster
# and more reliable than a direct HuggingFace connection in CN networks)
echo "=== Installing ModelScope SDK (fast MLX model download) ==="
uv pip install "modelscope>=1.25" || \
    echo "WARNING: modelscope install failed; start.sh will fall back to HF"

echo "=== Installing frontend dependencies with Bun ==="
cd static && bun install && cd ..

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To activate the environment:"
echo "  source .venv/bin/activate"
echo ""
echo "To run the web server (auto-starts MLX-VLM if installed):"
echo "  ./start.sh"
echo ""
echo "Or start components manually:"
echo "  .venv/bin/python -m mlx_vlm.server --port 8111 --model ~/.cache/mlx_models/PaddlePaddle/PaddleOCR-VL-1.6 &   # optional, GPU acceleration"
echo "  uv run python server.py"
echo ""
echo "To run the old Gradio app:"
echo "  uv run python app.py"
echo ""
echo "To build frontend assets:"
echo "  cd static && bun run build"
