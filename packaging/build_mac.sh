#!/usr/bin/env bash
# DeepSpeak 后端侧车构建脚本（macOS / Linux）
# 用法：./packaging/build_mac.sh
# 输出：packaging/dist/deepspeak-server/
set -e
cd "$(dirname "$0")/.."

# 1. 环境：复用 .venv（缺失则创建）
if [ ! -d .venv ]; then
  echo "▶ 创建虚拟环境…"
  python3 -m venv .venv
fi
source .venv/bin/activate

# 2. 依赖（固定版本；已装则跳过）
pip install -q \
  "faster-whisper==1.2.1" \
  "kokoro-onnx==0.6.1" \
  "imageio-ffmpeg==0.6.0" \
  "pyinstaller==6.22.2"

# 3. 构建（onedir；spec 位于 packaging/，输出也在 packaging/ 下）
pyinstaller --noconfirm --clean packaging/backend.spec

echo "✅ 侧车输出：packaging/dist/deepspeak-server/"
du -sh packaging/dist/deepspeak-server/
