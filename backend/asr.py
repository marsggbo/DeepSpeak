"""本地 ASR：faster-whisper（可选依赖）。

没有安装时，App 完全可用（听写可打字、口语可打字核验），
只有「录音→自动转写」这一项会被禁用并给出明确提示。

模型随应用打包（models/）：默认模型存在时本地离线加载，不联网；
设置里选了未打包的模型（如 small.en）才会首次联网下载一次。
"""
import os
import threading
import time

from . import paths

MODELS_DIR = paths.models_dir()

_model = None
_model_name = None
_model_lock = threading.Lock()
_last_error = None


def _repo_id(model_name):
    """faster-whisper 模型名 → HuggingFace repo id。"""
    return f"Systran/faster-whisper-{model_name}" if "/" not in model_name else model_name


def _cache_dir(repo_id):
    """huggingface_hub 标准缓存目录（models--org--repo）。"""
    return os.path.join(MODELS_DIR, "models--" + repo_id.replace("/", "--"))


def model_ready(model_name="base.en"):
    """模型文件是否已就绪（可完全离线加载）。"""
    snap = os.path.join(_cache_dir(_repo_id(model_name)), "snapshots")
    if not os.path.isdir(snap):
        return False
    return any(
        os.path.isfile(os.path.join(snap, name, "model.bin")) for name in os.listdir(snap)
    )


def available():
    """是否安装了 faster-whisper。"""
    try:
        import faster_whisper  # noqa
        return True
    except ImportError:
        return False


def error_message():
    return _last_error


def _load(model_name):
    global _model, _model_name, _last_error
    with _model_lock:
        if _model is not None and _model_name == model_name:
            return _model
        if not available():
            _last_error = "未安装 faster-whisper。运行 run.sh 会自动安装；或用 pip install faster-whisper。"
            return None
        local_only = model_ready(model_name)
        try:
            from faster_whisper import WhisperModel
            os.makedirs(MODELS_DIR, exist_ok=True)
            _model = WhisperModel(
                model_name, device="auto", compute_type="auto",
                download_root=MODELS_DIR, local_files_only=local_only,
            )
            _model_name = model_name
            _last_error = None
            return _model
        except Exception as e:
            _last_error = (
                f"ASR 模型加载失败: {e}"
                + ("" if local_only else "（该模型未打包，需联网下载一次）")
            )
            return None


def transcribe(audio_path, model_name="base.en", language="en", with_timestamps=True, task="transcribe"):
    """转写音频。返回 {"text", "language", "segments":[{"start","end","text"}], "duration", "model"}"""
    t0 = time.time()
    model = _load(model_name)
    if model is None:
        raise RuntimeError(_last_error or "ASR 不可用")
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        task=task,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
    )
    segs = []
    full = []
    for s in segments_iter:
        segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()})
        full.append(s.text.strip())
    return {
        "text": " ".join(full),
        "language": getattr(info, "language", language),
        "segments": segs,
        "duration": round(getattr(info, "duration", 0) or 0, 2),
        "model": model_name,
        "seconds": round(time.time() - t0, 1),
    }
