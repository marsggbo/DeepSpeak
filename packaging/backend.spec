# -*- mode: python ; coding: utf-8 -*-
"""DeepSpeak 后端侧车 PyInstaller 打包配置（onedir）。

输出：packaging/dist/deepspeak-server/（内含可执行文件 deepspeak-server）。
资源布局（与 backend/paths.py 的 frozen 约定一致）：
  _MEIPASS/frontend      前端静态资源（只读）
  _MEIPASS/models        内置模型（whisper base.en + kokoro），首启复制到用户数据目录
  _MEIPASS/backend_data  内置词库（wordbank.json 等）
"""
import os

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

datas = [
    (os.path.join(ROOT, "frontend"), "frontend"),
    (os.path.join(ROOT, "models"), "models"),
    (os.path.join(ROOT, "backend", "data"), "backend_data"),
]
binaries = []
hiddenimports = []

# 大型二进制/数据包：ctranslate2 / PyAV / onnxruntime 需要完整收集 .so 与数据
for pkg in (
    "ctranslate2",
    "av",
    "onnxruntime",
    "faster_whisper",
    "tokenizers",
    "huggingface_hub",
    "kokoro_onnx",
    "espeakng_loader",
    "phonemizer",
    "imageio_ffmpeg",
):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

hiddenimports += [
    "backend.ai",
    "backend.asr",
    "backend.builtin",
    "backend.db",
    "backend.diffing",
    "backend.extract",
    "backend.focus",
    "backend.importers",
    "backend.paths",
    "backend.pipeline",
    "backend.review",
    "backend.server",
    "backend.textproc",
    "backend.tts",
    "backend.tts_engine_kokoro",
    "backend.wordbank",
]

a = Analysis(
    [os.path.join(ROOT, "packaging", "entry_server.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "pydoc_data"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="deepspeak-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="deepspeak-server",
)
