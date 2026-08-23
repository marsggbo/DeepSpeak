#!/usr/bin/env bash
# DeepSpeak 启动脚本（macOS）
set -e
cd "$(dirname "$0")"

echo "════════════════════════════════════════"
echo "  DeepSpeak — 英语深度学习（本地优先）"
echo "════════════════════════════════════════"

# 1. 虚拟环境（首次自动创建）
if [ ! -d .venv ]; then
  echo "▶ 首次运行：创建虚拟环境…"
  python3 -m venv .venv
fi
source .venv/bin/activate

# 2. 可选依赖：faster-whisper（本地语音识别，不开任何云服务）
if ! python -c "import faster_whisper" 2>/dev/null; then
  echo "▶ 安装 faster-whisper（本地语音识别，需要联网下载一次）…"
  if pip install -q faster-whisper 2>/dev/null; then
    echo "  ✅ 安装成功"
  else
    echo "  ⚠️  安装失败（网络问题？）。App 仍可完整使用："
    echo "     听写、跟读打字核验、复习都不受影响；"
    echo "     只有「录音自动转写」不可用。稍后可重跑 ./run.sh 补装。"
  fi
fi

# 3. 启动（首次会自动生成内置材料的音频 + 打开浏览器）
exec python -m backend.server "$@"
