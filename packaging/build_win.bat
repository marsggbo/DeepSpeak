@echo off
REM ============================================================
REM DeepSpeak 后端侧车构建脚本（Windows）
REM 用法：在 Windows 机器上运行  packaging\build_win.bat
REM 前置条件：
REM   1. 已安装 Python 3.13（含 pip，勾选 Add to PATH）
REM   2. 源码目录完整（frontend\ models\ backend\ 都在）
REM 输出：packaging\dist\deepspeak-server\
REM 注意：PyInstaller 不能交叉编译，必须在 Windows 上构建 Windows 包
REM ============================================================
cd /d "%~dp0.."
setlocal

echo [1/3] 创建虚拟环境...
if not exist .venv (
  py -3 -m venv .venv
)
call .venv\Scripts\activate.bat

echo [2/3] 安装固定版本依赖...
pip install -q ^
  "faster-whisper==1.2.1" ^
  "kokoro-onnx==0.6.1" ^
  "imageio-ffmpeg==0.6.0" ^
  "pyinstaller==6.22.2"

echo [3/3] PyInstaller 构建（onedir）...
pyinstaller --noconfirm --clean packaging\backend.spec
if errorlevel 1 (
  echo [FAIL] 构建失败，见上方错误信息
  exit /b 1
)

echo [OK] 侧车输出：packaging\dist\deepspeak-server\
endlocal
