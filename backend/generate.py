# backend/generate.py
"""AI 生成学习材料：LLM 生成场景对话 → Kokoro TTS 逐句合成 → 建训练单元。

用法：POST /api/materials/generate
  {scene, custom_prompt, turns, difficulty, length_seconds, random, title}
无 AI Provider 时抛可读错误；合成在本机完成，只有 LLM 调用需要联网。
"""
import json
import os
import random
import wave

from . import ai as ai_mod
from . import db, paths, pipeline, tts

SCENE_PRESETS = {
    "restaurant": "餐厅点餐：顾客与服务生的简短自然对话",
    "doctor": "看医生：患者描述症状，医生提问并给建议",
    "airport": "机场出行：值机、安检、候机与登机的对话",
    "hotel": "酒店入住：check-in、客房问题、退房",
    "shopping": "购物：找商品、问价格、退换货",
    "office": "职场沟通：同事或上下级之间的日常工作对话",
    "small_talk": "日常闲聊：天气、周末计划、兴趣等轻松话题",
    "travel": "旅行：问路、买票、打车",
    "phone": "打电话：预约、订餐、客服咨询",
    "interview": "求职面试：自我介绍、回答常见问题",
}

DIFFICULTY_PROMPTS = {
    "easy": "只用高频基础词汇，每句 6-10 个词，句子短、结构简单",
    "medium": "用日常常用词汇，每句 8-15 个词，包含 1-2 个实用表达",
    "hard": "用更地道丰富的词汇，每句 12-20 个词，包含习语，接近母语者",
}


def _wav_duration_ms(path):
    try:
        with wave.open(path, "rb") as w:
            return int(w.getnframes() / w.getframerate() * 1000)
    except Exception:
        return 0


def _pick_scene(params):
    if params.get("random"):
        return random.choice(list(SCENE_PRESETS))
    scene = (params.get("scene") or "").strip()
    if scene in SCENE_PRESETS:
        return scene
    return "custom"


def generate_material(params, mid=None):
    """生成一个 AI 材料（同步执行；TTS 较慢，由调用方放后台线程）。返回 mid。

    mid 传入时使用已有占位材料（不重新 INSERT），用于接口先建 processing 行、失败时置 error。
    """
    provider = ai_mod.enabled_provider()
    if not provider:
        raise RuntimeError(
            "还没有可用的 AI Provider。请先到 设置 → AI Provider 配置一个"
            "（支持 Ollama / OpenAI 兼容 / Anthropic / Gemini）"
        )
    if not tts.available():
        raise RuntimeError("TTS 引擎不可用，无法合成音频：" + str(tts.error_message() or ""))

    scene = _pick_scene(params)
    custom = (params.get("custom_prompt") or "").strip()
    try:
        turns = max(2, min(12, int(params.get("turns") or 6)))
    except (TypeError, ValueError):
        turns = 6
    difficulty = params.get("difficulty") or "medium"
    if difficulty not in DIFFICULTY_PROMPTS:
        difficulty = "medium"
    try:
        target_sec = max(30, min(300, int(params.get("length_seconds") or 90)))
    except (TypeError, ValueError):
        target_sec = 90

    scene_desc = SCENE_PRESETS.get(scene, "") or (custom or "日常对话")
    sys_prompt = (
        "你是一位英语学习材料编写专家，为「整段精听 + 逐句强化」学习法编写音频对话材料。\n"
        "要求：\n"
        "1. 全部用英文输出，对话自然、口语化，贴近真实生活；\n"
        "2. 每一句都以句号/问号/感叹号结束，方便逐句切分；\n"
        "3. 双方交替说话，总共约 {turns} 句，总时长约 {sec} 秒；\n"
        "4. 难度：{diff}；\n"
        "5. 对话要有明确的场景情境，有开头有结尾，内容完整，不要写成教学例句。\n"
        "输出严格 JSON（不要输出任何其他文字）："
        '{{"title": "对话标题（英文短语级，简短）", "lines": [{{"speaker": "a" 或 "b", "text": "一句完整英文"}}]}}'
    ).format(turns=turns, sec=target_sec, diff=DIFFICULTY_PROMPTS[difficulty])
    profile = params.get("profile_summary") or ""
    if profile:
        sys_prompt += (
            "\n\n【学习者画像（据此让对话更贴合其薄弱环节，但保持自然）】\n" + profile
        )

    raw = ai_mod.chat(
        provider,
        [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": "场景：" + scene_desc},
        ],
        temperature=0.9, max_tokens=2500, json_mode=True,
    )
    data = ai_mod._parse_json(raw)
    lines = [ln for ln in (data.get("lines") or []) if (ln.get("text") or "").strip()]
    if not lines:
        raise RuntimeError("AI 没有返回有效的对话内容，请重试或换一个 Provider/模型")
    title = ((data.get("title") or "").strip()[:80]) or "AI 生成对话"

    if mid is None:
        mid = db.execute(
            """INSERT INTO materials(title, description, media_type, language, scene, status)
               VALUES(?,?,?,?,?, 'processing')""",
            (title, "AI 生成 · " + scene_desc, "audio", "en", scene if scene != "custom" else ""),
        )
    else:
        db.execute(
            "UPDATE materials SET title=?, description=?, scene=? WHERE id=?",
            (title, "AI 生成 · " + scene_desc, scene if scene != "custom" else "", mid),
        )
    pipeline._set_progress(mid, "generating", 10)

    voice_a = db.get_setting("tts_voice_a", "") or "Samantha"
    voice_b = db.get_setting("tts_voice_b", "") or "Daniel"
    try:
        rate = int(db.get_setting("tts_rate", "175") or 175)
    except ValueError:
        rate = 175

    gen_dir = os.path.join(paths.materials_dir(), "generated")
    os.makedirs(gen_dir, exist_ok=True)
    segments = []
    wav_paths = []
    cursor_ms = 0
    total = len(lines)
    for i, ln in enumerate(lines):
        speaker = "b" if ln.get("speaker") == "b" else "a"
        text = ln["text"].strip()
        wav = tts.synthesize(
            text,
            voice=voice_a if speaker == "a" else voice_b,
            rate=rate,
            cache_key="gen_%d_%d_%s" % (mid, i, speaker),
        )
        if not wav:
            raise RuntimeError("TTS 合成失败（第 %d 句）" % (i + 1))
        dur = _wav_duration_ms(wav) or 1500
        segments.append({
            "text": text, "speaker": speaker,
            "start": cursor_ms / 1000.0, "end": (cursor_ms + dur) / 1000.0,
        })
        wav_paths.append(wav)
        cursor_ms += dur + 300  # 句间 300ms 静音，方便跟读
        pipeline._set_progress(mid, "synthesizing", 20 + int(70 * (i + 1) / total))

    full_path = os.path.join(gen_dir, "%d_full.wav" % mid)
    if not tts.concat_wav(wav_paths, full_path, gap_ms=0):
        raise RuntimeError("整段音频拼接失败")
    db.execute(
        "INSERT INTO material_sources(material_id, source_type, file_path, metadata_json) VALUES(?,?,?,?)",
        (mid, "generated", full_path, json.dumps({"format": "generated"})),
    )
    db.execute(
        "INSERT INTO transcripts(material_id, format, source, content) VALUES(?, 'plain', 'generated', ?)",
        (mid, "\n".join(s["text"] for s in segments)),
    )
    db.execute("UPDATE materials SET duration_ms=? WHERE id=?", (cursor_ms, mid))
    pipeline._build_units_from_segments(mid, segments, "generated")
    pipeline._set_progress(mid, "done", 100)
    return mid
