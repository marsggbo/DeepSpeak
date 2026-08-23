"""规则引擎：表达提取、场景分类、难度估计、学习价值评分。

无 LLM 也能完整工作；LLM 是可选增强层（见 ai.py）。
"""
import json
import os
import re

from . import db, paths

DATA_DIR = paths.backend_data_dir()

_pat_cache = None
_common_words_cache = None

# 日常生活优先场景：这些场景的句子学习价值更高
DAILY_SCENES = {
    "restaurant", "doctor", "pharmacy", "shopping", "groceries", "small_talk",
    "phone", "directions", "cooking", "haircut", "hotel", "travel", "home",
}


def _patterns():
    global _pat_cache
    if _pat_cache is None:
        with open(os.path.join(DATA_DIR, "expressions.json"), encoding="utf-8") as f:
            raw = json.load(f)["patterns"]
        _pat_cache = [(re.compile(p["re"], re.I), p) for p in raw]
    return _pat_cache


def _common_words():
    global _common_words_cache
    if _common_words_cache is None:
        with open(os.path.join(DATA_DIR, "common_words.txt"), encoding="utf-8") as f:
            _common_words_cache = {w.strip() for w in f if w.strip() and not w.startswith("#")}
    return _common_words_cache


def extract_expressions(sentence, scene=""):
    """从句子中提取表达（规则版）。返回 [{"expression","intent","label","variants","scene"}]"""
    results = []
    low = sentence.lower()
    for rx, p in _patterns():
        if rx.search(low):
            results.append({
                "expression": sentence,
                "intent": p["intent"],
                "label": p.get("label", ""),
                "variants": p.get("variants", []),
                "scene": p.get("scene", scene),
            })
    # 去重（同一句子多个 pattern 时保留第一个 + 合并）
    seen = set()
    dedup = []
    for r in results:
        key = (r["intent"], r["scene"])
        if key in seen:
            continue
        seen.add(key)
        dedup.append(r)
    return dedup


def classify_scene(text):
    """基于关键词的场景分类。返回 (scene_name, confidence, matched_keywords)"""
    words = re.findall(r"[a-z']+", text.lower())
    best, best_score, best_kws = "other", 0.0, []
    for row in db.query("SELECT name, keywords_json FROM scenes"):
        name = row["name"]
        if name == "other":
            continue
        kws = json.loads(row["keywords_json"] or "[]")
        hits = [k for k in kws if k in text.lower()]
        score = len(hits) * 2.0
        # 多词关键词命中加权
        for h in hits:
            if " " in h:
                score += 1.5
        if score > best_score:
            best, best_score, best_kws = name, score, hits
    confidence = min(1.0, best_score / 4.0) if best != "other" else 0.0
    return best, round(confidence, 2), best_kws


def estimate_difficulty(sentence):
    """难度 1-10：生词率 + 句长 + 词长 + 结构。"""
    words = re.findall(r"[a-z']+", sentence.lower())
    if not words:
        return 1.0
    common = _common_words()
    unknown = [w for w in words if w not in common and not w.isdigit()]
    unk_ratio = len(unknown) / len(words)
    avg_len = sum(len(w) for w in words) / len(words)
    d = 1.0
    d += min(5.0, unk_ratio * 8.0)
    d += min(2.0, len(words) / 12.0)
    if avg_len > 5.5:
        d += 0.8
    if len(words) > 22:
        d += 1.0
    if len(words) <= 3:
        d -= 0.8
    d = min(10, max(1, round(d, 1)))
    return d


def learning_value(sentence, scene="", difficulty=None, has_expression=None):
    """学习价值 0-100：日常场景 + 难度甜区 + 高价值表达 + 长度。"""
    if difficulty is None:
        difficulty = estimate_difficulty(sentence)
    if has_expression is None:
        has_expression = bool(extract_expressions(sentence, scene))
    words = re.findall(r"[a-z']+", sentence.lower())
    n = len(words)
    v = 40.0
    if scene in DAILY_SCENES:
        v += 20
    if 3 <= difficulty <= 7:
        v += 10
    elif difficulty <= 2:
        v += 4
    if has_expression:
        v += 15
    if 5 <= n <= 18:
        v += 10
    elif n > 30:
        v -= 20
    elif n > 22:
        v -= 8
    if sentence.strip().endswith(("?", "!")):
        v += 5
    if scene in ("other", "") and n < 4:
        v -= 15
    return max(0, min(100, round(v)))


def analyze_unit_text(text, scene_hint=""):
    """一句话的完整规则分析。"""
    scene, conf, kws = classify_scene(text)
    if scene == "other" and scene_hint:
        scene = scene_hint
    difficulty = estimate_difficulty(text)
    expressions = extract_expressions(text, scene if scene != "other" else scene_hint)
    value = learning_value(text, scene, difficulty, bool(expressions))
    return {
        "scene": scene,
        "scene_confidence": conf,
        "scene_keywords": kws,
        "difficulty": difficulty,
        "learning_value": value,
        "expressions": expressions,
    }


def scene_label(scene):
    row = db.query_one("SELECT label, emoji FROM scenes WHERE name=?", (scene,))
    if row:
        return row["label"] or scene, row["emoji"] or "📌"
    return scene, "📌"


def scenes_list():
    return [
        {"name": r["name"], "label": r["label"], "emoji": r["emoji"]}
        for r in db.query("SELECT name, label, emoji FROM scenes ORDER BY name")
    ]
