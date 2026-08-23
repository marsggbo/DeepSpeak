"""内容导入器：URL / YouTube 字幕 / Podcast RSS / 网页文章。

原则：
- 只使用公开、合法可获取的内容（尊重网站 ToS，不绕过付费/DRM）。
- YouTube 优先取官方字幕（不下载视频）；拿不到字幕则提示用户导入音频走本地 ASR。
- RSS 解析用标准库 xml.etree；网页正文提取用标准库 html.parser（启发式）。
"""
import html
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def _fetch(url, timeout=20, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        # 部分 CDN（如 content.rss.com）对浏览器 UA 返回 403，但对普通客户端放行
        if e.code != 403:
            raise
        req = urllib.request.Request(url, headers=dict(headers or {}))
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()


def _http_error(e):
    return f"网络请求失败: {e}"


def detect_kind(url):
    """识别 URL 类型：youtube | podcast | web | audio | unknown"""
    host = urllib.parse.urlparse(url).netloc.lower()
    if "youtube.com" in host or "youtu.be" in host:
        return "youtube"
    if url.lower().endswith((".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus")):
        return "audio"
    try:
        body = _fetch(url, timeout=15)
        text = body.decode("utf-8", errors="replace")
        if "<rss" in text[:2000].lower() or "<feed" in text[:2000].lower():
            return "podcast"
        if url.lower().endswith((".xml", ".rss")) or re.search(r"itunes|podcast", text[:5000], re.I):
            return "podcast"
    except Exception:
        return "unknown"
    return "web"


# ---------- YouTube ----------

def youtube_video_id(url):
    p = urllib.parse.urlparse(url)
    if "youtu.be" in p.netloc:
        return p.path.strip("/")
    q = urllib.parse.parse_qs(p.query)
    if "v" in q:
        return q["v"][0]
    m = re.search(r"/(?:embed|shorts|live)/([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else None


def fetch_youtube_transcript(url):
    """用 youtube-transcript-api 获取字幕（可选依赖）。返回 {"title","text","segments"} 或抛异常。"""
    vid = youtube_video_id(url)
    if not vid:
        raise ValueError("无法从 URL 中识别 YouTube 视频 ID")
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        raise RuntimeError(
            "需要 youtube-transcript-api（pip install youtube-transcript-api）才能自动抓取 YouTube 字幕。"
            "也可以手动复制字幕文本粘贴导入。"
        )
    api = YouTubeTranscriptApi()
    try:
        tl = api.list(vid)
    except Exception as e:
        raise RuntimeError(f"该视频可能没有公开字幕: {e}")
    # 优先英文（含自动生成）
    chosen = None
    for t in tl:
        if t.language_code.startswith("en"):
            chosen = t
            break
    if chosen is None and len(tl) > 0:
        chosen = list(tl)[0]
    if chosen is None:
        raise RuntimeError("没有找到任何字幕")
    segs = chosen.fetch()
    text = " ".join(s.text.strip() for s in segs)
    title = ""
    try:
        body = _fetch(url, timeout=15).decode("utf-8", errors="replace")
        m = re.search(r"<title>(.*?)</title>", body, re.S)
        if m:
            title = html.unescape(m.group(1)).strip()
            title = re.sub(r"\s*-\s*YouTube$", "", title)
    except Exception:
        pass
    return {
        "title": title or f"YouTube {vid}",
        "text": text,
        "segments": [{"start": s.start, "end": s.start + s.duration, "text": s.text.strip()} for s in segs],
    }


# ---------- Podcast RSS ----------

def parse_rss(url):
    """读取 RSS，返回 {"title","episodes":[{"title","url","duration","description","published"}]}"""
    import xml.etree.ElementTree as ET
    body = _fetch(url, timeout=20)
    root = ET.fromstring(body)
    ch = root.find("channel")
    feed_title = ""
    if ch is not None:
        t = ch.find("title")
        feed_title = t.text if t is not None and t.text else ""
    episodes = []
    items = ch.findall("item") if ch is not None else []
    for it in items:
        def g(tag):
            e = it.find(tag)
            return e.text if e is not None and e.text else ""
        ep = {
            "title": g("title"),
            "url": g("enclosure") if it.find("enclosure") is not None else "",
            "duration": g("itunes:duration") if it.find("itunes:duration") is not None else "",
            "description": (g("description") or "")[:200],
            "published": g("pubDate"),
        }
        enc = it.find("enclosure")
        if enc is not None:
            ep["url"] = enc.get("url", "")
        itd = it.find("{http://www.itunes.com/dtds/podcast-1.0.dtd}duration")
        if itd is not None and itd.text:
            ep["duration"] = itd.text
        if ep["title"]:
            episodes.append(ep)
    return {"title": feed_title, "episodes": episodes}


# ---------- Web Article ----------

class _TextExtractor(HTMLParser):
    """启发式正文提取：收集 <p>/<h1-h6>/<li> 文本。"""

    BLOCK = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "br"}
    SKIP = {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside"}

    def __init__(self):
        super().__init__()
        self.blocks = []
        self._cur = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip_depth += 1
        if tag in self.BLOCK and self._skip_depth == 0:
            self._flush()

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip_depth > 0:
            self._skip_depth -= 1
        if tag in self.BLOCK and self._skip_depth == 0:
            self._flush()

    def handle_data(self, data):
        if self._skip_depth == 0:
            t = data.strip()
            if t:
                self._cur.append(re.sub(r"\s+", " ", t))

    def _flush(self):
        if self._cur:
            self.blocks.append(" ".join(self._cur))
            self._cur = []


def fetch_web_article(url):
    """提取网页标题 + 段落。返回 {"title","paragraphs"}"""
    body = _fetch(url, timeout=20).decode("utf-8", errors="replace")
    m = re.search(r"<title>(.*?)</title>", body, re.S)
    title = html.unescape(m.group(1)).strip() if m else url
    parser = _TextExtractor()
    parser.feed(body)
    paras = [p for p in parser.blocks if len(p) >= 15]
    return {"title": title, "paragraphs": paras}


# ---------- 统一入口 ----------

def resolve_url(url):
    """返回 {"kind", "data"}；失败抛异常。"""
    kind = detect_kind(url)
    if kind == "youtube":
        return {"kind": "youtube", "data": fetch_youtube_transcript(url)}
    if kind == "podcast":
        return {"kind": "podcast", "data": parse_rss(url)}
    if kind == "audio":
        return {"kind": "audio", "data": {"url": url}}
    if kind == "web":
        return {"kind": "web", "data": fetch_web_article(url)}
    return {"kind": "unknown", "data": {"url": url}}
