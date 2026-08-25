"""DeepSpeak 本地服务器：HTTP + REST API + 静态前端。

零第三方依赖（标准库）。启动后浏览器访问 http://127.0.0.1:8531
"""
import argparse
import base64
import datetime
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import ai as ai_mod
from . import asr as asr_mod
from . import audio_contract, builtin, db, diffing, extract, focus, generate, importers, paths, pipeline, review, textproc, tts, wordbank

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = paths.frontend_dir()
VERSION = "0.2.3"

AUDIO_MIME = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aiff": "audio/aiff",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac",
    ".caf": "audio/x-caf", ".webm": "video/webm",
}

# 单元状态机合法迁移
TRANSITIONS = {
    "NEW": {"LISTENING"},
    "LISTENING": {"DICTATION"},
    "DICTATION": {"REVEALED"},
    "REVEALED": {"UNDERSTOOD"},
    "UNDERSTOOD": {"SHADOWING", "ACTIVE_RECALL"},
    "SHADOWING": {"ACTIVE_RECALL", "UNDERSTOOD"},
    "ACTIVE_RECALL": {"REVIEW_DUE", "SHADOWING", "UNDERSTOOD"},
    "REVIEW_DUE": {"REVIEW_DUE", "MASTERED", "ACTIVE_RECALL"},
    "MASTERED": {"MASTERED", "REVIEW_DUE"},
}


# ---------- 小工具 ----------

def _body_json(handler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    raw = handler.rfile.read(length) if length else b""
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def _ok(handler, data=None, status=200):
    body = json.dumps(data, ensure_ascii=False).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _err(handler, message, status=400):
    _ok(handler, {"error": message}, status)


def _get_int(handler, key, default=0):
    try:
        return int(handler.path_params.get(key, default))
    except (TypeError, ValueError):
        return default


def _transition(unit_id, to):
    """校验并执行状态迁移，返回 (ok, status, error)。"""
    row = db.query_one("SELECT status FROM training_units WHERE id=?", (unit_id,))
    if not row:
        return False, None, "单元不存在"
    cur = row["status"]
    if to not in TRANSITIONS.get(cur, set()):
        return False, cur, f"不允许的状态迁移: {cur} → {to}"
    db.execute("UPDATE training_units SET status=? WHERE id=?", (to, unit_id))
    return True, to, None


def _update_unit_after_session(unit_id, session_type, result, forced_status=None):
    """记录掌握度 + 按状态机推进状态。返回 (unit_row, mastery)。"""
    review.record_session_result(unit_id, session_type, result)
    if forced_status:
        db.execute("UPDATE training_units SET status=? WHERE id=?", (forced_status, unit_id))
    else:
        status, _regressed = review.unit_status_after_session(unit_id, session_type, result)
        db.execute("UPDATE training_units SET status=? WHERE id=?", (status, unit_id))
    return _unit_json(unit_id)


def _unit_json(unit_id):
    d = review.unit_progress(unit_id)
    if d is None:
        return None
    d["explanation"] = pipeline.unit_explanation(unit_id)
    d["audio"] = _unit_audio_info(unit_id)
    return d


def _unit_audio_info(unit_id):
    """单元的音频信息：有源音频时用时间定位，否则用 TTS wav。"""
    u = db.query_one("SELECT * FROM training_units WHERE id=?", (unit_id,))
    if not u:
        return None
    mat = db.query_one("SELECT * FROM materials WHERE id=?", (u["material_id"],))
    src = db.query_one(
        "SELECT file_path FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1",
        (u["material_id"],),
    )
    if mat and mat["is_builtin"]:
        return {"url": f"/api/audio/unit/{unit_id}.wav", "start_ms": 0, "end_ms": 0, "kind": "file"}
    if src and src["file_path"] and os.path.exists(src["file_path"]):
        # 逐句区间走双端共享契约（audio_contract）：
        # end 缺失/非法 → 截到下句起点；最后一句按词数估时长，保证永远有截断。
        next_start = 0
        if not u["end_ms"] or u["end_ms"] <= (u["start_ms"] or 0):
            nxt = db.query_one(
                "SELECT start_ms FROM training_units WHERE material_id=? AND seq>? AND start_ms>0 ORDER BY seq LIMIT 1",
                (u["material_id"], u["seq"]),
            )
            next_start = nxt["start_ms"] if nxt else 0
        start, end = audio_contract.resolve_unit_range(
            u["start_ms"], u["end_ms"], u["text"], next_start
        )
        return {
            "url": f"/api/audio/material/{u['material_id']}",
            "start_ms": start, "end_ms": end,
            "kind": "range", "duration_ms": mat["duration_ms"] if mat else 0,
        }
    return {"url": f"/api/audio/unit/{unit_id}.wav", "start_ms": 0, "end_ms": 0, "kind": "file"}


def _material_json(mid):
    mat = db.query_one("SELECT * FROM materials WHERE id=?", (mid,))
    if not mat:
        return None
    d = dict(mat)
    src = db.query_one(
        "SELECT * FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1", (mid,)
    )
    if src:
        meta = json.loads(src["metadata_json"] or "{}")
        d["source"] = {
            "type": src["source_type"], "url": src["url"],
            "episodes": meta.get("episodes", []),
            "error": meta.get("error", ""),
            "has_audio": bool(src["file_path"] and os.path.exists(src["file_path"])),
        }
        d["source_type"] = src["source_type"]
    else:
        d["source"] = {}
        d["source_type"] = "manual_text"
    units = db.query(
        "SELECT id, seq, text, status, scene, difficulty, learning_value FROM training_units WHERE material_id=? ORDER BY seq",
        (mid,),
    )
    d["units"] = [dict(u) for u in units]
    for u in d["units"]:
        u["audio"] = _unit_audio_info(u["id"])
    d["unit_total"] = len(units)
    d["unit_done"] = sum(1 for u in units if u["status"] in ("REVIEW_DUE", "MASTERED"))
    d["unit_mastered"] = sum(1 for u in units if u["status"] == "MASTERED")
    d["unit_stats"] = {
        "total": d["unit_total"],
        "done": d["unit_done"],
        "mastered": d["unit_mastered"],
    }
    label, emoji = extract.scene_label(d["scene"] or "")
    d["scene_label"] = label
    d["scene_emoji"] = emoji
    f = focus.focus_progress(mid)
    f["audio_ready"] = focus.material_full_audio_ready(mid)
    d["focus"] = f
    return d


def _require_ai(handler):
    """LLM 调用前的隐私检查。"""
    consent = db.get_setting("ai_consent", "ask")
    granted = db.get_setting("ai_consent_granted_at", "")
    if consent == "never":
        _err(handler, "隐私设置已禁止向 AI Provider 发送内容（设置 → AI Providers → 隐私）", 403)
        return None
    if consent == "ask":
        try:
            granted_ts = float(granted or 0)
        except ValueError:
            granted_ts = 0
        if time.time() - granted_ts > 7 * 86400:
            _err(handler, "需要确认：将把当前句子发送给你配置的 AI Provider（可在设置中改为始终允许）", 428)
            return None
    provider = ai_mod.enabled_provider()
    if not provider:
        _err(handler, "没有可用的 AI Provider（设置 → AI Providers）", 404)
        return None
    return provider


def _continue_focus_json():
    """今日页「继续整段精听」：进行中最优先，否则推荐一篇未开始的（含从未开始的）。"""
    row = db.query_one(
        """SELECT f.*, m.title, m.scene FROM material_focus f
           JOIN materials m ON m.id=f.material_id
           WHERE f.status NOT IN ('new','mastered')
           ORDER BY f.updated_at DESC LIMIT 1"""
    )
    if row:
        return _focus_card(row)
    row = db.query_one(
        """SELECT m.id AS material_id, m.title, m.scene, COALESCE(f.status,'new') AS status,
                  COALESCE(f.listen_count,0) AS listen_count
           FROM materials m LEFT JOIN material_focus f ON f.material_id=m.id
           WHERE COALESCE(f.status,'new')='new'
           ORDER BY m.is_builtin DESC, m.id LIMIT 1"""
    )
    if row:
        return _focus_card(row)
    return None


def _learner_profile():
    """学习画像：把散落各表的学习历史聚合成结构化画像 + 一段可直接喂给 LLM 的中文总结。

    供统计页「AI 分析」与 AI 生成材料（参考画像）使用；引擎本地模式有同构实现（engine.js）。
    """
    def one(sql, args=()):
        r = db.query_one(sql, args)
        return r[0] if r else 0

    def avg(sql, args=()):
        r = db.query_one(sql, args)
        return r[0] if r else 0

    def pct(a, b):
        return round(a * 100 / b) if b else 0

    # 听写 / 整段听写
    dict_total = one("SELECT COUNT(*) c FROM answers WHERE kind='dictation'")
    dict_passed = one("SELECT COUNT(*) c FROM answers WHERE kind='dictation' AND passed=1")
    dict_avg_wer = avg("SELECT AVG(wer) w FROM answers WHERE kind='dictation' AND wer IS NOT NULL") or 0
    focus_total = one("SELECT COUNT(*) c FROM focus_dictations")
    focus_avg_wer = avg("SELECT AVG(overall_wer) w FROM focus_dictations") or 0
    # 薄弱句：整段听写里逐句准确率 ≤60% 的句子（detail_json 为 [{text, correct, total}]）
    weak_sentences = []
    for r in db.query("SELECT detail_json FROM focus_dictations WHERE detail_json IS NOT NULL AND detail_json != ''"):
        try:
            items = json.loads(r["detail_json"])
        except Exception:
            continue
        for it in items or []:
            tot = it.get("total") or 0
            cor = it.get("correct") or 0
            if tot >= 3 and cor / tot <= 0.6 and it.get("text"):
                weak_sentences.append({"text": str(it["text"])[:120], "acc": round(cor / tot, 2)})
    weak_sentences = sorted(weak_sentences, key=lambda x: x["acc"])[:8]
    # 口语 / 主动回忆
    speak_total = one("SELECT COUNT(*) c FROM speaking_attempts")
    speak_passed = one("SELECT COUNT(*) c FROM speaking_attempts WHERE passed=1")
    speak_avg = avg("SELECT AVG(match_score) s FROM speaking_attempts WHERE match_score IS NOT NULL") or 0
    recall_total = one("SELECT COUNT(*) c FROM speaking_attempts WHERE kind='active_recall'")
    recall_passed = one("SELECT COUNT(*) c FROM speaking_attempts WHERE kind='active_recall' AND passed=1")
    # 复习 / 生词 / 打卡
    review_total = one("SELECT COUNT(*) c FROM review_history")
    word_total = one("SELECT COUNT(*) c FROM words")
    checkin_total = one("SELECT COUNT(*) c FROM checkins")
    dates = {r["date"] for r in db.query("SELECT date FROM checkins")}
    streak = 0
    d = datetime.date.today()
    while d.isoformat() in dates:
        streak += 1
        d -= datetime.timedelta(days=1)
    # 材料 / 单元
    unit_total = one("SELECT COUNT(*) c FROM training_units")
    unit_mastered = one("SELECT COUNT(*) c FROM training_units WHERE status='MASTERED'")
    mat_total = one("SELECT COUNT(*) c FROM materials")
    active_mats = one(
        """SELECT COUNT(*) c FROM material_focus WHERE status IN
           ('listening','dictation','shadowing','offscript','review_due')""")
    weak_scenes = review.weak_scenes()

    profile = {
        "materials": {"total": mat_total, "units": unit_total, "mastered": unit_mastered, "active": active_mats},
        "dictation": {"total": dict_total, "passed": dict_passed, "pass_rate": pct(dict_passed, dict_total),
                      "avg_wer": round(dict_avg_wer, 3)},
        "focus_dictation": {"total": focus_total, "avg_wer": round(focus_avg_wer, 3)},
        "weak_sentences": weak_sentences,
        "speaking": {"total": speak_total, "passed": speak_passed, "pass_rate": pct(speak_passed, speak_total),
                     "avg_score": round(speak_avg)},
        "recall": {"total": recall_total, "passed": recall_passed, "pass_rate": pct(recall_passed, recall_total)},
        "review": {"total": review_total},
        "words": {"total": word_total},
        "checkins": {"total": checkin_total, "streak": streak},
        "weak_scenes": weak_scenes,
    }
    lines = [
        f"累计：材料 {mat_total} 个，句子 {unit_total} 句（已掌握 {unit_mastered}，进行中 {active_mats} 个材料）。",
        f"听写：共 {dict_total} 次，通过率 {pct(dict_passed, dict_total)}%，平均词错率 {round(dict_avg_wer * 100)}%；"
        f"整段听写 {focus_total} 次，平均准确率 {round((1 - focus_avg_wer) * 100)}%。",
        f"口语：共 {speak_total} 次，通过率 {pct(speak_passed, speak_total)}%，平均匹配分 {round(speak_avg)}；"
        f"其中主动回忆 {recall_total} 次（通过率 {pct(recall_passed, recall_total)}%）。",
        f"复习：共完成 {review_total} 次。生词本收藏 {word_total} 个。打卡 {checkin_total} 天，当前连续 {streak} 天。",
    ]
    if weak_sentences:
        lines.append("薄弱句（整段听写准确率≤60%）：" +
                     "；".join(f"「{w['text']}」({w['acc'] * 100:.0f}%)" for w in weak_sentences[:5]))
    if weak_scenes:
        lines.append("薄弱场景：" + "、".join(f"{w['label']}（{w['avg_mastery']:.2f}分）" for w in weak_scenes))
    return {"profile": profile, "summary": "\n".join(lines)}


def _focus_card(row):
    has = "dict_done" in row.keys()  # LEFT JOIN 推荐行没有完整进度列
    steps = {
        "listen": bool(row["listen_count"]),
        "dictation": has and bool(row["dict_done"]),
        "shadowing": has and bool(row["shadow_done"]),
        "offscript": has and bool(row["offscript_done"]),
    }
    return {
        "material_id": row["material_id"], "title": row["title"],
        "scene": row["scene"], "status": row["status"],
        "listen_count": row["listen_count"], "steps": steps,
        "next_review_at": row["next_review_at"] if has else None,
    }


# ---------- 各资源处理器 ----------

def api_router(handler):
    p = handler.path_params
    path = handler.route
    method = handler.command

    # ---------- 健康 / 概览 ----------
    if path == "/api/health" and method == "GET":
        return _ok(handler, {
            "ok": True, "version": VERSION,
            "asr_available": asr_mod.available(),
            "asr_error": asr_mod.error_message(),
            "asr_model_ready": asr_mod.model_ready(),
            "tts_available": tts.available(),
            "tts_engine": tts.engine_name(),
            "ai_provider": bool(ai_mod.enabled_provider()),
            "platform": "darwin" if sys_platform_is_mac() else "other",
        })

    if path == "/api/today" and method == "GET":
        counts = review.today_counts()
        cont = review.continue_unit()
        cont_json = None
        if cont:
            cont_json = {
                "id": cont["id"], "text": cont["text"], "status": cont["status"],
                "material_id": cont["material_id"], "seq": cont["seq"],
                "scene": cont["scene"],
            }
        focus_due = focus.due_focus()
        return _ok(handler, {
            **counts,
            "continue_unit": cont_json,
            "weak_scenes": review.weak_scenes(),
            "total_units": db.query_one("SELECT COUNT(*) c FROM training_units")["c"],
            "mastered": db.query_one("SELECT COUNT(*) c FROM training_units WHERE status='MASTERED'")["c"],
            "focus_due": len(focus_due),
            "continue_focus": _continue_focus_json(),
        })

    # ---------- 材料 ----------
    if path == "/api/materials" and method == "GET":
        # 排序白名单：time_desc（默认，最近导入）/ time_asc（最早导入）/ old（内置优先旧序）
        sort = (handler.query.get("sort") or [""])[0]
        order = {
            "time_asc": "is_builtin DESC, created_at ASC, id ASC",
            "old": "is_builtin DESC, id DESC",
        }.get(sort, "is_builtin DESC, created_at DESC, id DESC")
        mats = db.query(f"SELECT * FROM materials ORDER BY {order}")
        out = []
        for m in mats:
            d = dict(m)
            n = db.query_one("SELECT COUNT(*) c FROM training_units WHERE material_id=?", (m["id"],))["c"]
            done = db.query_one(
                "SELECT COUNT(*) c FROM training_units WHERE material_id=? AND status IN ('REVIEW_DUE','MASTERED')",
                (m["id"],),
            )["c"]
            label, emoji = extract.scene_label(m["scene"] or "")
            f = focus.get_focus(m["id"])
            src = db.query_one(
                "SELECT source_type FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1",
                (m["id"],),
            )
            out.append({
                **d, "scene_label": label, "scene_emoji": emoji,
                "source_type": src["source_type"] if src else "manual_text",
                "unit_total": n, "unit_done": done,
                "unit_mastered": db.query_one(
                    "SELECT COUNT(*) c FROM training_units WHERE material_id=? AND status='MASTERED'", (m["id"],))["c"],
                "focus_status": f["status"],
            })
        return _ok(handler, {"materials": out})

    if path == "/api/materials" and method == "POST":
        body = _body_json(handler)
        title = (body.get("title") or "").strip() or "未命名材料"
        text = (body.get("text") or "").strip()
        if not text:
            return _err(handler, "文本为空")
        try:
            mid = pipeline.create_from_text(title, text, source_type=body.get("source_type", "manual_text"))
        except Exception as e:
            return _err(handler, str(e))
        time.sleep(0.3)
        return _ok(handler, {"id": mid, "material": _material_json(mid)})

    # ---------- 整段精听（尚雯婕法） ----------
    m = re.match(r"^/api/materials/(\d+)/focus/prepare$", path)
    if m and method == "POST":
        mid = int(m.group(1))
        threading.Thread(target=focus.material_full_audio_path, args=(mid,), daemon=True).start()
        return _ok(handler, {"ok": True, "message": "正在生成整段音频"})

    m = re.match(r"^/api/materials/(\d+)/focus$", path)
    if m and method == "GET":
        mid = int(m.group(1))
        f = focus.focus_progress(mid)
        f["audio_ready"] = focus.material_full_audio_ready(mid)
        return _ok(handler, {"focus": f})

    if m and method == "POST":
        body = _body_json(handler)
        action = body.get("action", "")
        ok, f, err = focus.act(int(m.group(1)), action)
        if not ok:
            return _err(handler, err or "状态迁移失败")
        return _ok(handler, {"focus": f, "status": f["status"]})

    if path == "/api/focus/due" and method == "GET":
        due = focus.due_focus()
        out = []
        for d in due:
            label, emoji = extract.scene_label(d["scene"] or "")
            out.append({
                "material_id": d["material_id"], "title": d["title"],
                "scene_label": label, "scene_emoji": emoji,
                "status": d["status"], "stage": d["stage"],
                "reviews_done": d["reviews_done"], "next_review_at": d["next_review_at"],
            })
        return _ok(handler, {"due": out})

    m = re.match(r"^/api/materials/(\d+)/tags$", path)
    if m and method == "POST":
        body = _body_json(handler)
        tags = [t.strip().lstrip("#") for t in (body.get("tags") or "").split(",") if t.strip()]
        db.execute("UPDATE materials SET tags=? WHERE id=?", (",".join(tags), int(m.group(1))))
        return _ok(handler, {"tags": tags})

    m = re.match(r"^/api/focus/(\d+)/review$", path)
    if m and method == "POST":
        body = _body_json(handler)
        ok, f, err = focus.apply_review(int(m.group(1)), bool(body.get("passed")))
        if not ok:
            return _err(handler, err or "复习状态无效")
        return _ok(handler, {"focus": f, "status": f["status"]})

    if path == "/api/materials/upload" and method == "POST":
        try:
            fields = _parse_multipart(handler)
            f = fields.get("file")
            if not f:
                return _err(handler, "没有收到文件")
            name, data = f
            with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(name)[1]) as tf:
                tf.write(data)
                tmp = tf.name
            try:
                mid = pipeline.create_from_file(name, tmp)
            finally:
                os.unlink(tmp)
            time.sleep(0.3)
            return _ok(handler, {"id": mid, "material": _material_json(mid)})
        except Exception as e:
            return _err(handler, str(e))

    # ---------- 离线词库 ----------
    if path == "/api/wordbank" and method == "GET":
        q = (handler.query.get("q") or [""])[0]
        hit = wordbank.lookup(q)
        if hit:
            return _ok(handler, {"found": True, "word": hit[0], "pos": hit[1][0], "meaning": hit[1][1]})
        return _ok(handler, {"found": False, "word": q, "pos": "", "meaning": ""})

    # ---------- 点词/选句释义（explainer） ----------
    if path == "/api/explain" and method == "POST":
        body = _body_json(handler)
        text = (body.get("text") or "").strip()
        kind = body.get("kind", "word")
        if not text:
            return _err(handler, "缺少文本")
        text = text[:500]
        if kind == "word":
            # 免费层：内置离线词库（1768 词）
            hit = wordbank.lookup(text)
            if hit:
                return _ok(handler, {"found": True, "kind": "word", "word": hit[0],
                                     "pos": hit[1][0], "meaning": hit[1][1], "source": "wordbank"})
            # 词库未命中：先试免费在线词典（dictionaryapi.dev，无需 key；离线自动跳过）
            online = wordbank.lookup_online(text)
            if online:
                return _ok(handler, {"found": True, "kind": "word", "word": online["word"],
                                     "pos": online["pos"], "meaning": online["meaning"],
                                     "example_en": online["example_en"],
                                     "phonetic": online["phonetic"], "source": "online"})
            # 在线词典未命中且配置了 LLM：LLM 兜底释义（同样走隐私确认）
            provider = ai_mod.enabled_provider()
            if not provider:
                return _ok(handler, {"found": False, "kind": "word",
                                     "word": text.split()[0] if text.split() else text,
                                     "pos": "", "meaning": ""})
            provider = _require_ai(handler)
            if provider is None:
                return
            try:
                out = ai_mod.chat(provider, [
                    {"role": "system", "content": ai_mod._SYS},
                    {"role": "user", "content": json.dumps({
                        "task": "Explain this English word/phrase for a Chinese learner.",
                        "word": text,
                        "output_schema": {"pos": "词性，如 v./n./adj./phr.", "meaning_zh": "简短中文释义",
                                          "example_en": "一个自然例句", "example_zh": "例句中文"},
                        "rule": "Max 2 examples, keep meaning within 40 Chinese chars.",
                    }, ensure_ascii=False)},
                ])
                data = ai_mod._parse_json(out) or {}
                if data.get("meaning_zh"):
                    return _ok(handler, {"found": True, "kind": "word", "word": text,
                                         "pos": data.get("pos", ""), "meaning": data["meaning_zh"],
                                         "example_en": data.get("example_en", ""),
                                         "example_zh": data.get("example_zh", ""), "source": "llm"})
            except Exception as e:
                return _err(handler, f"AI 调用失败: {e}", 502)
            return _ok(handler, {"found": False, "kind": "word", "word": text, "pos": "", "meaning": ""})
        if kind == "sentence":
            # 句子通俗解释：需用户配置的 LLM（Ollama/OpenAI 兼容均可）；支持自定义提示词
            provider = _require_ai(handler)
            if provider is None:
                return
            try:
                custom = db.get_setting("llm_explain_prompt", "")
                r = ai_mod.llm_explain_sentence(provider, text, custom)
            except Exception as e:
                return _err(handler, f"AI 调用失败: {e}", 502)
            if not r["translation_zh"] and not r["explanation_zh"]:
                return _err(handler, "AI 未返回内容，请重试")
            return _ok(handler, {"found": True, "kind": "sentence", **r, "source": "llm"})
        return _err(handler, "不支持的 kind")

    # ---------- 生词词组（words） ----------
    m = re.match(r"^/api/materials/(\d+)/focus/expressions$", path)
    if m and method == "POST":
        # 听写校对后保存生词（按 material+expression 去重）
        mid = int(m.group(1))
        items = (_body_json(handler).get("items") or [])
        saved = 0
        for it in items:
            expr = (it.get("expression") or "").strip()
            if not expr:
                continue
            exists = db.query_one(
                "SELECT id FROM words WHERE material_id=? AND lower(expression)=lower(?)",
                (mid, expr),
            )
            if exists:
                continue
            db.execute(
                """INSERT INTO words(material_id, unit_id, expression, meaning, note, source)
                   VALUES(?,?,?,?,?, 'user')""",
                (mid, it.get("unit_id"), expr,
                 (it.get("meaning") or "").strip(), (it.get("note") or "").strip()),
            )
            saved += 1
        return _ok(handler, {"saved": saved})

    m = re.match(r"^/api/materials/(\d+)/words$", path)
    if m and method == "GET":
        rows = db.query(
            """SELECT w.id, w.expression, w.meaning, w.note, w.source, w.unit_id, w.created_at,
                      u.text AS unit_text
               FROM words w LEFT JOIN training_units u ON u.id=w.unit_id
               WHERE w.material_id=? ORDER BY w.id DESC""",
            (int(m.group(1)),),
        )
        out = []
        for r in rows:
            d = dict(r)
            d["audio"] = _unit_audio_info(r["unit_id"]) if r["unit_id"] else None
            out.append(d)
        return _ok(handler, {"words": out})

    m = re.match(r"^/api/words/(\d+)$", path)
    if m:
        wid = int(m.group(1))
        if method == "DELETE":
            db.execute("DELETE FROM words WHERE id=?", (wid,))
            return _ok(handler, {"ok": True})
        if method == "PATCH":
            body = _body_json(handler)
            fields, args = [], []
            for k in ("meaning", "note"):
                if k in body:
                    fields.append(f"{k}=?")
                    args.append(str(body[k]))
            if fields:
                args.append(wid)
                db.execute(f"UPDATE words SET {', '.join(fields)} WHERE id=?", args)
            return _ok(handler, {"ok": True})

    # ---------- 整段精听听写历史（进步对比） ----------
    m = re.match(r"^/api/materials/(\d+)/focus/dictation-result$", path)
    if m and method == "POST":
        mid = int(m.group(1))
        results = (_body_json(handler).get("results") or [])
        total_c = sum(r.get("correct", 0) for r in results)
        total_w = sum(r.get("total", 0) for r in results)
        wer = round(1 - (total_c / total_w if total_w else 0), 3)
        db.execute(
            """INSERT INTO focus_dictations(material_id, overall_wer, correct_words, total_words,
               sentence_count, detail_json) VALUES(?,?,?,?,?,?)""",
            (mid, wer, total_c, total_w, len(results),
             json.dumps(results, ensure_ascii=False)),
        )
        return _ok(handler, {"wer": wer, "correct": total_c, "total": total_w})

    # ---------- 精听 · 整段背诵对照 ----------
    m = re.match(r"^/api/materials/(\d+)/focus/recite$", path)
    if m and method == "POST":
        mid = int(m.group(1))
        text = (_body_json(handler).get("text") or "").strip()
        if not text:
            return _err(handler, "背诵内容为空")
        units = db.query("SELECT text FROM training_units WHERE material_id=? ORDER BY seq", (mid,))
        if not units:
            return _err(handler, "该材料没有训练单元")
        ref = " ".join(u["text"] for u in units)
        w = diffing.wer(ref, text)
        d = diffing.token_diff(ref, text)
        errors, _minors = diffing.diff_stats(d)
        total_words = len(textproc.tokens(ref))
        try:
            pass_wer = float(db.get_setting("recite_pass_wer", "0.25"))
        except ValueError:
            pass_wer = 0.25
        # 记录一次背诵（复用 focus_dictations 表，便于统计里看到）
        db.execute(
            """INSERT INTO focus_dictations(material_id, overall_wer, correct_words, total_words,
               sentence_count, detail_json) VALUES(?,?,?,?,?,?)""",
            (mid, round(w, 3), total_words - errors, total_words, len(units),
             json.dumps([{"text": u["text"]} for u in units], ensure_ascii=False)),
        )
        return _ok(handler, {
            "wer": round(w, 3), "passed": w <= pass_wer,
            "correct": total_words - errors, "total": total_words,
            "diff": d, "ref_sentences": [u["text"] for u in units],
        })

    # ---------- 打卡与统计 ----------
    if path == "/api/checkin" and method == "POST":
        db.execute("INSERT OR IGNORE INTO checkins(date) VALUES(date('now','localtime'))")
        rows = db.query("SELECT date FROM checkins")
        dates = {r["date"] for r in rows}
        streak = 0
        d = datetime.date.today()
        while d.isoformat() in dates:
            streak += 1
            d -= datetime.timedelta(days=1)
        return _ok(handler, {"checked": True, "streak": streak})

    if path == "/api/stats" and method == "GET":
        today = datetime.date.today().isoformat()
        def _cnt(sql):
            return db.query_one(sql, (today,))["c"]
        # 今日明细
        today_stats = {
            "dict": _cnt("SELECT COUNT(*) c FROM answers WHERE date(created_at,'localtime')=?"),
            "dict_units": db.query_one(
                """SELECT COUNT(DISTINCT u.id) c FROM answers a
                   JOIN learning_sessions s ON s.id=a.session_id
                   JOIN training_units u ON u.id=s.unit_id
                   WHERE date(a.created_at,'localtime')=?""", (today,))["c"],
            "speak": _cnt("SELECT COUNT(*) c FROM speaking_attempts WHERE date(created_at,'localtime')=?"),
            "recall": db.query_one(
                """SELECT COUNT(*) c FROM speaking_attempts
                   WHERE kind='active_recall' AND date(created_at,'localtime')=?""", (today,))["c"],
            "unit_review": _cnt("SELECT COUNT(*) c FROM review_history WHERE date(reviewed_at,'localtime')=?"),
            "focus": _cnt("SELECT COUNT(*) c FROM focus_dictations WHERE date(created_at,'localtime')=?"),
            "checked": bool(db.query_one("SELECT 1 FROM checkins WHERE date=?", (today,))),
        }
        # 打卡连续天数
        rows = db.query("SELECT date FROM checkins")
        dates = {r["date"] for r in rows}
        streak = 0
        d = datetime.date.today()
        while d.isoformat() in dates:
            streak += 1
            d -= datetime.timedelta(days=1)
        today_stats["streak"] = streak
        # 近 7 天（柱状图）与近 30 天（热力图）：按本地日期聚合
        def _daily(table, col):
            return {
                r["d"]: r["n"] for r in db.query(
                    f"SELECT date({col},'localtime') d, COUNT(*) n FROM {table} GROUP BY d")
            }
        d_dict = _daily("answers", "created_at")
        d_speak = _daily("speaking_attempts", "created_at")
        d_rev = _daily("review_history", "reviewed_at")
        d_focus = _daily("focus_dictations", "created_at")
        last7, heat = [], []
        for i in range(6, -1, -1):
            ds = (datetime.date.today() - datetime.timedelta(days=i)).isoformat()
            last7.append({"date": ds, "dict": d_dict.get(ds, 0), "speak": d_speak.get(ds, 0),
                          "review": d_rev.get(ds, 0), "focus": d_focus.get(ds, 0)})
        for i in range(29, -1, -1):
            ds = (datetime.date.today() - datetime.timedelta(days=i)).isoformat()
            heat.append({"date": ds, "count": d_dict.get(ds, 0) + d_speak.get(ds, 0)
                         + d_rev.get(ds, 0) + d_focus.get(ds, 0)})
        return _ok(handler, {"today": today_stats, "last7": last7, "heat": heat})

    m = re.match(r"^/api/materials/(\d+)/progress$", path)
    if m and method == "GET":
        mid = int(m.group(1))
        dicts = db.query(
            """SELECT id, overall_wer, correct_words, total_words, sentence_count, created_at
               FROM focus_dictations WHERE material_id=? ORDER BY id""", (mid,))
        revs = db.query(
            "SELECT result, interval_days, reviewed_at FROM focus_review_history WHERE material_id=? ORDER BY id",
            (mid,))
        return _ok(handler, {
            "dictations": [dict(r) for r in dicts],
            "reviews": [dict(r) for r in revs],
        })

    if path == "/api/materials/url" and method == "POST":
        body = _body_json(handler)
        url = (body.get("url") or "").strip()
        if not url:
            return _err(handler, "URL 为空")
        try:
            mid = pipeline.create_from_url(url)
        except Exception as e:
            return _err(handler, str(e))
        return _ok(handler, {"id": mid, "material": _material_json(mid)})

    m = re.match(r"^/api/materials/(\d+)$", path)
    if m and method == "GET":
        d = _material_json(int(m.group(1)))
        return _ok(handler, {"material": d}) if d else _err(handler, "材料不存在", 404)

    if m and method == "DELETE":
        mid = int(m.group(1))
        src = db.query_one("SELECT file_path FROM material_sources WHERE material_id=?", (mid,))
        if src and src["file_path"] and os.path.exists(src["file_path"]):
            try:
                os.remove(src["file_path"])
            except OSError:
                pass
        db.execute("DELETE FROM materials WHERE id=?", (mid,))
        return _ok(handler, {"ok": True})

    m = re.match(r"^/api/materials/(\d+)/podcast-episode$", path)
    if m and method == "POST":
        body = _body_json(handler)
        url = (body.get("url") or "").strip()
        if not url:
            return _err(handler, "请选择一集")
        pipeline.pick_podcast_episode(int(m.group(1)), url)
        return _ok(handler, {"ok": True, "message": "开始下载并转写该集"})

    m = re.match(r"^/api/materials/(\d+)/reprocess$", path)
    if m and method == "POST":
        # 处理失败/中断后的重新处理：有源音频走 ASR 管线；纯文本提示贴字幕
        mid = int(m.group(1))
        src = db.query_one(
            "SELECT file_path FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1", (mid,)
        )
        has_audio = bool(src and src["file_path"] and os.path.exists(src["file_path"]))
        if not has_audio:
            return _err(handler, "该素材没有音频文件，请直接在素材详情里粘贴字幕/文本导入")
        db.execute(
            "UPDATE materials SET status='processing', description='', process_step='', process_pct=0 WHERE id=?",
            (mid,),
        )
        db.execute("DELETE FROM training_units WHERE material_id=?", (mid,))
        db.execute("DELETE FROM transcripts WHERE material_id=?", (mid,))
        threading.Thread(target=pipeline._asr_and_build, args=(mid,), daemon=True).start()
        return _ok(handler, {"ok": True, "message": "已重新提交，正在转写"})

    # ---------- AI 生成材料 ----------
    if path == "/api/materials/generate" and method == "POST":
        body = _body_json(handler)
        # 「参考我的学习画像」：把聚合画像塞进生成 prompt，让对话更贴合薄弱环节
        if body.get("use_profile"):
            body["profile_summary"] = _learner_profile()["summary"]
        # 先建一条 processing 材料占位（LLM 失败时置 error），再后台生成
        mid = db.execute(
            """INSERT INTO materials(title, description, media_type, language, status)
               VALUES(?,?,?,?, 'processing')""",
            ("AI 生成中…", "AI 生成材料", "audio", "en"),
        )
        threading.Thread(target=_generate_worker, args=(mid, body), daemon=True).start()
        return _ok(handler, {"id": mid, "message": "AI 材料已开始生成，正在合成语音"})

    m = re.match(r"^/api/materials/(\d+)/transcript$", path)
    if m and method == "POST":
        body = _body_json(handler)
        text = (body.get("text") or "").strip()
        if not text:
            return _err(handler, "字幕文本为空")
        mid = int(m.group(1))
        db.execute(
            "INSERT INTO transcripts(material_id, format, source, content) VALUES(?,?,?,?)",
            (mid, pipeline.format_subtitle(text), "manual", text),
        )
        db.execute("UPDATE materials SET status='processing', description='' WHERE id=?", (mid,))
        threading.Thread(
            target=_attach_and_build, args=(mid, text, body.get("language", "en")), daemon=True
        ).start()
        return _ok(handler, {"ok": True, "message": "已提交，正在生成训练单元"})

    # ---------- 单元 ----------
    m = re.match(r"^/api/units/(\d+)$", path)
    if m and method == "GET":
        d = _unit_json(int(m.group(1)))
        return _ok(handler, {"unit": d}) if d else _err(handler, "单元不存在", 404)

    m = re.match(r"^/api/units/(\d+)/dictation$", path)
    if m and method == "POST":
        body = _body_json(handler)
        unit_id = int(m.group(1))
        u = db.query_one("SELECT * FROM training_units WHERE id=?", (unit_id,))
        if not u:
            return _err(handler, "单元不存在", 404)
        user_input = (body.get("input") or "").strip()
        session_id = int(body.get("session_id") or 0)
        assess_only = bool(body.get("assess_only"))
        if not user_input:
            return _err(handler, "请输入听写内容")
        # 显式折叠换行/多余空白（兼容粘贴或语音输入产生的逐词换行）
        user_input = " ".join(user_input.split())
        if not user_input:
            return _err(handler, "请输入听写内容")
        if not session_id:
            session_id = db.execute(
                "INSERT INTO learning_sessions(unit_id, type) VALUES(?,?)", (unit_id, "dictation")
            )
        threshold = float(db.get_setting("dictation_pass_wer", "0.12"))
        result = diffing.judge_dictation(u["text"], user_input, pass_wer=threshold)
        db.execute(
            """INSERT INTO answers(session_id, kind, user_input, reference, wer, cer, passed, detail_json)
               VALUES(?,?,?,?,?,?,?,?)""",
            (session_id or 0, "dictation", user_input, u["text"], result["wer"], result["cer"],
             int(result["passed"]), json.dumps({"verdict": result["verdict"]})),
        )
        status = u["status"]
        if assess_only:
            # 复习模式：只判定，不推进掌握度/状态（由 /review/complete 统一处理）
            return _ok(handler, {**result, "status": status})
        if session_id:
            db.execute("UPDATE learning_sessions SET finished_at=datetime('now') WHERE id=?", (session_id,))
        if result["passed"]:
            _update_unit_after_session(unit_id, "dictation", "pass", forced_status="REVEALED")
            status = "REVEALED"
        return _ok(handler, {**result, "status": status})

    m = re.match(r"^/api/units/(\d+)/listening$", path)
    if m and method == "POST":
        unit_id = int(m.group(1))
        body = _body_json(handler)
        session_id = int(body.get("session_id") or 0)
        if session_id:
            db.execute("UPDATE learning_sessions SET finished_at=datetime('now') WHERE id=?", (session_id,))
        _update_unit_after_session(unit_id, "blind_listening", "pass", forced_status="DICTATION")
        return _ok(handler, {"status": "DICTATION", "unit": _unit_json(unit_id)})

    m = re.match(r"^/api/units/(\d+)/reveal$", path)
    if m and method == "POST":
        unit_id = int(m.group(1))
        u = db.query_one("SELECT status FROM training_units WHERE id=?", (unit_id,))
        if u and u["status"] in ("DICTATION", "SHADOWING", "ACTIVE_RECALL", "LISTENING"):
            _transition(unit_id, "REVEALED")
        return _ok(handler, {"status": "REVEALED", "unit": _unit_json(unit_id)})

    m = re.match(r"^/api/units/(\d+)/ack$", path)
    if m and method == "POST":
        unit_id = int(m.group(1))
        u = db.query_one("SELECT status FROM training_units WHERE id=?", (unit_id,))
        if u and u["status"] == "REVEALED":
            _transition(unit_id, "UNDERSTOOD")
        return _ok(handler, {"status": "UNDERSTOOD", "unit": _unit_json(unit_id)})

    m = re.match(r"^/api/units/(\d+)/advance$", path)
    if m and method == "POST":
        unit_id = int(m.group(1))
        to = (body := _body_json(handler)).get("to", "")
        ok, status, err = _transition(unit_id, to)
        if not ok:
            return _err(handler, err or "状态迁移失败")
        return _ok(handler, {"status": status, "unit": _unit_json(unit_id)})

    m = re.match(r"^/api/units/(\d+)/speaking$", path)
    if m and method == "POST":
        return _handle_speaking(handler, int(m.group(1)), kind="shadowing")

    m = re.match(r"^/api/units/(\d+)/recall$", path)
    if m and method == "POST":
        return _handle_speaking(handler, int(m.group(1)), kind="active_recall")

    m = re.match(r"^/api/units/(\d+)/enhance$", path)
    if m and method == "POST":
        provider = _require_ai(handler)
        if provider is None:
            return
        try:
            changes = pipeline.enhance_unit_with_llm(int(m.group(1)))
        except Exception as e:
            return _err(handler, f"AI 增强失败: {e}", 502)
        return _ok(handler, {"changes": changes, "unit": _unit_json(int(m.group(1)))})

    m = re.match(r"^/api/units/(\d+)/recall-hint$", path)
    if m and method == "POST":
        # 主动回忆的中文回译提示：句子 → 中文，用户看中文回译成英文。缓存结果。
        provider = _require_ai(handler)
        if provider is None:
            return
        unit_id = int(m.group(1))
        u = db.query_one("SELECT * FROM training_units WHERE id=?", (unit_id,))
        if not u:
            return _err(handler, "单元不存在", 404)
        key = f"unit_hint_{unit_id}"
        cached = db.get_setting(key, "")
        if not cached:
            try:
                cached = ai_mod.llm_translate_sentence(provider, u["text"], _recall_scene_prompt(u))
                if not cached:
                    return _err(handler, "AI 未返回翻译，请重试")
                db.set_setting(key, cached)
            except Exception as e:
                return _err(handler, f"AI 调用失败: {e}", 502)
        return _ok(handler, {"translation_zh": cached})

    m = re.match(r"^/api/units/(\d+)/alternatives$", path)
    if m and method == "POST":
        provider = _require_ai(handler)
        if provider is None:
            return
        u = db.query_one("SELECT text FROM training_units WHERE id=?", (int(m.group(1)),))
        try:
            data = ai_mod.llm_alternatives(provider, u["text"])
        except Exception as e:
            return _err(handler, f"AI 调用失败: {e}", 502)
        return _ok(handler, {"alternatives": data.get("alternatives", [])})

    m = re.match(r"^/api/units/(\d+)$", path)
    if m and method == "PUT":
        body = _body_json(handler)
        unit_id = int(m.group(1))
        if "scene" in body:
            scene = body["scene"]
            if scene in (r["name"] for r in db.query("SELECT name FROM scenes")):
                db.execute("UPDATE training_units SET scene=? WHERE id=?", (scene, unit_id))
        if "flagged" in body:
            db.execute("UPDATE training_units SET is_flagged=? WHERE id=?", (int(body["flagged"]), unit_id))
        if "text" in body:
            # 用户纠错：ASR 转录可能有误，允许用户修正句子文本（听写/对照/复习都以它为准）
            t = (body["text"] or "").strip()
            if not t:
                return _err(handler, "句子文本不能为空")
            if len(t) > 2000:
                return _err(handler, "句子文本过长")
            db.execute("UPDATE training_units SET text=? WHERE id=?", (t, unit_id))
        return _ok(handler, {"unit": _unit_json(unit_id)})

    # ---------- 会话 ----------
    m = re.match(r"^/api/units/(\d+)/session$", path)
    if m and method == "POST":
        body = _body_json(handler)
        sid = db.execute(
            "INSERT INTO learning_sessions(unit_id, type) VALUES(?,?)",
            (int(m.group(1)), body.get("type", "generic")),
        )
        return _ok(handler, {"session_id": sid})

    # ---------- 复习 ----------
    if path == "/api/review/due" and method == "GET":
        due = review.due_units()
        out = []
        for u in due:
            m_ = review.get_mastery(u["id"])
            out.append({
                "id": u["id"], "text": u["text"], "material_id": u["material_id"],
                "seq": u["seq"], "scene": u["scene"], "status": u["status"],
                "mastery": m_,
            })
        return _ok(handler, {"due": out})

    m = re.match(r"^/api/review/(\d+)/complete$", path)
    if m and method == "POST":
        unit_id = int(m.group(1))
        body = _body_json(handler)
        skills = body.get("skills") or {}
        if not skills:
            return _err(handler, "缺少 skills（每项技能的结果）")
        session_id = int(body.get("session_id") or 0)
        if session_id:
            db.execute(
                "UPDATE learning_sessions SET finished_at=datetime('now'), result_json=? WHERE id=?",
                (json.dumps({"skills": skills}), session_id),
            )
        review.apply_review(unit_id, skills)
        m_ = review.get_mastery(unit_id)
        if review.is_mastered(m_):
            status = "MASTERED"
        elif any(r == "fail" for r in skills.values()):
            status = "ACTIVE_RECALL"
        else:
            status = "REVIEW_DUE"
        db.execute("UPDATE training_units SET status=? WHERE id=?", (status, unit_id))
        return _ok(handler, {"status": status, "mastery": m_, "unit": _unit_json(unit_id)})

    # ---------- 场景 ----------
    if path == "/api/scenes" and method == "GET":
        return _ok(handler, {"scenes": extract.scenes_list()})

    # ---------- 设置 ----------
    if path == "/api/settings" and method == "GET":
        rows = db.query("SELECT key, value FROM app_settings")
        return _ok(handler, {"settings": {r["key"]: r["value"] for r in rows}})

    if path == "/api/settings" and method == "PUT":
        body = _body_json(handler)
        for k, v in body.items():
            db.set_setting(k, v)
        return _ok(handler, {"ok": True})

    # ---------- AI Providers ----------
    if path == "/api/ai/providers" and method == "GET":
        rows = db.query("SELECT id, name, provider_type, base_url, model, enabled, created_at FROM ai_providers")
        provs = []
        for r in rows:
            p = dict(r)
            p["has_key"] = bool(ai_mod.load_api_key(p["id"]))
            p["available"] = ai_mod.provider_ok(p)
            provs.append(p)
        return _ok(handler, {
            "providers": provs, "presets": ai_mod.PROVIDER_PRESETS,
            "platforms": ai_mod.PLATFORM_PRESETS,
        })

    if path == "/api/ai/providers" and method == "POST":
        body = _body_json(handler)
        name = (body.get("name") or "").strip()
        ptype = (body.get("provider_type") or "openai_compatible").strip()
        if not name:
            return _err(handler, "请填写名称")
        if ptype not in ai_mod.PROVIDER_PRESETS and ptype != "openai_compatible":
            return _err(handler, "不支持的 Provider 类型")
        pid = db.execute(
            """INSERT INTO ai_providers(name, provider_type, base_url, model, enabled)
               VALUES(?,?,?,?,?)""",
            (name, ptype, (body.get("base_url") or "").strip(), (body.get("model") or "").strip(),
             int(body.get("enabled", 0))),
        )
        key = (body.get("api_key") or "").strip()
        if key:
            ai_mod.store_api_key(pid, key)
        return _ok(handler, {"id": pid})

    m = re.match(r"^/api/ai/providers/(\d+)$", path)
    if m and method == "PUT":
        pid = int(m.group(1))
        body = _body_json(handler)
        sets = []
        args = []
        for k in ("name", "provider_type", "base_url", "model", "enabled"):
            if k in body:
                sets.append(f"{k}=?")
                args.append(body[k])
        if sets:
            args.append(pid)
            db.execute(f"UPDATE ai_providers SET {','.join(sets)} WHERE id=?", args)
        if "api_key" in body and body["api_key"]:
            ai_mod.store_api_key(pid, body["api_key"])
        return _ok(handler, {"ok": True})

    if m and method == "DELETE":
        pid = int(m.group(1))
        ai_mod.delete_api_key(pid)
        db.execute("DELETE FROM ai_providers WHERE id=?", (pid,))
        return _ok(handler, {"ok": True})

    if path == "/api/ai/test" and method == "POST":
        body = _body_json(handler)
        provider = ai_mod.get_provider(body.get("provider_id"))
        if not provider:
            return _err(handler, "Provider 不存在", 404)
        try:
            reply = ai_mod.test_provider(provider)
        except Exception as e:
            return _err(handler, f"连接失败: {e}", 502)
        return _ok(handler, {"reply": reply})

    if path == "/api/ai/consent" and method == "POST":
        body = _body_json(handler)
        action = body.get("action", "grant")
        if action == "grant":
            db.set_setting("ai_consent_granted_at", str(time.time()))
            return _ok(handler, {"ok": True})
        if action in ("allow", "ask", "never"):
            db.set_setting("ai_consent", action)
            if action != "never":
                db.set_setting("ai_consent_granted_at", str(time.time()))
            return _ok(handler, {"ok": True})
        return _err(handler, "未知操作")

    if path == "/api/ai/privacy" and method == "GET":
        return _ok(handler, {
            "consent": db.get_setting("ai_consent", "ask"),
            "scope": db.get_setting("ai_scope", "sentence"),
            "granted": db.get_setting("ai_consent_granted_at", ""),
        })

    # ---------- 学习画像 & AI 分析 ----------
    if path == "/api/learner/profile" and method == "GET":
        return _ok(handler, _learner_profile())

    if path == "/api/ai/analysis" and method == "POST":
        provider = _require_ai(handler)
        if provider is None:
            return
        body = _body_json(handler)
        prof = _learner_profile()
        payload = prof["summary"] + "\n\n（结构化画像：\n" + json.dumps(prof["profile"], ensure_ascii=False) + "）"
        try:
            reply = ai_mod.llm_analyze_learner(provider, payload, (body.get("prompt") or "").strip())
        except Exception as e:
            return _err(handler, f"AI 调用失败: {e}", 502)
        if not reply:
            return _err(handler, "AI 未返回内容，请重试")
        return _ok(handler, {"reply": reply})

    # ---------- 语音 ----------
    if path == "/api/speech/transcribe" and method == "POST":
        body = _body_json(handler)
        audio_b64 = body.get("audio_b64", "")
        if not audio_b64:
            return _err(handler, "缺少音频数据")
        try:
            raw = base64.b64decode(audio_b64)
        except Exception:
            return _err(handler, "音频编码错误")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tf.write(raw)
            tmp = tf.name
        try:
            if not asr_mod.available():
                return _err(handler, "本地 ASR 未安装。请运行 run.sh 安装 faster-whisper，或在跟读时使用打字核验。")
            model = db.get_setting("asr_model", "base.en")
            res = asr_mod.transcribe(tmp, model_name=model)
            return _ok(handler, {"text": res["text"].strip(), "model": res["model"], "seconds": res["seconds"]})
        except Exception as e:
            return _err(handler, f"转写失败: {e}", 502)
        finally:
            os.unlink(tmp)

    return None


def _handle_speaking(handler, unit_id, kind):
    """跟读 / 主动回忆 判定（含可选 LLM 语义评估）。"""
    body = _body_json(handler)
    u = db.query_one("SELECT * FROM training_units WHERE id=?", (unit_id,))
    if not u:
        return _err(handler, "单元不存在", 404)
    session_id = int(body.get("session_id") or 0)
    user_text = (body.get("text") or "").strip()
    if not user_text:
        return _err(handler, "没有内容（录音未识别或未输入）")
    if not session_id:
        session_id = db.execute(
            "INSERT INTO learning_sessions(unit_id, type) VALUES(?,?)", (unit_id, kind)
        )

    exprs = db.query("SELECT expression, variants_json FROM expressions WHERE unit_id=?", (unit_id,))
    variants = []
    for e in exprs:
        variants.extend(json.loads(e["variants_json"] or "[]"))

    if kind == "shadowing":
        pass_score = float(db.get_setting("speaking_pass_score", "60"))
        result = diffing.judge_speaking(u["text"], user_text, pass_score=pass_score)
        session_type = "shadowing"
        trained = ["speaking"]
    else:
        pass_score = float(db.get_setting("recall_pass_score", "60"))
        result = diffing.judge_recall(u["text"], variants, [], user_text, pass_score=pass_score)
        session_type = "active_recall"
        trained = ["recall"]

    evaluation = {}
    provider = ai_mod.enabled_provider()
    consent_ok = _consent_granted()
    if provider and consent_ok:
        try:
            scene_prompt = _recall_scene_prompt(u)
            ev = ai_mod.llm_evaluate_speaking(provider, kind, u["text"], user_text, scene_prompt)
            if ev:
                evaluation = ev
                if ev.get("meaning_ok") is True:
                    result["score"] = max(result["score"], 80)
                    result["passed"] = True
                elif ev.get("meaning_ok") is False:
                    result["passed"] = False
                    result["score"] = min(result["score"], 40)
        except Exception:
            pass  # LLM 失败不影响本地判定

    db.execute(
        """INSERT INTO speaking_attempts(session_id, kind, asr_text, reference, match_score, evaluation_json, passed)
           VALUES(?,?,?,?,?,?,?)""",
        (session_id or 0, kind, user_text, u["text"], result.get("score", 0),
         json.dumps({**evaluation, "variants": variants}, ensure_ascii=False), int(result.get("passed", 0))),
    )

    if body.get("assess_only"):
        # 复习模式：只判定（由 /review/complete 统一更新掌握度与状态）
        return _ok(handler, {
            "asr_text": user_text,
            "match": {k: result[k] for k in ("score", "exact", "fuzzy_ratio", "keyword_coverage", "verdict") if k in result},
            "evaluation": evaluation,
            "passed": result["passed"],
            "verdict": result["verdict"],
            "status": u["status"],
        })

    if session_id:
        db.execute("UPDATE learning_sessions SET finished_at=datetime('now') WHERE id=?", (session_id,))

    # 状态推进
    if kind == "shadowing":
        if result["passed"]:
            _update_unit_after_session(unit_id, "shadowing", "pass", forced_status="ACTIVE_RECALL")
            status = "ACTIVE_RECALL"
        else:
            _update_unit_after_session(unit_id, "shadowing", "fail")
            status = "SHADOWING"
    else:
        if result["passed"]:
            _update_unit_after_session(unit_id, "active_recall", "pass", forced_status="REVIEW_DUE")
            status = "REVIEW_DUE"
        else:
            # 回忆失败：留在主动回忆（可重试/看原文/跳过），不回退跟读——避免"看原文→跟读→回忆"死循环
            _update_unit_after_session(unit_id, "active_recall", "fail", forced_status="ACTIVE_RECALL")
            status = "ACTIVE_RECALL"

    return _ok(handler, {
        "asr_text": user_text,
        "match": {k: result[k] for k in ("score", "exact", "fuzzy_ratio", "keyword_coverage", "verdict") if k in result},
        "evaluation": evaluation,
        "passed": result["passed"],
        "verdict": result["verdict"],
        "status": status,
        "unit": _unit_json(unit_id),
    })


def _consent_granted():
    consent = db.get_setting("ai_consent", "ask")
    if consent == "allow":
        return True
    try:
        granted = float(db.get_setting("ai_consent_granted_at", "0"))
        return time.time() - granted < 7 * 86400
    except ValueError:
        return False


def _recall_scene_prompt(u):
    mat = db.query_one("SELECT title, scene FROM materials WHERE id=?", (u["material_id"],))
    if mat:
        return f"{mat['title']} | scene: {mat['scene'] or u['scene']}"
    return f"scene: {u['scene']}"


def _generate_worker(mid, params):
    """AI 生成材料后台任务：LLM 生成对话 → TTS 合成 → 建单元。失败时占位材料置 error。"""
    try:
        generate.generate_material(params, mid=mid)
    except Exception as e:
        db.execute("UPDATE materials SET status='error', description=? WHERE id=?", (f"生成失败：{e}", mid))
        db.execute("UPDATE materials SET process_step='error', process_pct=0 WHERE id=?", (mid,))


def _attach_and_build(mid, text, language="en"):
    """给已有素材补字幕/文本后重新建单元。"""
    try:
        pipeline._set_progress(mid, "preparing", 10)
        fmt = pipeline.format_subtitle(text)
        segs = pipeline.parse_subtitle(text, fmt)
        # 已有音频时尝试 ASR 对齐时间戳
        src = db.query_one(
            "SELECT file_path FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1", (mid,)
        )
        if src and src["file_path"] and os.path.exists(src["file_path"]) and asr_mod.available():
            try:
                model = db.get_setting("asr_model", "base.en")
                pipeline._set_progress(mid, "transcribing", 30)
                res = asr_mod.transcribe(src["file_path"], model_name=model)
                segs = pipeline.align_sentences_to_segments(
                    [s["text"] for s in segs], res["segments"]
                )
            except Exception:
                pass
        pipeline._set_progress(mid, "building", 70)
        pipeline._build_units_from_segments(mid, segs, "manual")
        _set_material_audio_duration(mid)
        pipeline._set_progress(mid, "done", 100)
    except Exception as e:
        db.execute("UPDATE materials SET status='error', description=? WHERE id=?",
                   (f"处理失败：{e}", mid))
        db.execute("UPDATE materials SET process_step='error', process_pct=0 WHERE id=?", (mid,))


def _set_material_audio_duration(mid):
    from .pipeline import _material_audio_path
    path = _material_audio_path(mid)
    if not path:
        return
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
            capture_output=True, text=True, timeout=30,
        )
        d = json.loads(r.stdout).get("format", {}).get("duration")
        if d:
            db.execute("UPDATE materials SET duration_ms=? WHERE id=?", (int(float(d) * 1000), mid))
    except Exception:
        pass


# ---------- 音频 / 静态文件 ----------

def _serve_file(handler, path, download_name=None, allow_range=True):
    if not path or not os.path.isfile(path):
        return False
    size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()
    ctype = AUDIO_MIME.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
    range_header = handler.headers.get("Range")
    start, end = 0, size - 1
    status = 200
    if allow_range and range_header:
        m = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if m:
            if m.group(1):
                start = int(m.group(1))
            if m.group(2):
                end = min(int(m.group(2)), size - 1)
            if start >= size:
                handler.send_response(416)
                handler.send_header("Content-Range", f"bytes */{size}")
                handler.end_headers()
                return True
            status = 206
    length = end - start + 1
    handler.send_response(status)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(length))
    handler.send_header("Accept-Ranges", "bytes")
    # 应用壳资源每次校验（dev 迭代频繁；PWA 侧由 service worker 缓存，不受影响）
    if ext in (".html", ".js", ".css", ".json"):
        handler.send_header("Cache-Control", "no-cache")
    if status == 206:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    if download_name:
        handler.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
    handler.end_headers()
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)
    return True


def _serve_static(handler):
    rel = handler.path_params.get("path", "index.html")
    # 防目录穿越
    full = os.path.normpath(os.path.join(FRONTEND_DIR, rel))
    if not full.startswith(os.path.normpath(FRONTEND_DIR)):
        return False
    if os.path.isdir(full):
        full = os.path.join(full, "index.html")
    if _serve_file(handler, full, allow_range=False):
        return True
    handler.send_response(404)
    handler.send_header("Content-Type", "text/plain")
    handler.end_headers()
    handler.wfile.write(b"not found")
    return True


def _parse_multipart(handler):
    """解析 multipart/form-data，返回 {field_name: (filename, bytes)}"""
    ctype = handler.headers.get("Content-Type", "")
    m = re.match(r"multipart/form-data; boundary=(.+)", ctype)
    if not m:
        raise ValueError("不是 multipart 上传")
    boundary = m.group(1).strip().strip('"')
    length = int(handler.headers.get("Content-Length", 0) or 0)
    body = handler.rfile.read(length)
    msg = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + ctype.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        out[name] = (filename or name, payload)
    return out


def sys_platform_is_mac():
    import sys
    return sys.platform == "darwin"


# ---------- HTTP Handler ----------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DeepSpeak/" + VERSION

    def log_message(self, fmt, *args):
        # 精简日志
        if self.command != "GET" or "/assets/" not in self.path:
            print(f"[{self.log_date_time_string()}] {self.command} {self.path} {args[0] if args else ''}")

    def _route(self):
        parsed = urllib.parse.urlparse(self.path)
        self.route = parsed.path
        self.query = urllib.parse.parse_qs(parsed.query)
        if self.route.startswith("/assets/"):
            self.path_params = {"path": self.route[len("/assets/"):]}
            return "static"
        if self.route == "/":
            self.path_params = {}
            return "index"
        if self.route.startswith("/api/"):
            self.path_params = {}
            return "api"
        # 其他路径按静态文件处理（不存在则 404）
        self.path_params = {"path": self.route.lstrip("/")}
        return "static"

    def do_GET(self):
        kind = self._route()
        try:
            if kind == "index":
                self.send_response(302)
                self.send_header("Location", "/assets/index.html")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if kind == "static":
                return _serve_static(self)
            return self._api()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                return _err(self, f"服务器错误: {e}", 500)
            except Exception:
                pass

    def do_POST(self):
        self._route()
        try:
            if self.route == "/api/audio/probe":
                return _ok(self, {"note": "ok"})
            result = api_router(self)
            if result is not None:
                return
            return _err(self, "接口不存在", 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                return _err(self, f"服务器错误: {e}", 500)
            except Exception:
                pass

    def do_PUT(self):
        self.do_POST()

    def do_PATCH(self):
        self.do_POST()

    def do_DELETE(self):
        self._route()
        try:
            result = api_router(self)
            if result is not None:
                return
            return _err(self, "接口不存在", 404)
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                return _err(self, f"服务器错误: {e}", 500)
            except Exception:
                pass

    def _api(self):
        # 音频/TTS 优先（流式响应不走 JSON）
        m = re.match(r"^/api/audio/material/(\d+)/full\.wav$", self.route)
        if m:
            path = focus.material_full_audio_path(int(m.group(1)))
            if not path:
                return _err(self, "该材料暂无整段音频（需先导入文本或音频）", 404)
            return _serve_file(self, path)
        m = re.match(r"^/api/audio/material/(\d+)$", self.route)
        if m:
            mid = int(m.group(1))
            src = db.query_one(
                "SELECT file_path FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1", (mid,)
            )
            if not src or not src["file_path"] or not os.path.exists(src["file_path"]):
                return _err(self, "该材料没有音频")
            return _serve_file(self, src["file_path"])
        m = re.match(r"^/api/audio/unit/(\d+)\.wav$", self.route)
        if m:
            path = builtin.unit_audio_path(int(m.group(1)))
            if not path:
                return _err(self, "无法生成该单元的音频", 404)
            return _serve_file(self, path)
        if self.route == "/api/tts":
            text = self.query.get("text", [""])[0][:200]
            voice = self.query.get("voice", ["Samantha"])[0]
            try:
                rate = int(self.query.get("rate", ["175"])[0])
            except ValueError:
                rate = 175
            path = tts.synthesize(text, voice=voice, rate=rate)
            if not path:
                return _err(self, "TTS 不可用", 404)
            return _serve_file(self, path)
        if self.route == "/api/tts/voices":
            return _ok(self, {"voices": tts.list_voices()})
        result = api_router(self)
        if result is not None:
            return result
        return _err(self, "接口不存在", 404)


def start(port=8531, open_browser=True):
    paths.ensure_dirs()
    paths.seed_models()
    paths.migrate_legacy_data()
    db.init_db()
    builtin.seed_builtin_materials()

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 60)
    print("  DeepSpeak — English Deep Learning App (本地优先 MVP)")
    print(f"  访问: http://127.0.0.1:{port}")
    print(f"  ASR(本地语音识别): {'可用' if asr_mod.available() else '未安装 (运行 run.sh 自动安装)'}")
    print(f"  TTS(内置材料音频): {'可用 (' + tts.platform() + ')' if tts.available() else '不可用，前端降级浏览器合成'}")
    print("  Ctrl+C 退出")
    print("=" * 60)
    if open_browser:
        try:
            import webbrowser
            webbrowser.open(f"http://127.0.0.1:{port}")
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n再见 👋")
    finally:
        server.server_close()


def main():
    ap = argparse.ArgumentParser(description="DeepSpeak local server")
    ap.add_argument("--port", type=int, default=8531)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    start(port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    if __package__ is None:
        # 支持 `python3 backend/server.py` 直接运行（转为模块方式执行）
        import runpy
        import sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        runpy.run_module("backend.server", run_name="__main__")
    else:
        main()
