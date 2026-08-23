"""文本处理：归一化、分词、句子切分。

全部为规则实现（无 LLM 依赖）。
"""
import re

# 常见缩写展开（用于比较时归一化）
CONTRACTIONS = {
    "can't": "cannot", "won't": "will not", "don't": "do not", "doesn't": "does not",
    "didn't": "did not", "isn't": "is not", "aren't": "are not", "wasn't": "was not",
    "weren't": "were not", "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
    "couldn't": "could not", "wouldn't": "would not", "shouldn't": "should not",
    "mustn't": "must not", "i'm": "i am", "i've": "i have", "i'll": "i will", "i'd": "i would",
    "you're": "you are", "you've": "you have", "you'll": "you will", "you'd": "you would",
    "he's": "he is", "she's": "she is", "it's": "it is", "we're": "we are", "we've": "we have",
    "we'll": "we will", "they're": "they are", "they've": "they have", "they'll": "they will",
    "that's": "that is", "there's": "there is", "here's": "here is", "what's": "what is",
    "who's": "who is", "let's": "let us", "gonna": "going to", "wanna": "want to",
    "gotta": "got to", "kinda": "kind of", "sorta": "sort of", "ain't": "is not",
    "would've": "would have", "could've": "could have", "should've": "should have",
    "y'all": "you all", "ma'am": "madam", "o'clock": "o clock",
}

_PUNCT_RE = re.compile(r"[.,!?;:'\"()\[\]{}\u2018\u2019\u201c\u201d\u2013\u2014\u2026-]+")
_WS_RE = re.compile(r"\s+")
_NUM_RE = re.compile(r"^\d+(\.\d+)?$")
_START_NOISE = re.compile(r"^(um+|uh+|er+|ah+|like|you know|i mean|well|so|okay?|right|hmm+)[,\s]+", re.I)
_END_NOISE = re.compile(r"[,\s]*(you know|i mean|right|okay?|hmm+)$", re.I)


def normalize(text):
    """归一化：小写、去标点、展开缩写、合并空白。用于听写/口语比对。"""
    if not text:
        return ""
    t = text.strip().lower()
    # 缩写展开（带撇号形式优先）
    for k, v in CONTRACTIONS.items():
        t = re.sub(r"\b" + re.escape(k) + r"\b", v, t)
    t = _PUNCT_RE.sub(" ", t)
    t = _WS_RE.sub(" ", t).strip()
    return t


def tokens(text):
    """分词（用于 WER / 匹配）。"""
    n = normalize(text)
    return n.split(" ") if n else []


def content_tokens(text):
    """内容词：去掉纯功能词后的 token（用于口语/回忆匹配）。"""
    STOP = {
        "a", "an", "the", "and", "or", "but", "so", "to", "of", "in", "on", "at",
        "for", "with", "is", "are", "was", "were", "be", "been", "being", "am",
        "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
        "my", "your", "his", "its", "our", "their", "do", "does", "did", "have",
        "has", "had", "can", "could", "will", "would", "shall", "should", "may",
        "might", "must", "this", "that", "these", "those", "there", "here", "not",
        "no", "yes", "just", "very", "really", "ok", "okay", "oh", "well", "uh",
        "um", "about", "as", "if", "then", "than", "by", "from", "into", "onto",
        "during", "before", "after", "also", "too", "any", "some", "more", "most",
        "much", "many", "even", "still", "yet", "only", "because", "since", "while",
        "though", "although", "whether", "either", "neither", "both", "each",
        "every", "few", "several", "whose", "whom", "which", "what", "who", "when",
        "where", "why", "how", "does", "did", "done",
    }
    return [t for t in tokens(text) if t not in STOP and not _NUM_RE.match(t)]


def split_sentences(text):
    """把一段文本切成句子。

    规则：按 . ! ? 切分，保留缩写（Mr. / Dr. / e.g. / U.S. / 数字小数点）。
    每句去掉首尾空白与引导性噪声词（um, uh, well, so...）。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 缩写保护
    text = re.sub(r"\b(Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|e\.g|i\.e|approx|min|max|hr|sec|oz|lb|kg|ft|in|cm|mm)\.", r"\1<DOT>", text)
    text = re.sub(r"\b([A-Za-z])\.([A-Za-z])\.", r"\1<DOT>\2<DOT>", text)
    text = re.sub(r"(\d)\.(\d)", r"\1<DOT>\2", text)

    parts = re.split(r"(?<=[.!?])\s+|\n+", text.strip())
    sentences = []
    for p in parts:
        p = p.replace("<DOT>", ".").strip()
        if not p:
            continue
        p = re.sub(r"^[“\"'\u201c\u201d]+|[”\"'\u201c\u201d]+$", "", p)
        p = _START_NOISE.sub("", p).strip()
        p = _END_NOISE.sub("", p).strip()
        if p:
            sentences.append(p)
    return sentences


def expand_segments_by_sentence(segments):
    """把 ASR 片段按终止标点拆成子句，时间按词数比例分配。

    whisper 的 segment 常把多句合并成一段（一段可长达几十秒），而训练
    单元应以句号/问号/感叹号收尾的一句为界，所以先拆句再分配时间。
    """
    out = []
    for s in segments:
        text = clean_speaker_label(s["text"]).strip()
        subs = split_sentences(text)
        if not subs:
            continue
        if len(subs) == 1:
            out.append({"text": subs[0], "start": s.get("start", 0), "end": s.get("end", 0),
                        "speaker": s.get("speaker", "")})
            continue
        dur = max(0.0, (s.get("end") or 0) - (s.get("start") or 0))
        cur = s.get("start") or 0
        weights = [len(tokens(x)) or 1 for x in subs]
        total = sum(weights)
        for x, w in zip(subs, weights):
            span = dur * w / total
            out.append({"text": x, "start": round(cur, 3), "end": round(cur + span, 3),
                        "speaker": s.get("speaker", "")})
            cur += span
    return out


def align_sentences_to_segments(sentences, segments):
    """把句子列表对齐到带时间戳的 ASR 片段上（贪心匹配）。

    segments: [{"text": str, "start": float_sec, "end": float_sec}]
    返回: [{"text": str, "start_ms": int, "end_ms": int, "speaker": str}]
    """
    from difflib import SequenceMatcher

    segments = expand_segments_by_sentence(segments)
    result = []
    seg_i = 0
    n = len(segments)

    def overlap(a, b):
        ta, tb = tokens(a), tokens(b)
        if not ta or not tb:
            return 0.0
        return SequenceMatcher(None, ta, tb).ratio()

    for sent in sentences:
        stok = tokens(sent)
        if not stok:
            continue
        best = None
        # 在当前及后续 3 个片段内找最佳
        for j in range(seg_i, min(seg_i + 4, n)):
            sc = overlap(sent, segments[j]["text"])
            if best is None or sc > best[0]:
                best = (sc, j)
        if best is None:
            continue
        score, j = best
        if score < 0.25:
            # 实在对不上：不给时间戳，靠整段播放
            result.append({"text": sent, "start_ms": 0, "end_ms": 0, "speaker": ""})
            continue
        start = segments[j]["start"]
        end = segments[j]["end"]
        # 尽量把后续片段并入，直到覆盖句末
        consumed = j
        while consumed + 1 < n and not _sentence_finished(stok, segments[consumed]["text"], segments[consumed + 1]["text"]):
            consumed += 1
            end = segments[consumed]["end"]
        if start == 0 and end == 0:
            end = start + max(0.8, len(stok) * 0.42)  # 兜底时长
        result.append({
            "text": sent,
            "start_ms": int(start * 1000),
            "end_ms": int(end * 1000),
            "speaker": segments[consumed].get("speaker", ""),
        })
        seg_i = consumed + 1
    return result


def _sentence_finished(sent_tokens, seg_text, next_seg_text):
    """粗略判断句子是否已在当前片段结束（片段以终止标点结尾，或下一片段以人称代词开头通常是新句）。"""
    st = seg_text.strip()
    if st and st[-1] in ".!?":
        return True
    ns = next_seg_text.strip()
    if ns and re.match(r"^(i|you|he|she|we|they|what|where|when|how|do|did|can|could|would|is|are|was|have|has|there|it)\b", ns, re.I):
        return True
    # 句子 token 已基本被覆盖
    return False


def clean_speaker_label(text):
    """从 ASR/字幕片段文本里剥离 'Speaker 1:' 之类前缀。"""
    m = re.match(r"^\s*(?:speaker\s*\d+|\[[^\]]+\]|\([^)]*\))\s*:\s*", text, re.I)
    if m:
        return text[m.end():].strip()
    return text
