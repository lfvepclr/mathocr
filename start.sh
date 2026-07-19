#!/bin/bash
# ============================================================
# PaddleOCR-VL 一键启动脚本
# 功能: 检查/安装环境 → 安装依赖 → 构建前端 → 下载模型 → 启动服务 → 打开页面
# ============================================================
set -e

# ---- 颜色输出 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════╗"
echo "║     PaddleOCR-VL 文档解析平台 一键启动       ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ============================================================
# Step 1: 检查并安装 UV
# ============================================================
echo -e "${BLUE}[1/7] 检查 UV 包管理器...${NC}"
if ! command -v uv &> /dev/null; then
    echo -e "${YELLOW}  UV 未安装,正在安装...${NC}"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source "$HOME/.local/bin/env" 2>/dev/null || true
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
echo -e "${GREEN}  ✓ UV $(uv --version 2>/dev/null || echo 'installed')${NC}"

# ============================================================
# Step 2: 检查并安装 Bun
# ============================================================
echo -e "${BLUE}[2/7] 检查 Bun 包管理器...${NC}"
if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}  Bun 未安装,正在安装...${NC}"
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
fi
echo -e "${GREEN}  ✓ Bun $(bun --version 2>/dev/null || echo 'installed')${NC}"

# ============================================================
# Step 3: 创建虚拟环境
# ============================================================
echo -e "${BLUE}[3/7] 创建 Python 虚拟环境...${NC}"
if [ ! -d ".venv" ]; then
    uv venv --python python3.13
    echo -e "${GREEN}  ✓ 虚拟环境已创建${NC}"
else
    echo -e "${GREEN}  ✓ 虚拟环境已存在${NC}"
fi

# ============================================================
# Step 4: 安装 Python 依赖
# ============================================================
echo -e "${BLUE}[4/7] 安装 Python 依赖...${NC}"

# PaddlePaddle (CPU, Apple Silicon)
if ! uv pip list 2>/dev/null | grep -qi "paddlepaddle"; then
    echo -e "${YELLOW}  安装 PaddlePaddle (CPU)...${NC}"
    uv pip install paddlepaddle==3.2.1 \
        --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
        --index-strategy unsafe-best-match
fi

# PaddleOCR
if ! uv pip list 2>/dev/null | grep -qi "paddleocr"; then
    echo -e "${YELLOW}  安装 PaddleOCR...${NC}"
    uv pip install -U "paddleocr[doc-parser]"
fi

# 其他依赖
echo -e "${YELLOW}  安装 Web/导出/数据库依赖...${NC}"
uv pip install "robyn>=0.63" "pillow>=10.0" "python-docx>=1.1" "PyMuPDF>=1.24"

echo -e "${GREEN}  ✓ Python 依赖安装完成${NC}"

# ============================================================
# Step 5: 安装并构建前端
# ============================================================
echo -e "${BLUE}[5/7] 构建前端资源...${NC}"
cd static
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}  安装前端依赖...${NC}"
    bun install
fi
echo -e "${YELLOW}  构建前端 bundle...${NC}"
bun run build
cd "$SCRIPT_DIR"
echo -e "${GREEN}  ✓ 前端构建完成${NC}"

# ============================================================
# Step 6: 设置模型源 (魔搭 ModelScope)
# ============================================================
echo -e "${BLUE}[6/7] 配置模型源 (魔搭 ModelScope)...${NC}"
export PADDLE_PDX_LOCAL_MODEL_SOURCE="ModelScope"
echo -e "${GREEN}  ✓ 模型源: ModelScope${NC}"
echo -e "${YELLOW}  注意: 首次 OCR 识别时会自动下载模型 (~2GB),请耐心等待${NC}"

# ============================================================
# Step 7: 启动服务器
# ============================================================
echo -e "${BLUE}[7/7] 启动服务器...${NC}"
echo ""
echo -e "${CYAN}════════════════════════════════════════════════"
echo "  服务地址: http://localhost:7860"
echo "  按 Ctrl+C 停止服务"
echo -e "════════════════════════════════════════════════${NC}"
echo ""

# 启动服务器,自动打开浏览器
exec .venv/bin/python server.py --open-browser
