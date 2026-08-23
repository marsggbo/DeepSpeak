"""整段精听（尚雯婕英语学习法）：以整段材料为单位的训练状态机与复习调度。

流程：通听（反复听整段）→ 逐句听写 + 红笔校对 → 跟读模仿 → 背诵脱稿 → 间隔复习。
全程自评驱动，不依赖 ASR/LLM；机器比对只做"红笔校对"参考，不判分。
"""
import os
import threading
from datetime import datetime, timedelta

from . import db, paths, tts


def _set_progress(material_id, step, pct):
    """整段音频合成进度落库（前端轮询展示）。"""
    try:
        db.execute(
            "UPDATE materials SET process_step=?, process_pct=? WHERE id=?",
            (step, int(pct), material_id),
        )
    except Exception:
        pass

# 段落复习间隔（天）：与句子级共用 SM-2 变体节奏
INTERVALS = [1, 2, 4, 7, 14, 30, 60]
MASTER_MIN_REVIEWS = 2  # 完成 2 次间隔复习且自评通过 → mastered

STATUS_LABEL = {
    "new": "未开始",
    "listening": "通听中",
    "dictation": "听写中",
    "shadowing": "跟读中",
    "offscript": "脱稿中",
    "review_due": "待复习",
    "mastered": "已练透",
}

# 状态机：动作 → (允许的状态, 目标状态)
_ACTS = {
    "listen_again": (("new", "listening"), "listening"),   # 再听一遍（count+1）
    "listen_done": (("new", "listening"), "dictation"),   # 听出大意了 → 听写（new 也允许，首次点主按钮不再静默失败）
    "dict_done": (("listening", "dictation"), "shadowing"),  # 听写+红笔校对完 → 跟读
    "shadow_done": (("shadowing",), "offscript"),          # 跟得上了 → 脱稿
    "offscript_done": (("offscript",), "review_due"),      # 能按原声念出 → 安排复习
    "restart": (("review_due", "mastered"), "offscript"),  # 复习不过/想重练 → 回到脱稿
}

_full_audio_lock = threading.Lock()

# 回退一步（自由导航用）：当前状态 → 上一步
_BACK_TO = {"dictation": "listening", "shadowing": "dictation", "offscript": "shadowing"}


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _days_after(days):
    return (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


def ensure_focus(material_id):
    conn = db.connect()
    conn.execute(
        "INSERT OR IGNORE INTO material_focus(material_id, status) VALUES(?, 'new')",
        (material_id,),
    )
    conn.commit()
    return get_focus(material_id)


def get_focus(material_id):
    row = db.query_one(
        "SELECT * FROM material_focus WHERE material_id=?", (material_id,)
    )
    if row is None:
        return {
            "material_id": material_id, "status": "new", "listen_count": 0,
            "dict_done": 0, "shadow_done": 0, "offscript_done": 0,
            "stage": 0, "next_review_at": None, "reviews_done": 0,
        }
    return dict(row)


def act(material_id, action):
    """自评动作推进段落状态机。返回 (ok, focus, err)。"""
    m = ensure_focus(material_id)
    if action == "back":
        # 回退一步（如自由导航中从听写回到通听），不重置计数
        if m["status"] not in _BACK_TO:
            return False, m, f"当前状态 {m['status']} 不能回退"
        target = _BACK_TO[m["status"]]
        db.execute(
            "UPDATE material_focus SET status=?, updated_at=datetime('now') WHERE material_id=?",
            (target, material_id),
        )
        return True, get_focus(material_id), None
    rule = _ACTS.get(action)
    if not rule:
        return False, m, f"未知动作: {action}"
    allowed, target = rule
    if m["status"] not in allowed:
        return False, m, f"当前状态 {m['status']} 不允许 {action}"

    listen_count = m["listen_count"]
    dict_done = m["dict_done"]
    shadow_done = m["shadow_done"]
    offscript_done = m["offscript_done"]
    next_review_at = m["next_review_at"]
    if action == "listen_again":
        listen_count += 1
    elif action == "listen_done":
        listen_count = max(listen_count, 1)
    elif action == "dict_done":
        dict_done = 1
    elif action == "shadow_done":
        shadow_done = 1
    elif action == "offscript_done":
        offscript_done = 1
        next_review_at = _days_after(INTERVALS[0])  # 完成首轮 → 1 天后复习

    db.execute(
        """UPDATE material_focus SET status=?, listen_count=?, dict_done=?, shadow_done=?,
           offscript_done=?, next_review_at=?, updated_at=datetime('now') WHERE material_id=?""",
        (target, listen_count, dict_done, shadow_done, offscript_done,
         next_review_at, material_id),
    )
    return True, get_focus(material_id), None


def apply_review(material_id, passed):
    """段落复习：自评通过推进间隔，失败回到脱稿重练。"""
    m = ensure_focus(material_id)
    if m["status"] not in ("review_due", "mastered"):
        return False, m, f"当前状态 {m['status']} 不在复习队列"

    stage = m["stage"]
    reviews_done = m["reviews_done"]
    status = m["status"]
    if passed:
        stage = min(stage + 1, len(INTERVALS) - 1)
        reviews_done += 1
        if status == "mastered" or reviews_done >= MASTER_MIN_REVIEWS:
            status = "mastered"
        else:
            status = "review_due"
        next_review_at = _days_after(INTERVALS[stage])
    else:
        # 没过：回退到脱稿重练，间隔档位降一档但不清零
        status = "offscript"
        stage = max(0, stage - 1)
        next_review_at = None

    db.execute(
        """UPDATE material_focus SET status=?, stage=?, reviews_done=?, next_review_at=?,
           updated_at=datetime('now') WHERE material_id=?""",
        (status, stage, reviews_done, next_review_at, material_id),
    )
    db.execute(
        "INSERT INTO focus_review_history(material_id, result, interval_days) VALUES(?,?,?)",
        (material_id, "pass" if passed else "fail",
         INTERVALS[min(stage, len(INTERVALS) - 1)]),
    )
    return True, get_focus(material_id), None


def due_focus():
    """到期的段落复习列表（含材料信息）。"""
    rows = db.query(
        """SELECT f.*, m.title, m.description, m.scene, m.is_builtin
           FROM material_focus f JOIN materials m ON m.id=f.material_id
           WHERE f.status IN ('review_due','mastered') AND f.next_review_at IS NOT NULL
             AND f.next_review_at <= datetime('now')
           ORDER BY f.next_review_at""",
    )
    return [dict(r) for r in rows]


def focus_progress(material_id):
    """材料详情用：精听进度摘要。"""
    f = get_focus(material_id)
    steps = {
        "listen": bool(f["listen_count"]),
        "dictation": bool(f["dict_done"]),
        "shadowing": bool(f["shadow_done"]),
        "offscript": bool(f["offscript_done"]),
    }
    f["due"] = bool(f["next_review_at"]) and f["next_review_at"] <= _now()
    return {**f, "steps": steps}


# ---------- 整段音频 ----------

def material_full_audio_ready(material_id):
    """整段音频是否已可用（只检查，不触发生成）。"""
    mat = db.query_one("SELECT * FROM materials WHERE id=?", (material_id,))
    if not mat:
        return False
    src = db.query_one(
        "SELECT file_path, metadata_json, source_type FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1",
        (material_id,),
    )
    if src and src["file_path"] and os.path.exists(src["file_path"]):
        return True
    if mat["is_builtin"] and src:
        meta = json_loads(src["metadata_json"]) if src else {}
        key = meta.get("key", "")
        from .builtin import _material_audio_dir
        if key:
            # 与 material_full_audio_path 的产物路径保持一致（含音色/语速指纹）
            va = db.get_setting("tts_voice_a", "") or "Samantha"
            vb = db.get_setting("tts_voice_b", "") or "Daniel"
            try:
                rate = int(db.get_setting("tts_rate", "175"))
            except ValueError:
                rate = 175
            p = os.path.join(_material_audio_dir(key), f"full_{va}_{vb}_{rate}.wav")
            return os.path.exists(p) and os.path.getsize(p) > 100
    p = os.path.join(paths.materials_dir(), "focus", f"m{material_id:04d}.wav")
    return os.path.exists(p) and os.path.getsize(p) > 100


def material_full_audio_path(material_id):
    """整段音频：内置材料 = 逐句 TTS 拼接；有源音频 = 源文件；否则逐句 TTS 拼接。"""
    mat = db.query_one("SELECT * FROM materials WHERE id=?", (material_id,))
    if not mat:
        return None
    src = db.query_one(
        "SELECT file_path, metadata_json, source_type FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1",
        (material_id,),
    )
    # 有源音频文件：直接用
    if src and src["file_path"] and os.path.exists(src["file_path"]):
        return src["file_path"]

    # 内置材料：逐句（各自角色音色）拼接
    if mat["is_builtin"]:
        from .builtin import _material_audio_dir
        meta = json_loads(src["metadata_json"]) if src else {}
        key = meta.get("key", "")
        d = _material_audio_dir(key) if key else None
        if d:
            # 角色音色 A/B 取用户设置（默认 Samantha/Daniel），文件名含音色指纹防旧缓存
            va = db.get_setting("tts_voice_a", "") or "Samantha"
            vb = db.get_setting("tts_voice_b", "") or "Daniel"
            rate = int(db.get_setting("tts_rate", "175"))
            path = os.path.join(d, f"full_{va}_{vb}_{rate}.wav")
            if os.path.exists(path) and os.path.getsize(path) > 100:
                return path
            with _full_audio_lock:
                if os.path.exists(path) and os.path.getsize(path) > 100:
                    return path
                voices = {"a": va, "b": vb}
                units = db.query(
                    "SELECT id, text, speaker FROM training_units WHERE material_id=? ORDER BY seq",
                    (material_id,),
                )
                parts = []
                for i, u in enumerate(units):
                    voice = voices.get(u["speaker"], "Samantha")
                    try:
                        wav = tts.synthesize(
                            u["text"], voice=voice, rate=rate,
                            cache_key=f"builtin_{key}_{voice}_{rate}_{u['id']}",
                        )
                    except Exception as e:
                        # 单句失败不阻塞整体（后台线程异常会静默死亡，导致进度卡死）
                        import traceback
                        traceback.print_exc()
                        _set_progress(material_id, "error", 0)
                        db.execute(
                            "UPDATE materials SET status='error', description=? WHERE id=?",
                            (f"整段音频合成失败（第 {i + 1} 句）：{e}", material_id),
                        )
                        return None
                    if wav:
                        parts.append(wav)
                    _set_progress(material_id, "synthesizing", 30 + int(50 * (i + 1) / len(units)))
                if parts and tts.concat_wav(parts, path, gap_ms=300):
                    return path
        return None

    # 文本导入等：逐句用户默认音色（A 角）拼接
    units = db.query(
        "SELECT id, text FROM training_units WHERE material_id=? ORDER BY seq", (material_id,)
    )
    if not units:
        return None
    out_dir = os.path.join(paths.materials_dir(), "focus")
    os.makedirs(out_dir, exist_ok=True)
    voice = db.get_setting("tts_voice_a", "") or "Samantha"
    rate = int(db.get_setting("tts_rate", "175"))
    path = os.path.join(out_dir, f"m{material_id:04d}_{voice}_{rate}.wav")
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path
    with _full_audio_lock:
        if os.path.exists(path) and os.path.getsize(path) > 100:
            return path
        parts = []
        for i, u in enumerate(units):
            try:
                wav = tts.synthesize(u["text"], voice=voice, rate=rate,
                                     cache_key=f"focus_{voice}_{rate}_{u['id']}")
            except Exception as e:
                import traceback
                traceback.print_exc()
                _set_progress(material_id, "error", 0)
                db.execute(
                    "UPDATE materials SET status='error', description=? WHERE id=?",
                    (f"整段音频合成失败（第 {i + 1} 句）：{e}", material_id),
                )
                return None
            if wav:
                parts.append(wav)
            _set_progress(material_id, "synthesizing", 30 + int(50 * (i + 1) / len(units)))
        if parts and tts.concat_wav(parts, path, gap_ms=300):
            return path
    return None


def json_loads(s):
    import json
    try:
        return json.loads(s or "{}")
    except Exception:
        return {}
