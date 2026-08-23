"""听写/口语比对：WER、CER、Token Diff、模糊匹配、close-enough 判定。

全部为本地算法（无 LLM）。
"""
import difflib
import re

from .textproc import normalize, tokens, content_tokens

# "轻微错误" 类别：冠词、系动词/助动词时态、常见介词 —— 这类错误不判定整句失败
MINOR_ARTICLES = {"a", "an", "the"}
MINOR_AUX = {
    "is", "are", "was", "were", "am", "be", "been", "do", "does", "did",
    "can", "could", "will", "would", "shall", "should", "may", "might", "must",
    "have", "has", "had",
}
MINOR_PREP = {"in", "on", "at", "to", "for", "of", "with", "from", "about"}
MINOR_SETS = (MINOR_ARTICLES, MINOR_AUX, MINOR_PREP)


def _lev(a, b):
    """编辑距离（字符级，用于 CER）。"""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def wer(reference, user):
    """Word Error Rate: 词级编辑距离 / 参考词数。"""
    ref_t = tokens(reference)
    usr_t = tokens(user)
    if not ref_t:
        return 0.0 if not usr_t else 1.0
    return _lev(ref_t, usr_t) / len(ref_t)


def cer(reference, user):
    """Character Error Rate。"""
    r, u = normalize(reference), normalize(user)
    if not r:
        return 0.0 if not u else 1.0
    return _lev(r, u) / len(r)


def token_diff(reference, user):
    """词级对齐，生成前端展示用的 diff。

    返回: [{"t": 词, "ref": 参考词(仅replace), "op": equal|delete|insert|replace, "minor": bool}]
    """
    ref_t = tokens(reference)
    usr_t = tokens(user)
    sm = difflib.SequenceMatcher(None, ref_t, usr_t)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for t in ref_t[i1:i2]:
                out.append({"t": t, "op": "equal", "minor": False})
        elif tag == "delete":
            for t in ref_t[i1:i2]:
                out.append({"t": t, "op": "delete", "minor": _is_minor(t, None)})
        elif tag == "insert":
            for t in usr_t[j1:j2]:
                out.append({"t": t, "op": "insert", "minor": _is_minor(None, t)})
        elif tag == "replace":
            n = max(i2 - i1, j2 - j1)
            for k in range(n):
                rt = ref_t[i1 + k] if i1 + k < i2 else ""
                ut = usr_t[j1 + k] if j1 + k < j2 else ""
                out.append({"t": ut, "ref": rt, "op": "replace", "minor": _is_minor(rt or None, ut or None)})
    return out


def _is_minor(ref_word, usr_word):
    if ref_word is not None and usr_word is not None:
        return any(ref_word in s and usr_word in s for s in MINOR_SETS)
    w = ref_word if ref_word is not None else usr_word
    return any(w in s for s in MINOR_SETS)


def diff_stats(diff):
    """统计 diff 中错误与 minor 错误数。"""
    errors = [d for d in diff if d["op"] != "equal"]
    minors = [d for d in errors if d["minor"]]
    return len(errors), len(minors)


def judge_dictation(reference, user, pass_wer=None):
    """听写判定：通过 | close-enough | fail。

    close-enough：所有错误都属于轻微类别（冠词/时态/介词），整句不算失败。
    pass_wer 阈值缺省 0.12。
    """
    if pass_wer is None:
        pass_wer = 0.12
    w = wer(reference, user)
    c = cer(reference, user)
    diff = token_diff(reference, user)
    n_err, n_minor = diff_stats(diff)
    passed = False
    verdict = "fail"
    if w <= pass_wer:
        passed, verdict = True, "pass"
    elif n_err > 0 and n_minor == n_err and w <= 0.35:
        passed, verdict = True, "close_enough"
    return {
        "wer": round(w, 3),
        "cer": round(c, 3),
        "diff": diff,
        "errors": n_err,
        "minor_errors": n_minor,
        "passed": passed,
        "verdict": verdict,
    }


# ---------- 口语匹配 ----------

def fuzzy_match(reference, user):
    """Exact / Fuzzy / Keyword 三层匹配。

    返回 {score: 0-100, exact, fuzzy_ratio, keyword_coverage, content_words}
    """
    r, u = normalize(reference), normalize(user)
    if not r or not u:
        return {"score": 0, "exact": False, "fuzzy_ratio": 0.0, "keyword_coverage": 0.0, "content_words": 0}
    exact = r == u
    rt, ut = tokens(reference), tokens(user)
    ratio = difflib.SequenceMatcher(None, rt, ut).ratio()
    rc, uc = content_tokens(reference), content_tokens(user)
    cov = 0.0
    if rc:
        cov = sum(1 for w in set(rc) if w in set(uc)) / len(set(rc))
    score = round(max(ratio, cov) * 100)
    return {
        "score": score,
        "exact": exact,
        "fuzzy_ratio": round(ratio, 3),
        "keyword_coverage": round(cov, 3),
        "content_words": len(rc),
    }


def judge_speaking(reference, user, pass_score=None):
    """口语判定（跟读）。pass_score 缺省 60。"""
    if pass_score is None:
        pass_score = 60
    fm = fuzzy_match(reference, user)
    passed = fm["score"] >= pass_score or (fm["keyword_coverage"] >= 0.7 and fm["score"] >= 45)
    verdict = "pass" if passed else ("partial" if fm["score"] >= 40 else "fail")
    fm.update({"passed": passed, "verdict": verdict})
    return fm


def judge_recall(reference, variants, intent_words, user, pass_score=None):
    """主动回忆判定（无 LLM 时）：与参考句及其变体的内容词重叠度。"""
    if pass_score is None:
        pass_score = 60
    refs = [reference] + list(variants or [])
    best = None
    for r in refs:
        fm = fuzzy_match(r, user)
        if best is None or fm["score"] > best["score"]:
            best = fm
    # 意图词加权：命中意图词额外加分
    intent_hits = 0
    if intent_words:
        uc = set(content_tokens(user))
        intent_hits = sum(1 for w in intent_words if w in uc)
        best["score"] = min(100, best["score"] + intent_hits * 5)
    passed = best["score"] >= pass_score
    best.update({"passed": passed, "verdict": "pass" if passed else "fail", "intent_hits": intent_hits})
    return best
