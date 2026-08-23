"""TTS：跨平台离线语音合成，统一输出 16bit PCM WAV（兼容整段拼接）。

- 神经引擎优先：Kokoro v1.0（backend/tts_engine_kokoro.py，24kHz，自然度高）
- 回退：macOS `say` + `afconvert`（Samantha/Daniel）／Windows SAPI5／Linux espeak-ng
- 全部不可用时：前端降级浏览器 SpeechSynthesis（零 AI 原则）

合成结果缓存到 materials/tts/，相同 (text, voice, rate) 只生成一次。
"""
import base64
import os
import re
import shutil
import subprocess
import sys
import threading
import unicodedata

from . import paths

TTS_DIR = os.path.join(paths.materials_dir(), "tts")
_lock = threading.Lock()

_locks = {}
_voices_cache = None


def _file_lock(key):
    with _lock:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def _kokoro_engine():
    """返回 Kokoro 神经引擎模块；未安装/模型缺失时返回 None。"""
    try:
        from . import tts_engine_kokoro
    except ImportError:
        try:
            import tts_engine_kokoro
        except ImportError:
            return None
    if tts_engine_kokoro.available():
        return tts_engine_kokoro
    return None


def platform():
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform.startswith("win"):
        return "win32"
    if sys.platform.startswith("linux"):
        return "linux"
    return "other"


# 角色音色 → 各平台英文声音（voice_a/voice_b 是 macOS 声音名，其余平台做映射）
_VOICES = {
    "darwin": {"Samantha": "Samantha", "Daniel": "Daniel"},
    "win32": {"Samantha": "Microsoft Zira Desktop", "Daniel": "Microsoft David Desktop"},
    "linux": {"Samantha": "en-us+f3", "Daniel": "en-us+m2"},
}
_DEFAULT_VOICE = {"darwin": "Samantha", "win32": "Microsoft Zira Desktop", "linux": "en-us+f3"}


def _resolve_voice(voice):
    if not voice:
        return _DEFAULT_VOICE.get(platform(), "Samantha")
    return _VOICES.get(platform(), {}).get(voice, voice)


def available():
    try:
        if platform() == "darwin":
            subprocess.run(["say", "-v", "?"], capture_output=True, timeout=10)
            return True
        if platform() == "win32":
            return bool(list_voices())
        if platform() == "linux":
            exe = shutil.which("espeak-ng") or shutil.which("espeak")
            if exe:
                subprocess.run([exe, "--version"], capture_output=True, timeout=10)
                return True
        return False
    except Exception:
        return False


def engine_name():
    """当前生效的 TTS 引擎名（健康检查/横幅用）。"""
    eng = _kokoro_engine()
    return "kokoro" if eng is not None else platform()


def _run_ps(script, timeout=60):
    """PowerShell -EncodedCommand：UTF-16LE base64，彻底避免引号/中文转义问题。"""
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    return subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-EncodedCommand", enc],
        capture_output=True, timeout=timeout,
    )


def list_voices():
    global _voices_cache
    if _voices_cache is not None:
        return _voices_cache
    eng = _kokoro_engine()
    if eng is not None:
        _voices_cache = eng.list_voices()
        return _voices_cache
    try:
        if platform() == "darwin":
            out = subprocess.run(["say", "-v", "?"], capture_output=True,
                                 text=True, timeout=10).stdout
            vs = []
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    vs.append({"name": parts[0], "locale": parts[1]})
            _voices_cache = vs
        elif platform() == "win32":
            script = (
                "Add-Type -AssemblyName System.Speech; "
                "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                "foreach ($v in $s.GetInstalledVoices()) { "
                "$i = $v.VoiceInfo; Write-Output ($i.Name + '|' + $i.Culture.Name) }; "
                "$s.Dispose()"
            )
            out = _run_ps(script).stdout or ""
            _voices_cache = [
                {"name": p[0], "locale": p[1]}
                for line in out.splitlines() if len(p := line.split("|", 1)) == 2
            ]
        else:
            _voices_cache = [
                {"name": "en-us+f3", "locale": "en-US"},
                {"name": "en-us+m2", "locale": "en-US"},
            ]
    except Exception:
        _voices_cache = []
    return _voices_cache


def _safe_name(s):
    s = unicodedata.normalize("NFKD", s)
    s = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return s[:40] or "audio"


def _synth_mac(text, voice, rate, path):
    aiff = os.path.join(TTS_DIR, os.path.splitext(os.path.basename(path))[0] + ".aiff")
    try:
        r = subprocess.run(
            ["say", "-v", voice, "-r", str(rate), "-o", aiff, text],
            capture_output=True, timeout=60,
        )
        if r.returncode != 0 or not os.path.exists(aiff):
            raise RuntimeError("say failed: " + r.stderr.decode(errors="replace"))
        r = subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@22050", "-c", "1", aiff, path],
            capture_output=True, timeout=60,
        )
        if r.returncode != 0 or not os.path.exists(path):
            raise RuntimeError("afconvert failed: " + r.stderr.decode(errors="replace"))
    finally:
        if os.path.exists(aiff):
            try:
                os.remove(aiff)
            except OSError:
                pass


def _synth_win(text, voice, rate, path):
    # SAPI Rate 范围 -10..10，0 ≈ 175 词/分钟
    sapi_rate = max(-10, min(10, round((rate - 175) / 15)))
    t = text.replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Speech; "
        f"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"try {{ $s.SelectVoice('{voice}') }} catch {{}}; "
        f"$s.Rate = {sapi_rate}; "
        f"$s.SetOutputToWaveFile('{path}'); "
        f"$s.Speak('{t}'); "
        "$s.Dispose()"
    )
    r = _run_ps(script)
    if r.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) < 100:
        raise RuntimeError("SAPI synth failed: " + (r.stderr or b"").decode(errors="replace"))


def _synth_linux(text, voice, rate, path):
    exe = shutil.which("espeak-ng") or shutil.which("espeak")
    if not exe:
        raise RuntimeError("espeak-ng not installed")
    r = subprocess.run(
        [exe, "-v", voice, "-s", str(max(80, min(450, rate))), "-w", path, text],
        capture_output=True, timeout=60,
    )
    if r.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) < 100:
        raise RuntimeError("espeak failed: " + r.stderr.decode(errors="replace"))


def synthesize(text, voice="Samantha", rate=175, cache_key=None):
    """生成 wav，返回文件路径。相同 (text, voice, rate) 会缓存。"""
    if not text.strip():
        return None
    eng = _kokoro_engine()
    if eng is not None:
        try:
            return eng.synthesize(text, voice, rate, TTS_DIR, cache_key=cache_key)
        except Exception:
            pass  # 任何失败都回退系统 TTS
    v = _resolve_voice(voice)
    key = cache_key or f"{v}_{rate}_{_safe_name(text)}"
    path = os.path.join(TTS_DIR, key + ".wav")
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path
    os.makedirs(TTS_DIR, exist_ok=True)
    lock = _file_lock(key)
    with lock:
        if os.path.exists(path) and os.path.getsize(path) > 100:
            return path
        try:
            p = platform()
            if p == "darwin":
                _synth_mac(text, v, rate, path)
            elif p == "win32":
                _synth_win(text, v, rate, path)
            elif p == "linux":
                _synth_linux(text, v, rate, path)
            else:
                raise RuntimeError(f"no TTS backend on platform {p}")
            return path
        except Exception:
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
            raise


def concat_wav(paths, out_path, gap_ms=0):
    """把多个同格式 WAV（16bit PCM，任意采样率）顺序拼接，句间可插入静音。

    内置材料整段音频 = 逐句合成后拼接（角色音色得以保留）。
    返回 True 表示成功写出 out_path。
    """
    import struct
    if not paths:
        return False
    # 读取第一段确定格式
    with open(paths[0], "rb") as f:
        head = f.read(44)
    if len(head) < 44 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
        return False
    channels = struct.unpack("<H", head[22:24])[0]
    sample_rate = struct.unpack("<I", head[24:28])[0]
    bits = struct.unpack("<H", head[34:36])[0]
    if bits != 16:
        return False
    gap = bytes((sample_rate * channels * 2 * gap_ms) // 1000) if gap_ms > 0 else b""

    def _data(raw):
        # 跳过 RIFF/WAVE 头，按 chunk 找 data
        i, n = 12, len(raw)
        while i + 8 <= n:
            cid = raw[i:i + 4]
            sz = struct.unpack("<I", raw[i + 4:i + 8])[0]
            if cid == b"data":
                return raw[i + 8:i + 8 + sz]
            i += 8 + sz + (sz & 1)
        return b""

    body = b""
    for p in paths:
        with open(p, "rb") as f:
            body += _data(f.read()) + gap
    total = len(body)
    header = (
        b"RIFF" + struct.pack("<I", 36 + total) + b"WAVE"
        + b"fmt " + struct.pack("<I", 16)
        + struct.pack("<HHIIHH", 1, channels, sample_rate,
                      sample_rate * channels * bits // 8, channels * bits // 8, bits)
        + b"data" + struct.pack("<I", total)
    )
    with open(out_path, "wb") as f:
        f.write(header + body)
    return True
