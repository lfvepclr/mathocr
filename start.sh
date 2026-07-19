#!/bin/bash
# ============================================================
# PaddleOCR-VL 一键启动脚本
# 功能: 检查/安装环境 → 安装依赖 → 构建前端 → 下载模型 → 启动服务 → 打开页面
# 加速: 自动启动 MLX-VLM 推理服务 (Apple Silicon GPU), 未安装则回退 CPU 推理
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

MLX_PORT=${MLX_PORT:-8111}
MLX_STARTED_BY_US=0

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════╗"
echo "║     PaddleOCR-VL 文档解析平台 一键启动       ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ============================================================
# Step 1: 检查并安装 UV
# ============================================================
echo -e "${BLUE}[1/8] 检查 UV 包管理器...${NC}"
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
echo -e "${BLUE}[2/8] 检查 Bun 包管理器...${NC}"
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
echo -e "${BLUE}[3/8] 创建 Python 虚拟环境...${NC}"
if [ ! -d ".venv" ]; then
    uv venv --python python3.13
    echo -e "${GREEN}  ✓ 虚拟环境已创建${NC}"
else
    echo -e "${GREEN}  ✓ 虚拟环境已存在${NC}"
fi

# ============================================================
# Step 4: 安装 Python 依赖
# ============================================================
echo -e "${BLUE}[4/8] 安装 Python 依赖...${NC}"

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
# Step 5: MLX-VLM 推理后端 (Apple Silicon GPU 加速, 可选)
# ============================================================
echo -e "${BLUE}[5/8] 检查 MLX-VLM 推理后端 (Apple Silicon 加速)...${NC}"
if .venv/bin/python -c "import mlx_vlm" 2>/dev/null; then
    echo -e "${GREEN}  ✓ mlx-vlm 已安装${NC}"
else
    echo -e "${YELLOW}  安装 mlx-vlm (用于 Apple GPU 推理加速)...${NC}"
    if uv pip install "mlx-vlm>=0.3.11"; then
        echo -e "${GREEN}  ✓ mlx-vlm 安装完成${NC}"
    else
        echo -e "${YELLOW}  ⚠ mlx-vlm 安装失败, 将使用本地 CPU 推理 (速度较慢)${NC}"
    fi
fi

# ============================================================
# Step 6: 安装并构建前端
# ============================================================
echo -e "${BLUE}[6/8] 构建前端资源...${NC}"
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
# Step 7: 设置模型源 (魔搭 ModelScope) + 启动 MLX-VLM 服务
# ============================================================
echo -e "${BLUE}[7/8] 配置模型源并启动 MLX-VLM 推理服务...${NC}"
export PADDLE_PDX_LOCAL_MODEL_SOURCE="ModelScope"
echo -e "${GREEN}  ✓ 模型源: ModelScope${NC}"

# Web 服务会自动探测 http://localhost:8111/ 的 MLX-VLM 服务
# (见 ocr_engine.py), 探测到则用 Apple GPU 做 VLM 识别, 否则回退 CPU
# MLX 模型本地目录 (从 ModelScope 下载, 国内 CDN 速度快; HF 直连易卡死)
MLX_MODEL_DIR="${HOME}/.cache/mlx_models/PaddlePaddle/PaddleOCR-VL-1.6"
MLX_MODEL=${OCR_VL_REC_API_MODEL_NAME:-$MLX_MODEL_DIR}
# 客户端与服务端必须使用同一个模型 ID（本地路径），否则服务端会尝试从 HF 重新下载
export OCR_VL_REC_API_MODEL_NAME="$MLX_MODEL"
if .venv/bin/python -c "import mlx_vlm" 2>/dev/null; then
    if curl -s -m 2 "http://localhost:${MLX_PORT}/v1/models" | grep -q '"id"'; then
        echo -e "${GREEN}  ✓ MLX-VLM 服务已在 :${MLX_PORT} 运行 (模型已加载)${NC}"
    else
        # 已运行但模型未加载(旧实例), 先停掉再以 --model 预加载方式重启
        if lsof -ti :"${MLX_PORT}" > /dev/null 2>&1; then
            echo -e "${YELLOW}  检测到无模型的旧 MLX 服务实例, 正在重启...${NC}"
            lsof -ti :"${MLX_PORT}" | xargs kill 2>/dev/null || true
            sleep 1
        fi
        # 模型未下载时, 先从 ModelScope 下载 (~2GB, 国内 CDN)
        if [ ! -f "${MLX_MODEL_DIR}/model.safetensors" ]; then
            echo -e "${YELLOW}  首次运行, 从 ModelScope 下载 MLX 模型 (~2GB)...${NC}"
            .venv/bin/python -c "
from modelscope import snapshot_download
p = snapshot_download('PaddlePaddle/PaddleOCR-VL-1.6',
                      local_dir='${MLX_MODEL_DIR}')
print('模型目录:', p)
"
        fi
        echo -e "${YELLOW}  后台启动 MLX-VLM 服务 (端口 ${MLX_PORT}, 预加载模型)...${NC}"
        echo -e "${YELLOW}  日志: /tmp/mlx_vlm_server.log${NC}"
        nohup .venv/bin/python -m mlx_vlm.server --port "${MLX_PORT}" \
            --model "${MLX_MODEL}" \
            > /tmp/mlx_vlm_server.log 2>&1 &
        MLX_PID=$!
        MLX_STARTED_BY_US=1
        echo -e "${GREEN}  ✓ MLX-VLM 服务启动中 (pid $!)${NC}"
    fi
else
    echo -e "${YELLOW}  跳过 MLX-VLM 服务 (未安装), OCR 使用本地 CPU 推理${NC}"
fi

# ============================================================
# 清理函数: 脚本退出时关闭由本脚本启动的后台服务
# ============================================================
cleanup() {
    if [ "$MLX_STARTED_BY_US" -eq 1 ]; then
        echo -e "\n${YELLOW}正在关闭 MLX-VLM 推理服务 (pid ${MLX_PID})...${NC}"
        kill "$MLX_PID" 2>/dev/null || true
        wait "$MLX_PID" 2>/dev/null || true
        echo -e "${GREEN}  ✓ MLX-VLM 服务已关闭${NC}"
    fi
}
trap cleanup EXIT

# ============================================================
# Step 8: 启动服务器
# ============================================================
echo -e "${BLUE}[8/8] 启动服务器...${NC}"
echo ""
echo -e "${CYAN}════════════════════════════════════════════════"
echo "  服务地址: http://localhost:7860"
echo "  按 Ctrl+C 停止服务"
echo -e "════════════════════════════════════════════════${NC}"
echo ""

# 启动服务器: 首次自动打开浏览器; 异常退出(如段错误)自动重启, Ctrl+C/正常退出则停止
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
