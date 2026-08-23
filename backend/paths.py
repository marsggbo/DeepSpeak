"""路径解析：源码运行（dev）与打包运行（PyInstaller frozen）统一。

- dev：可写数据（data/、materials/）与资源（models/、frontend/、backend/data/）
  都在项目目录下，行为与改造前完全一致。
- 打包：可写数据迁到用户目录（mac ~/Library/Application Support/DeepSpeak，
  win %APPDATA%/DeepSpeak，linux ~/.deepspeak），首次启动把内置模型
  （models/、frontend/、backend/data/ 词库）从应用包复制/指向过去。
- 环境变量 DEEPSPEAK_DATA_DIR 可覆盖用户数据目录（调试/迁移用）。

backend 各模块只应通过本模块拿目录，不要自己拼 __file__ 路径。
"""
import os
import shutil
import sys


def is_frozen():
    return hasattr(sys, "frozen")


def project_root():
    """源码项目根（backend/ 的上一级）。打包模式下仅用于定位旧数据迁移源。"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def data_root():
    """可写数据根目录。dev = 项目根；frozen = 用户目录（可被环境变量覆盖）。"""
    if not is_frozen():
        return project_root()
    override = os.environ.get("DEEPSPEAK_DATA_DIR")
    if override:
        return override
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "DeepSpeak")
    if sys.platform.startswith("win"):
        return os.path.join(os.environ.get("APPDATA", home), "DeepSpeak")
    return os.path.join(home, ".deepspeak")


def data_dir():
    """SQLite 数据库与密钥目录（可写）。"""
    return os.path.join(data_root(), "data")


def materials_dir():
    """用户素材、导入音频与 TTS 缓存目录（可写）。"""
    return os.path.join(data_root(), "materials")


def models_dir():
    """模型目录（可写；frozen 首启时由 seed_models 从应用包复制进来）。"""
    return os.path.join(data_root(), "models")


def frontend_dir():
    """前端静态资源目录（frozen 时在应用包内，只读）。"""
    if is_frozen():
        return os.path.join(sys._MEIPASS, "frontend")
    return os.path.join(project_root(), "frontend")


def backend_data_dir():
    """只读词库目录（wordbank.json / expressions.json 等）。"""
    if is_frozen():
        return os.path.join(sys._MEIPASS, "backend_data")
    return os.path.join(project_root(), "backend", "data")


def ensure_dirs():
    """创建可写目录（data/、materials/ 及常用子目录）。"""
    for d in (data_dir(), materials_dir()):
        os.makedirs(d, exist_ok=True)


def seed_models():
    """打包首启：把应用包内内置模型复制到可写数据目录（只做一次）。

    models/ 在应用包里是只读的，而 whisper 需要在可写目录里
    增补下载其他模型（small.en 等），故统一放到数据目录。
    """
    if not is_frozen():
        return
    src = os.path.join(sys._MEIPASS, "models")
    if not os.path.isdir(src):
        return
    dst = models_dir()
    os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        s = os.path.join(src, name)
        d = os.path.join(dst, name)
        if os.path.exists(d):
            continue
        try:
            if os.path.isdir(s):
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)
        except OSError:
            pass  # 复制失败不阻塞启动，缺的模型会按需重新下载


def migrate_legacy_data():
    """打包首启：若用户目录还没有数据，尝试从源码项目迁移（仅 mac 桌面惯例位置）。"""
    if not is_frozen():
        return
    if os.path.exists(data_dir()) and os.listdir(data_dir()):
        return
    for src_root in (project_root(), os.path.expanduser("~/Desktop/DeepSpeak")):
        src_data = os.path.join(src_root, "data")
        src_materials = os.path.join(src_root, "materials")
        if not os.path.isdir(src_data):
            continue
        try:
            shutil.copytree(src_data, data_dir(), dirs_exist_ok=True)
            if os.path.isdir(src_materials):
                shutil.copytree(src_materials, materials_dir(), dirs_exist_ok=True)
        except OSError:
            continue
        break
