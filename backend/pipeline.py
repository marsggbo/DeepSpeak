"""Content Pipeline：素材导入 → 转写/字幕 → 切句 → 单元生成 → 富化。

统一入口：
  create_from_text(title, text, format, source_type)
  create_from_file(original_name, tmp_path, content_type)
  create_from_url(url)
  process_material(material_id)   —— 管线主流程（可后台执行）
"""
import json
import os
import re
import shutil
import subprocess
import threading
import urllib.parse

from . import ai as ai_mod
from . import asr as asr_mod
from . import builtin, db, extract, importers, paths, review, textproc, tts

MATERIALS_DIR = os.path.join(paths.materials_dir(), "imported")


def _ffmpeg_exe():
    """ffmpeg 可执行文件：优先 imageio-ffmpeg 内置（跨平台二进制），其次系统 PATH。"""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")

AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".aiff", ".aif", ".flac", ".ogg", ".opus", ".aac", ".caf"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
SUBTITLE_EXTS = {".srt", ".vtt", ".txt", ".ass", ".ssa"}
TEXT_EXTS = {".txt", ".md", ".html", ".htm"}

_jobs = {}


# ---------- 字幕解析 ----------

def parse_subtitle(content, fmt):
    """解析 SRT / VTT / 纯文本。返回 [{"text","start","end"}]（秒），纯文本无时间戳时 start=end=0。"""
    if fmt in ("srt", "vtt"):
        segs = []
        blocks = re.split(r"\n\s*\n", content.strip().replace("\r", ""))
        for b in blocks:
            lines = [l for l in b.split("\n") if l.strip()]
            if not lines:
                continue
            # 跳过序号行
            if lines[0].strip().isdigit():
                lines = lines[1:]
            if not lines:
                continue
            m = re.match(r"(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})", lines[0])
            if m:
                start = _ts_to_sec(m.group(1))
                end = _ts_to_sec(m.group(2))
                text = " ".join(textproc.clean_speaker_label(l.strip()) for l in lines[1:] if l.strip())
                if text:
                    segs.append({"text": text, "start": start, "end": end})
            else:
                text = " ".join(lines)
                if text.strip():
                    segs.append({"text": text.strip(), "start": 0, "end": 0})
        if not segs:
            # 可能整个块是一句话
            segs = [{"text": textproc.clean_speaker_label(b.strip()), "start": 0, "end": 0} for b in blocks if b.strip()]
        return segs
    # plain
    return [{"text": s, "start": 0, "end": 0} for s in textproc.split_sentences(content)]


def _ts_to_sec(ts):
    ts = ts.replace(",", ".")
    parts = ts.split(":")
    h, m = int(parts[0]), int(parts[1])
    s = float(parts[2])
    return h * 3600 + m * 60 + s


def format_subtitle(content):
    """判断粘贴内容格式。"""
    if re.search(r"^\s*\d+\s*$", content, re.M) and "-->" in content:
        return "srt"
    if "WEBVTT" in content[:500] or "-->" in content[:2000]:
        return "vtt"
    return "plain"


# ---------- 创建素材 ----------

def create_from_text(title, text, source_type="manual_text", language="en", subtitle_format=None):
    """从文本/字幕创建素材，立即生成训练单元。"""
    if not text.strip():
        raise ValueError("文本为空")
    fmt = subtitle_format or format_subtitle(text)
    segments = parse_subtitle(text, fmt)
    mid = db.execute(
        "INSERT INTO materials(title, description, media_type, language, status) VALUES(?,?,?,?, 'processing')",
        (title, f"通过文本导入（{source_type}）", "text", language),
    )
    db.execute(
        "INSERT INTO material_sources(material_id, source_type, metadata_json) VALUES(?,?,?)",
        (mid, source_type, json.dumps({"format": fmt})),
    )
    db.execute(
        "INSERT INTO transcripts(material_id, format, source, content) VALUES(?,?,?,?)",
        (mid, fmt, "manual", text),
    )
    threading.Thread(target=_build_units_from_segments, args=(mid, segments, "manual"), daemon=True).start()
    return mid


def create_from_file(original_name, tmp_path, language="en"):
    """从上传文件创建素材。音频/视频 → 需要转写；字幕/文本 → 直接建单元。"""
    ext = os.path.splitext(original_name)[1].lower()
    os.makedirs(MATERIALS_DIR, exist_ok=True)
    dest = os.path.join(MATERIALS_DIR, f"{int(__import__('time').time()*1000)}_{os.path.basename(original_name)}")

    if ext in AUDIO_EXTS:
        shutil.copy(tmp_path, dest)
        mid = db.execute(
            "INSERT INTO materials(title, description, media_type, language, status) VALUES(?,?,?,?, 'processing')",
            (original_name, "本地音频导入", "audio", language),
        )
        db.execute(
            "INSERT INTO material_sources(material_id, source_type, file_path) VALUES(?, 'local_file', ?)",
            (mid, dest),
        )
        threading.Thread(target=_asr_and_build, args=(mid,), daemon=True).start()
        return mid

    if ext in VIDEO_EXTS:
        audio_path = dest + ".m4a"
        exe = _ffmpeg_exe()
        if not exe:
            raise RuntimeError("视频转音频需要 ffmpeg（应用内置的 ffmpeg 不可用）")
        r = subprocess.run(
            [exe, "-y", "-i", tmp_path, "-vn", "-c:a", "aac", "-b:a", "128k", audio_path],
            capture_output=True, timeout=300,
        )
        if r.returncode != 0 or not os.path.exists(audio_path):
            raise RuntimeError("视频转音频失败（需要 ffmpeg）: " + r.stderr.decode(errors="replace")[-300:])
        mid = db.execute(
            "INSERT INTO materials(title, description, media_type, language, status) VALUES(?,?,?,?, 'processing')",
            (original_name, "本地视频导入（已提取音频）", "audio", language),
        )
        db.execute(
            "INSERT INTO material_sources(material_id, source_type, file_path, metadata_json) VALUES(?, 'local_file', ?, ?)",
            (mid, audio_path, json.dumps({"original": original_name})),
        )
        threading.Thread(target=_asr_and_build, args=(mid,), daemon=True).start()
        return mid

    if ext in SUBTITLE_EXTS or ext in TEXT_EXTS:
        with open(tmp_path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        mid = create_from_text(os.path.splitext(original_name)[0], text, source_type="local_file", language=language)
        db.execute("UPDATE material_sources SET file_path=? WHERE material_id=?", (tmp_path, mid))
        return mid

    raise ValueError(f"不支持的文件类型: {ext or '(无扩展名)'}")


def create_from_url(url):
    """URL 导入：YouTube 字幕 / Podcast RSS / 网页文章 / 直链音频。"""
    data = importers.resolve_url(url)
    kind = data["kind"]
    d = data["data"]

    if kind == "youtube":
        mid = create_from_text(d["title"] or "YouTube", d["text"], source_type="youtube", subtitle_format="plain")
        db.execute(
            "INSERT INTO material_sources(material_id, source_type, url, metadata_json) VALUES(?, 'youtube', ?, ?)",
            (mid, url, json.dumps({"segments": d.get("segments", [])})),
        )
        return mid

    if kind == "podcast":
        # 创建素材壳，让用户选 episode（前端再次调用）
        mid = db.execute(
            "INSERT INTO materials(title, description, media_type, language, status) VALUES(?,?,?,?, 'draft')",
            (d["title"] or "Podcast Feed", "Podcast RSS 导入（请选择一期节目）", "audio", "en"),
        )
        db.execute(
            "INSERT INTO material_sources(material_id, source_type, url, metadata_json) VALUES(?, 'podcast', ?, ?)",
            (mid, url, json.dumps({"feed_title": d["title"], "episodes": d["episodes"]})),
        )
        return mid

    if kind == "audio":
        mid = db.execute(
            "INSERT INTO materials(title, description, media_type, language, status) VALUES(?,?,?,?, 'processing')",
            (urllib.parse.unquote(os.path.basename(urllib.parse.urlparse(url).path)) or "Remote Audio", "远程音频导入", "audio", "en"),
        )
        db.execute(
            "INSERT INTO material_sources(material_id, source_type, url) VALUES(?, 'url', ?)",
            (mid, url),
        )
        threading.Thread(target=_download_remote_audio, args=(mid, url), daemon=True).start()
        return mid

    if kind == "web":
        title = d["title"]
        body = "\n".join(d["paragraphs"])
        if not body:
            raise RuntimeError("未能从网页提取到正文，请直接复制文字粘贴导入")
        mid = create_from_text(title, body, source_type="web_article")
        db.execute(
            "INSERT INTO material_sources(material_id, source_type, url) VALUES(?, 'web_article', ?)",
            (mid, url),
        )
        return mid

    raise ValueError("无法识别该 URL 类型")


def _set_progress(mid, step, pct=None):
    """处理进度落库（前端轮询 /api/materials/{id} 展示，避免“一直转圈”无反馈）。"""
    if pct is None:
        db.execute("UPDATE materials SET process_step=?, process_pct=0 WHERE id=?", (step, mid))
    else:
        db.execute("UPDATE materials SET process_step=?, process_pct=? WHERE id=?", (step, int(pct), mid))


def _download_remote_audio(mid, url):
    try:
        os.makedirs(MATERIALS_DIR, exist_ok=True)
        dest = os.path.join(MATERIALS_DIR, f"{mid}_remote_audio")
        ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
        if ext in AUDIO_EXTS:
            dest += ext
        else:
            dest += ".m4a"
        _set_progress(mid, "download", 10)
        data = importers._fetch(url, timeout=120)
        with open(dest, "wb") as f:
            f.write(data)
        db.execute("UPDATE material_sources SET file_path=? WHERE material_id=?", (dest, mid))
        _asr_and_build(mid)
    except Exception as e:
        db.execute("UPDATE materials SET status='error' WHERE id=?", (mid,))
        db.execute("UPDATE materials SET process_step='error', process_pct=0 WHERE id=?", (mid,))
        db.execute("UPDATE material_sources SET metadata_json=? WHERE material_id=?",
                   (json.dumps({"error": str(e)}), mid))


def pick_podcast_episode(material_id, episode_url):
    """Podcast 选择某一期后：下载音频并转写建单元。"""
    row = db.query_one("SELECT status FROM materials WHERE id=?", (material_id,))
    if row and row["status"] == "processing":
        # 已有转写在跑，忽略重复选集，避免两个线程互相覆盖
        return
    # 用 feed 元数据里的单集标题更新素材名，方便识别选了哪一集
    row = db.query_one(
        "SELECT metadata_json FROM material_sources WHERE material_id=? AND source_type='podcast'",
        (material_id,),
    )
    if row:
        try:
            for ep in json.loads(row["metadata_json"] or "{}").get("episodes", []):
                if ep.get("url") == episode_url and (ep.get("title") or "").strip():
                    title = ep["title"].strip()
                    db.execute("UPDATE materials SET title=?, description=? WHERE id=?",
                               (title, f"Podcast 单集 · {title}", material_id))
                    break
        except Exception:
            pass
    db.execute("UPDATE materials SET status='processing' WHERE id=?", (material_id,))
    threading.Thread(target=_download_remote_audio, args=(material_id, episode_url), daemon=True).start()


# ---------- 管线主流程 ----------

def _asr_and_build(mid):
    """ASR → 单元。失败时把素材标记为 error 并保留字幕手动导入能力。"""
    try:
        _set_progress(mid, "preparing", 5)
        _set_duration(mid)
        if not asr_mod.available():
            raise RuntimeError(
                "本地 ASR 未安装（faster-whisper）。请运行 run.sh 自动安装，"
                "或在素材详情里手动粘贴字幕/文本导入。"
            )
        audio_path = _material_audio_path(mid)
        if not audio_path:
            raise RuntimeError("找不到音频文件")
        model = db.get_setting("asr_model", "base.en")
        _set_progress(mid, "transcribing", 15)
        try:
            res = asr_mod.transcribe(audio_path, model_name=model)
        except Exception as e:
            # 模型加载失败时回退 tiny.en 再试一次
            if model != "tiny.en":
                res = asr_mod.transcribe(audio_path, model_name="tiny.en")
            else:
                raise
        text = res["text"].strip()
        if not text:
            raise RuntimeError("ASR 没有识别出内容")
        db.execute(
            "INSERT INTO transcripts(material_id, format, source, content) VALUES(?, 'asr_segments', 'asr', ?)",
            (mid, json.dumps(res["segments"], ensure_ascii=False)),
        )
        _set_progress(mid, "building", 60)
        _build_units_from_segments(mid, res["segments"], "asr")
        _set_progress(mid, "done", 100)
        db.execute(
            "UPDATE materials SET status='ready', duration_ms=? WHERE id=?",
            (int(res["duration"] * 1000), mid),
        )
    except Exception as e:
        db.execute("UPDATE materials SET status='error' WHERE id=?", (mid,))
        db.execute("UPDATE materials SET process_step='error', process_pct=0 WHERE id=?", (mid,))
        db.execute(
            "UPDATE materials SET description=? WHERE id=?",
            (f"处理失败：{e}。可手动粘贴字幕或文本。", mid),
        )


def _set_duration(mid):
    audio_path = _material_audio_path(mid)
    if not audio_path:
        return
    try:
        exe = _ffmpeg_exe()
        if not exe:
            return
        # imageio-ffmpeg 不带 ffprobe，用 ffmpeg -i 的 stderr 解析时长
        r = subprocess.run(
            [exe, "-i", audio_path], capture_output=True, text=True, timeout=30,
        )
        m = re.search(r"Duration: (\d+):(\d+):(\d+\.?\d*)", r.stderr or "")
        if m:
            h, mi, s = m.groups()
            db.execute("UPDATE materials SET duration_ms=? WHERE id=?",
                       (int((int(h) * 3600 + int(mi) * 60 + float(s)) * 1000), mid))
    except Exception:
        pass


def _material_audio_path(mid):
    src = db.query_one(
        "SELECT file_path, url FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1", (mid,)
    )
    if src and src["file_path"] and os.path.exists(src["file_path"]):
        return src["file_path"]
    return None


def store_expressions(unit_id, exprs_json, source="rule"):
    """把表达写入 expressions 表（变体同时用于主动回忆判定）。按 (unit_id, expression) 去重。"""
    for e in exprs_json:
        if not e.get("expression"):
            continue
        dup = db.query_one(
            "SELECT id FROM expressions WHERE unit_id=? AND expression=?",
            (unit_id, e["expression"]),
        )
        if dup:
            continue
        db.execute(
            """INSERT INTO expressions(unit_id, expression, meaning, intent, scene, variants_json, source)
               VALUES(?,?,?,?,?,?,?)""",
            (unit_id, e["expression"], e.get("meaning", ""), e.get("intent", ""),
             e.get("scene", ""), json.dumps(e.get("variants", []), ensure_ascii=False), source),
        )


def _build_units_from_segments(mid, segments, source):
    """segments → 句子 → 训练单元 + 富化。

    分句以句号/问号/感叹号收尾为界（split_sentences）：whisper 的片段常
    把多句合并成一段，先按终止标点拆子句并给每句分配时间，再入库。
    """
    segs = [
        {"text": textproc.clean_speaker_label(s["text"]), "start": s.get("start", 0),
         "end": s.get("end", 0), "speaker": s.get("speaker", "")}
        for s in segments
    ]
    if any(s["start"] > 0 for s in segs):
        # 有时间戳：按 .!? 拆子句（时间按词数比例分配）后对齐
        timed = textproc.align_sentences_to_segments([s["text"] for s in segs], segs)
    else:
        # 纯文本：直接按句切分，无时间戳
        timed = [
            {"text": s, "start_ms": 0, "end_ms": 0, "speaker": ""}
            for s in textproc.split_sentences(" ".join(s["text"] for s in segs))
        ]

    sentences = [t["text"] for t in timed]
    if not sentences:
        raise ValueError("没有可学习的句子")

    scene_votes = {}
    for i, item in enumerate(timed, start=1):
        ana = extract.analyze_unit_text(item["text"])
        scene_votes[ana["scene"]] = scene_votes.get(ana["scene"], 0) + 1
        exprs = ana["expressions"]
        exprs_json = [
            {"expression": e["expression"], "meaning": e.get("label", ""), "intent": e["intent"],
             "variants": e["variants"]} for e in exprs
        ]
        uid = db.execute(
            """INSERT INTO training_units(material_id, seq, text, speaker, start_ms, end_ms,
               scene, difficulty, learning_value, expressions_json, status) VALUES(?,?,?,?,?,?,?,?,?,?, 'NEW')""",
            (mid, i, item["text"], item["speaker"], item["start_ms"], item["end_ms"],
             ana["scene"], ana["difficulty"], ana["learning_value"], json.dumps(exprs_json, ensure_ascii=False)),
        )
        store_expressions(uid, exprs_json, source="rule")
    main_scene = max(scene_votes, key=scene_votes.get) if scene_votes else ""
    db.execute(
        "UPDATE materials SET status='ready', scene=? WHERE id=?",
        (main_scene if main_scene != "other" else "", mid),
    )


def process_text_material(mid):
    """把手动粘贴的文本/字幕素材建成单元（create_from_text 已在后台执行，这里查状态用）。"""
    row = db.query_one("SELECT status FROM materials WHERE id=?", (mid,))
    return dict(row) if row else None


# ---------- LLM 增强（可选） ----------

def enhance_unit_with_llm(unit_id):
    """用 LLM 增强单个单元：表达、场景、难度、解释。失败时静默保留规则结果。"""
    u = db.query_one("SELECT * FROM training_units WHERE id=?", (unit_id,))
    if not u:
        return None
    provider = ai_mod.enabled_provider()
    if not provider:
        return {"error": "没有可用的 AI Provider"}
    data = ai_mod.llm_enhance_unit(provider, dict(u))
    changes = {}
    if data.get("scene") in (r["name"] for r in db.query("SELECT name FROM scenes")):
        db.execute("UPDATE training_units SET scene=? WHERE id=?", (data["scene"], unit_id))
        changes["scene"] = data["scene"]
    try:
        diff = float(data.get("difficulty"))
        if 1 <= diff <= 10:
            db.execute("UPDATE training_units SET difficulty=? WHERE id=?", (round(diff, 1), unit_id))
            changes["difficulty"] = round(diff, 1)
    except (TypeError, ValueError):
        pass
    for e in data.get("expressions", [])[:3]:
        if not e.get("expression"):
            continue
        db.execute(
            """INSERT INTO expressions(unit_id, expression, meaning, intent, variants_json, source)
               VALUES(?,?,?,?,?, 'llm')""",
            (unit_id, e["expression"], e.get("meaning_zh", ""), e.get("intent_zh", ""),
             json.dumps(e.get("variants", []), ensure_ascii=False)),
        )
        changes["expressions_added"] = True
    expl = data.get("explanation_zh", "")
    if expl:
        db.execute(
            "INSERT INTO app_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (f"unit_explain_{unit_id}", expl),
        )
        changes["explanation"] = expl
    return changes or {"note": "LLM 未返回有效增强内容"}


def unit_explanation(unit_id):
    return db.get_setting(f"unit_explain_{unit_id}", "")
