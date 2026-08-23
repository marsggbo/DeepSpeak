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
