"""Kokoro v1.0 神经 TTS 引擎（可选，macOS / Windows / Linux 通用）。

82M 参数、Apache-2.0、int8 量化约 114MB、24kHz 输出、CPU 实时合成，
比系统 TTS（say / SAPI / espeak-ng）自然得多。模型文件位于
models/kokoro/（与 whisper 模型同款打包方式：随应用内置，不联网）。

引擎不可用（未装 kokoro-onnx、模型缺失或加载失败）时，
tts.py 会自动回退到系统 TTS，App 不受影响。
"""
import os
import re
import threading
import unicodedata
import wave

import numpy as np

from . import paths

# 角色音色名（tts.py 的 voice_a/voice_b 沿用旧角色名）→ Kokoro 音色
_LEGACY_VOICES = {"Samantha": "af_heart", "Daniel": "am_michael"}
_DEFAULT_VOICE = "af_heart"

# voices-v1.0.bin 中的英语音色（af_/am_ 美式，bf_/bm_ 英式）
_EN_VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]
_EN_LOCALE = {v: ("en-US" if v.startswith(("af_", "am_")) else "en-GB") for v in _EN_VOICES}

_kokoro = None
_lock = threading.Lock()
_locks = {}
_last_error = None


def _model_dir():
    # 打包后模型先由 paths.seed_models() 复制到可写数据目录，这里统一走 paths
    return os.path.join(paths.models_dir(), "kokoro")


def _model_files():
    d = _model_dir()
    for name in ("kokoro-v1.0.int8.onnx", "kokoro-v1.0.onnx"):
        model = os.path.join(d, name)
        if os.path.exists(model):
            return model, os.path.join(d, "voices-v1.0.bin")
    return None, None


def _file_lock(key):
    with _lock:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def available():
    """包已安装且模型文件齐全（不加载模型，仅探活）。"""
    model, voices = _model_files()
    if not model or not os.path.exists(voices):
        return False
    try:
        import kokoro_onnx  # noqa: F401
        return True
    except ImportError:
        return False


def error_message():
    return _last_error


def list_voices():
    """返回 [{name, locale}]，供 /api/tts/voices 与设置面板下拉使用。"""
    return [{"name": v, "locale": _EN_LOCALE.get(v, "en-US")} for v in _EN_VOICES]


def _resolve_voice(voice):
    if voice in _EN_VOICES:
        return voice
    return _LEGACY_VOICES.get(voice or "", _DEFAULT_VOICE)


def _speed_for_rate(rate):
    """tts_rate（词/分钟，默认 175）→ kokoro speed（0.5-2.0）。"""
    return max(0.5, min(2.0, (rate or 175) / 175.0))


def _safe_name(s):
    s = unicodedata.normalize("NFKD", s)
    s = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return s[:40] or "audio"


def _load():
    global _kokoro, _last_error
    with _lock:
        if _kokoro is not None:
            return _kokoro
        model, voices = _model_files()
        if not model:
            _last_error = "Kokoro 模型未找到（models/kokoro/）"
            return None
        try:
            from kokoro_onnx import Kokoro
            _kokoro = Kokoro(model, voices)
            _last_error = None
            return _kokoro
        except Exception as e:
            _last_error = f"Kokoro 加载失败: {e}"
            return None


def synthesize(text, voice, rate, cache_dir, cache_key=None):
    """合成 24kHz 16bit 单声道 WAV 到 cache_dir/kokoro/，返回文件路径。

    相同 (voice, rate, text) 只合成一次；失败抛异常，由 tts.py 回退系统 TTS。
    """
    if not text.strip():
        return None
    v = _resolve_voice(voice)
    key = cache_key or f"{v}_{rate}_{_safe_name(text)}"
    sub = os.path.join(cache_dir, "kokoro")
    path = os.path.join(sub, key + ".wav")
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path
    lock = _file_lock(key)
    with lock:
        if os.path.exists(path) and os.path.getsize(path) > 100:
            return path
        model = _load()
        if model is None:
            raise RuntimeError(_last_error or "Kokoro 不可用")
        samples, sr = model.create(
            text, voice=v, speed=_speed_for_rate(rate), lang="en-us"
        )
        data = np.clip(samples * 32767, -32768, 32767).astype(np.int16)
        os.makedirs(sub, exist_ok=True)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(data.tobytes())
        return path
