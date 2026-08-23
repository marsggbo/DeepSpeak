"""复习调度器：掌握度计算、间隔重复、到期队列、薄弱场景。

本地规则实现（SM-2 变体）。无 LLM 依赖。
"""
import json
import math
from datetime import datetime, timedelta

from . import db

# 训练类型 → 影响的技能维度
TYPE_SKILL = {
    "blind_listening": "listening",
    "review_listening": "listening",
    "dictation": "dictation",
    "review_dictation": "dictation",
    "shadowing": "speaking",
    "review_speaking": "speaking",
    "active_recall": "recall",
    "review_recall": "recall",
}

INTERVALS = [1, 2, 4, 7, 14, 30, 60]  # 天

SKILL_WEIGHTS = {"listening": 0.15, "dictation": 0.25, "recall": 0.35, "speaking": 0.25}

MASTER_MIN_OVERALL = 0.80
MASTER_MIN_SKILL = 0.70
MASTER_MIN_REVIEWS = 2


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _parse_dt(s):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def get_mastery(unit_id):
    row = db.query_one("SELECT * FROM mastery_states WHERE unit_id=?", (unit_id,))
    if row is None:
        return {
            "listening": 0.0, "dictation": 0.0, "recall": 0.0, "speaking": 0.0,
            "overall": 0.0, "interval_days": 1.0, "stage": 0, "next_review_at": None,
            "reviews_done": 0,
        }
    return dict(row)


def ensure_mastery(unit_id):
    if db.query_one("SELECT id FROM mastery_states WHERE unit_id=?", (unit_id,)) is None:
        db.execute(
            "INSERT INTO mastery_states(unit_id) VALUES(?)", (unit_id,)
        )
    return get_mastery(unit_id)


def overall_from(skills):
    overall = sum(SKILL_WEIGHTS[k] * skills[k] for k in SKILL_WEIGHTS)
    # 主动回忆弱 → 即使听写/听力高也不能判定掌握
    if skills["recall"] < 0.6:
        overall = min(overall, skills["recall"] + 0.25)
    return round(overall, 3)


def _apply_skill(scores, skill, result):
    cur = scores.get(skill, 0.0)
    if result == "pass":
        if cur < 0.7:
            scores[skill] = 0.7
        elif cur < 0.95:
            scores[skill] = min(0.95, cur + 0.12)
    elif result == "partial":
        scores[skill] = max(0.45, cur * 0.8)
    else:  # fail
        scores[skill] = min(cur, 0.3) if cur <= 0.3 else round(cur * 0.45, 3)


def record_session_result(unit_id, session_type, result, trained_skills=None, detail=None):
    """记录一次训练/复习结果并更新掌握度。

    result: pass | partial | fail
    """
    m = ensure_mastery(unit_id)
    skill = TYPE_SKILL.get(session_type)
    if trained_skills and not skill:
        skills = list(trained_skills)
    elif skill:
        skills = [skill]
    else:
        skills = []

    scores = dict(m)
    for s in skills:
        _apply_skill(scores, s, result)

    overall = overall_from(scores)
    # 复习间隔推进：只有“复习会话”推进 stage/reviews_done；
    # 首次训练（听写/跟读/主动回忆）只积累技能分，间隔从 1 天开始（PRD：延迟复习）。
    stage = m["stage"]
    reviews_done = m["reviews_done"]
    if session_type.startswith("review"):
        if result == "pass":
            stage = min(stage + 1, len(INTERVALS) - 1)
            reviews_done += 1
        elif result == "fail":
            stage = max(0, stage - 2)
            reviews_done = max(0, reviews_done - 1)
        elif result == "partial":
            stage = max(0, stage - 1)

    interval = INTERVALS[min(stage, len(INTERVALS) - 1)]
    next_review = (datetime.now() + timedelta(days=interval)).strftime("%Y-%m-%d %H:%M:%S")

    db.execute(
        """UPDATE mastery_states SET listening=?, dictation=?, recall=?, speaking=?,
           overall=?, interval_days=?, stage=?, reviews_done=?, next_review_at=?, updated_at=?
           WHERE unit_id=?""",
        (scores["listening"], scores["dictation"], scores["recall"], scores["speaking"],
         overall, interval, stage, reviews_done, next_review, _now(), unit_id),
    )
    db.execute(
        "INSERT INTO review_history(unit_id, review_type, result, interval_days) VALUES(?,?,?,?)",
        (unit_id, session_type, result, interval),
    )
    return get_mastery(unit_id)


def apply_review(unit_id, skills):
    """复习完成：skills = {skill: pass|partial|fail}，只推进一次复习计数。

    返回 (mastery, overall_result)。"""
    m = ensure_mastery(unit_id)
    scores = dict(m)
    passed = any(r == "pass" for r in skills.values())
    failed = any(r == "fail" for r in skills.values())
    for s, result in skills.items():
        if s in SKILL_WEIGHTS:
            _apply_skill(scores, s, result)

    overall = overall_from(scores)
    if failed and not passed:
        overall = min(overall, 0.5)
    elif failed:
        overall = min(overall, 0.7)

    stage = m["stage"]
    reviews_done = m["reviews_done"]
    if passed and not failed:
        stage = min(stage + 1, len(INTERVALS) - 1)
        reviews_done += 1
    elif failed and passed:
        stage = max(0, stage - 1)
    elif failed:
        stage = max(0, stage - 2)
        reviews_done = max(0, reviews_done - 1)

    interval = INTERVALS[min(stage, len(INTERVALS) - 1)]
    next_review = (datetime.now() + timedelta(days=interval)).strftime("%Y-%m-%d %H:%M:%S")

    db.execute(
        """UPDATE mastery_states SET listening=?, dictation=?, recall=?, speaking=?,
           overall=?, interval_days=?, stage=?, reviews_done=?, next_review_at=?, updated_at=?
           WHERE unit_id=?""",
        (scores["listening"], scores["dictation"], scores["recall"], scores["speaking"],
         overall, interval, stage, reviews_done, next_review, _now(), unit_id),
    )
    db.execute(
        "INSERT INTO review_history(unit_id, review_type, result, interval_days) VALUES(?,?,?,?)",
        (unit_id, "review", "pass" if passed and not failed else ("fail" if failed and not passed else "partial"),
         interval),
    )
    return get_mastery(unit_id), ("pass" if passed and not failed else ("fail" if failed and not passed else "partial"))


def is_mastered(m):
    return (
        m["overall"] >= MASTER_MIN_OVERALL
        and all(m[k] >= MASTER_MIN_SKILL for k in ("listening", "dictation", "recall", "speaking"))
        and m["reviews_done"] >= MASTER_MIN_REVIEWS
    )


def unit_status_after_session(unit_id, session_type, result):
    """训练状态机推进。返回 (new_status, regressed)。"""
    from . import db as d
    row = d.query_one("SELECT status FROM training_units WHERE id=?", (unit_id,))
    status = row["status"] if row else "NEW"
    regressed = False
    if result == "fail" and session_type in ("review_dictation", "review_recall", "review_speaking"):
        status, regressed = "ACTIVE_RECALL", True
    elif result == "fail" and session_type == "shadowing":
        status = "SHADOWING"
    elif result == "fail" and session_type == "active_recall":
        status, regressed = "SHADOWING", True
    elif result == "fail" and session_type == "dictation":
        status = "DICTATION"
    return status, regressed


def due_units(limit=50, unit_ids=None):
    """到期复习队列：next_review_at <= now 且状态处于学习中的单元。"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sql = """
        SELECT u.*, m.overall, m.next_review_at, m.recall, m.speaking, m.dictation, m.listening
        FROM training_units u JOIN mastery_states m ON m.unit_id = u.id
        WHERE u.status IN ('REVIEW_DUE','MASTERED','UNDERSTOOD','ACTIVE_RECALL','SHADOWING','DICTATION','REVEALED')
          AND m.next_review_at IS NOT NULL AND m.next_review_at <= ?
    """
    args = [now]
    if unit_ids:
        sql += f" AND u.id IN ({','.join('?' * len(unit_ids))})"
        args += list(unit_ids)
    sql += " ORDER BY m.next_review_at ASC, u.id LIMIT ?"
    args.append(limit)
    return [dict(r) for r in db.query(sql, args)]


def today_counts():
    """首页统计：到期复习 / 新单元 / 口语待练。"""
    conn = db.connect()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    review_due = conn.execute(
        """SELECT COUNT(*) c FROM training_units u JOIN mastery_states m ON m.unit_id=u.id
           WHERE m.next_review_at IS NOT NULL AND m.next_review_at <= ?
             AND u.status IN ('REVIEW_DUE','MASTERED','UNDERSTOOD','ACTIVE_RECALL','SHADOWING','REVEALED','DICTATION')""",
        (now,),
    ).fetchone()["c"]

    new_count = conn.execute(
        "SELECT COUNT(*) c FROM training_units WHERE status='NEW'"
    ).fetchone()["c"]

    speaking_due = conn.execute(
        """SELECT COUNT(*) c FROM training_units u JOIN mastery_states m ON m.unit_id=u.id
           WHERE m.next_review_at IS NOT NULL AND m.next_review_at <= ? AND m.recall < 0.7
             AND u.status IN ('REVIEW_DUE','MASTERED','UNDERSTOOD','ACTIVE_RECALL','SHADOWING','REVEALED','DICTATION')""",
        (now,),
    ).fetchone()["c"]

    return {"review_due": review_due, "new_count": new_count, "speaking_due": speaking_due}


def weak_scenes(limit=3):
    """薄弱场景：按场景聚合平均掌握度，取最低的。"""
    rows = db.query(
        """SELECT u.scene, AVG(m.overall) avg_o, COUNT(*) n, MIN(m.overall) min_o
           FROM training_units u JOIN mastery_states m ON m.unit_id=u.id
           WHERE u.scene != '' AND u.scene != 'other' AND u.status != 'NEW'
           GROUP BY u.scene HAVING COUNT(*) >= 2
           ORDER BY avg_o ASC LIMIT ?""",
        (limit,),
    )
    from .extract import scene_label
    out = []
    for r in rows:
        label, emoji = scene_label(r["scene"])
        out.append({
            "scene": r["scene"], "label": label, "emoji": emoji,
            "avg_mastery": round(r["avg_o"], 2), "count": r["n"],
        })
    return out


def continue_unit():
    """首页「继续训练」：优先未完成材料中的下一个新单元，其次最早到期单元。"""
    row = db.query_one(
        """SELECT u.* FROM training_units u
           WHERE u.status='NEW' ORDER BY u.material_id, u.seq LIMIT 1"""
    )
    if row:
        return dict(row)
    due = due_units(limit=1)
    if due:
        return due[0]
    row = db.query_one(
        """SELECT u.* FROM training_units u
           WHERE u.status NOT IN ('NEW','MASTERED') ORDER BY u.id LIMIT 1"""
    )
    return dict(row) if row else None


def unit_progress(unit_id):
    """单个单元的学习进度视图（供前端）。"""
    u = db.query_one("SELECT * FROM training_units WHERE id=?", (unit_id,))
    if not u:
        return None
    d = dict(u)
    d["mastery"] = get_mastery(unit_id)
    d["expressions"] = [
        {"expression": e["expression"], "meaning": e["meaning"], "intent": e["intent"],
         "label": e["meaning"], "variants": json.loads(e["variants_json"] or "[]"),
         "source": e["source"]}
        for e in db.query("SELECT * FROM expressions WHERE unit_id=?", (unit_id,))
    ]
    d["session_counts"] = {
        r["type"]: r["c"] for r in db.query(
            "SELECT type, COUNT(*) c FROM learning_sessions WHERE unit_id=? GROUP BY type", (unit_id,))
    }
    return d
