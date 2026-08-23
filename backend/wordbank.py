"""离线英汉词库：内置精选高频词表（零网络、零第三方依赖）。

释义来源：内置精选常用词（CEFR A1-B1 核心词汇），随 App 分发。
查不到时前端显示「暂无释义」，可手动补充或启用 AI 补充。
"""
import json
import os
import re

from . import paths

DATA_PATH = os.path.join(paths.backend_data_dir(), "wordbank.json")
_cache = None


def _load():
    global _cache
    if _cache is None:
        try:
            with open(DATA_PATH, encoding="utf-8") as f:
                _cache = json.load(f)
        except Exception:
            _cache = {}
    return _cache


def lookup(text):
    """查词：整串 → 首词 → 逐个单词首查。返回 (word, [pos, meaning]) 或 None。"""
    words = _load()
    q = (text or "").strip().lower().strip(".,!?;:'\"()[]- ")
    if not q:
        return None
    candidates = [q]
    if " " in q:
        candidates.append(q.split()[0])
    for c in candidates:
        if c in words:
            return c, words[c]
    for w in re.findall(r"[a-z']+", q):
        if w in words:
            return w, words[w]
    return None


def lookup_online(word, timeout=6):
    """免费在线词典回退（dictionaryapi.dev，无需 API key）。

    返回 {word, pos, meaning(英文释义), example_en, phonetic} 或 None。
    网络失败/无网时静默返回 None（不影响离线词库主流程）。
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    w = (word or "").strip().lower().strip(".,!?;:'\"()[]- ")
    if not w or " " in w:
        return None
    url = "https://api.dictionaryapi.dev/api/v2/entries/en/" + urllib.parse.quote(w)
    req = urllib.request.Request(url, headers={"User-Agent": "DeepSpeak/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
    except Exception:
        return None
    if not isinstance(data, list) or not data:
        return None
    entry = data[0]
    phonetic = ""
    for p in entry.get("phonetics", []):
        if p.get("text"):
            phonetic = p["text"]
            break
    meanings = entry.get("meanings") or []
    if not meanings:
        return None
    m0 = meanings[0]
    pos = m0.get("partOfSpeech", "")
    defs = m0.get("definitions") or []
    if not defs:
        return None
    meaning = defs[0].get("definition", "").strip()
    example = defs[0].get("example", "").strip() if defs[0].get("example") else ""
    return {"word": w, "pos": pos, "meaning": meaning,
            "example_en": example, "phonetic": phonetic}
