#!/bin/bash
# ============================================================
# MathOCR 轻量启动脚本 (无本地模型 / 仅在线引擎)
# 适用: 无法运行本地推理(无 PaddlePaddle / 非 Apple Silicon / 低配机)
#       或只想用 硅基流动 / 百度文档解析 等在线引擎的电脑
# 与 start.sh 的差异:
#   - 不安装 paddlepaddle / paddleocr / mlx-vlm
#   - 不下载 ~2GB 模型, 不启动 MLX-VLM 服务
#   - 本地引擎在界面上自动显示为"未安装本地推理环境"并禁用
# 使用: ./start_remote.sh
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
echo "║   MathOCR 文档解析平台 轻量启动 (在线引擎)   ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ============================================================
# Step 1: 检查并安装 UV
# ============================================================
echo -e "${BLUE}[1/5] 检查 UV 包管理器...${NC}"
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
echo -e "${BLUE}[2/5] 检查 Bun 包管理器...${NC}"
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
echo -e "${BLUE}[3/5] 创建 Python 虚拟环境...${NC}"
if [ ! -d ".venv" ]; then
    uv venv --python python3.13
    echo -e "${GREEN}  ✓ 虚拟环境已创建${NC}"
else
    echo -e "${GREEN}  ✓ 虚拟环境已存在${NC}"
fi

# ============================================================
# Step 4: 安装 Python 依赖 (仅轻量依赖, 不含本地推理栈)
# ============================================================
echo -e "${BLUE}[4/5] 安装轻量 Python 依赖 (不含 paddle/mlx)...${NC}"
uv pip install "robyn>=0.63" "pillow>=10.0" "python-docx>=1.1" "PyMuPDF>=1.24"
echo -e "${GREEN}  ✓ Python 依赖安装完成${NC}"
echo -e "${YELLOW}  提示: 跳过本地推理栈 (paddlepaddle/paddleocr/mlx-vlm), 本地引擎将不可用${NC}"

# ============================================================
# Step 5: 安装并构建前端
# ============================================================
echo -e "${BLUE}[5/5] 构建前端资源...${NC}"
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
# 启动服务器
# ============================================================
echo ""
echo -e "${CYAN}════════════════════════════════════════════════"
echo "  服务地址: http://localhost:7860"
echo "  可用引擎: 硅基流动 / 百度文档解析 (需在设置中配置 Key)"
echo "  按 Ctrl+C 停止服务"
echo -e "════════════════════════════════════════════════${NC}"
echo ""

# 启动服务器: 首次自动打开浏览器; 异常退出自动重启, Ctrl+C/正常退出则停止
first_run=1
while true; do
    if [ $first_run -eq 1 ]; then
        .venv/bin/python server.py --open-browser
        first_run=0
    else
        .venv/bin/python server.py
    fi
    exit_code=$?
    # 0=正常退出, 130=Ctrl+C(SIGINT): 不重启
    if [ $exit_code -eq 0 ] || [ $exit_code -eq 130 ]; then
        echo -e "${GREEN}服务已停止${NC}"
        break
    fi
    echo -e "${RED}服务异常退出 (code $exit_code), 3s 后自动重启... (按 Ctrl+C 终止)${NC}"
    sleep 3
done
