// DeepSpeak 浏览器内导入引擎（网页 + APK 通用）
// 职责：抓 RSS/音频 → 解析 → 浏览器内 Whisper 转写 → 分句建单元。
// 与桌面 backend（importers.py + pipeline.py + textproc.py）保持同样的产出结构，
// 供 engine.js 的离线模式在没有 Python 后端时调用。
//
// 三个技术点：
//   1. 跨域抓取：APK 走 Capacitor 内置 CapacitorHttp（原生请求，天然绕过 CORS）；
//      网页走 fetch，跨域源需用户在设置里填一个可选 CORS 代理。
//   2. RSS 解析：DOMParser（对齐 importers.parse_rss）。
//   3. 音频转写：@huggingface/transformers 的 Whisper（WASM/WebGPU），
//      首次从 CDN 拉模型并由浏览器缓存，之后离线可用。
(function () {
  "use strict";

  // ---------- 环境探测 ----------
  function cap() {
    const C = window.Capacitor;
    return C && C.isNativePlatform && C.isNativePlatform() ? C : null;
  }
  function capHttp() {
    const C = cap();
    if (!C) return null;
    // Capacitor 8：registerPlugin 把插件挂在 Plugins 命名空间下
    const P = C.Plugins && C.Plugins.CapacitorHttp;
    return P || C.CapacitorHttp || null;
  }

  // 网页跨域抓取：{proxy}URL 形式拼接（末尾带 = 或 ? 的代理直接前缀拼原始 URL）。
  function withProxy(url, proxy) {
    if (!proxy) return url;
    proxy = proxy.trim();
    if (!proxy) return url;
    // 形如 https://proxy/?url= 或 https://proxy/ → 前缀拼接（原始 URL 编码）
    if (/[?&=]$/.test(proxy)) return proxy + encodeURIComponent(url);
    if (proxy.endsWith("/")) return proxy + url;
    return proxy + "/" + url;
  }

  // 网页侧公共代理兜底链（用户不填也有一条路；APK 原生请求不走这里）。
  // 注意：这些是第三方服务——RSS 与音频会经过对应站点，设置页有说明。
  const BUILTIN_PROXIES = [
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?url=",
    "https://api.codetabs.com/v1/proxy?quest=",
  ];

  function proxyCandidates(proxy) {
    const list = [{ url: null, label: "直连" }];
    if (proxy && proxy.trim()) list.push({ url: proxy.trim(), label: "你的代理" });
    BUILTIN_PROXIES.forEach((p, i) => {
      if (!list.some((a) => a.url === p)) list.push({ url: p, label: "内置代理 " + (i + 1) });
    });
    return list;
  }

  // 探测候选时给个连接超时：代理经常连不上/挂了，纯 fetch 会等浏览器级超时（几十秒）。
  // 只限「拿到响应头」这一步，下载正文不受此限（头部 timeout 后立即 clear）。
  async function fetchWithTimeout(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(url, { redirect: "follow", signal: ctl.signal });
      clearTimeout(timer);
      return r;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // 逐个候选尝试：直连（兼容 CORS 源）→ 用户代理 → 内置公共代理。
  // 网络/CORS 失败、HTTP 错误换下一条（代理常 502/限流）；但「返回的不是音频」是内容问题，
  // 换代理大概率还是错误页——立即终止，把具体是哪条路径给的错误页报出来，方便对症处理。
  async function fetchChain(url, proxy, consume) {
    const reasons = [];
    let contentFail = false;
    for (const a of proxyCandidates(proxy)) {
      try {
        const r = await fetchWithTimeout(withProxy(url, a.url));
        if (!r.ok) { reasons.push(`${a.label} HTTP ${r.status}`); continue; }
        return await consume(r);
      } catch (e) {
        if (e && e.isContent) {
          contentFail = true;
          reasons.push(`${a.label} ${e.message}`);
          break;
        }
        reasons.push(`${a.label} 网络/CORS/超时失败`);
      }
    }
    const tail = "网页受浏览器跨域限制，可在设置页配置 CORS 代理后重试；" +
      "或直接用 APK / 桌面版导入（本地请求无跨域限制）。";
    throw new Error(
      (contentFail ? "抓取失败：" : "网络请求失败：") + reasons.join("；") + "。" + tail
    );
  }

  function contentError(msg) {
    const e = new Error(msg);
    e.isContent = true;
    return e;
  }

  // 音频文件头魔数校验（mp3 ID3/帧同步、wav RIFF、m4a ftyp、ogg、flac）。
  // 抓回来的“音频”经常是代理偷换的错误页/HTML——这里拦在解码之前，而不是报裸的
  // “Unable to decode audio data”。
  function isAudioContent(buf) {
    if (!buf || buf.length < 3) return false;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;        // ID3
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;                   // MPEG 帧同步
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true; // RIFF
    if (buf[0] === 0x66 && buf[1] === 0x74 && buf[2] === 0x79 && buf[3] === 0x70) return true; // ftyp
    if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true; // OggS
    if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return true; // fLaC
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // matroska/webm
    return false;
  }

  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || "application/octet-stream" });
  }

  // ---------- 网络：文本（RSS/XML） ----------
  async function fetchText(url, proxy) {
    const H = capHttp();
    if (H) {
      const res = await H.get({ url, responseType: "text", headers: { "User-Agent": "Mozilla/5.0 DeepSpeak" } });
      if (res.status >= 400) throw new Error(`网络请求失败 HTTP ${res.status}`);
      return typeof res.data === "string" ? res.data : String(res.data || "");
    }
    return fetchChain(url, proxy, (r) => r.text());
  }

  // ---------- 网络：二进制（音频） ----------
  async function fetchBlob(url, proxy, onProgress) {
    const H = capHttp();
    if (H) {
      // CapacitorHttp 原生下载返回 base64；无分块进度，给个不确定态
      if (onProgress) onProgress(0, 0);
      const res = await H.get({ url, responseType: "blob", headers: { "User-Agent": "Mozilla/5.0 DeepSpeak" } });
      if (res.status >= 400) throw new Error(`音频下载失败 HTTP ${res.status}`);
      const type = (res.headers && (res.headers["Content-Type"] || res.headers["content-type"])) || "audio/mpeg";
      if (onProgress) onProgress(1, 1);
      return b64ToBlob(res.data, type);
    }
    const consume = async (r) => {
      const total = Number(r.headers.get("Content-Length") || 0);
      const ctype = (r.headers.get("Content-Type") || "").toLowerCase();
      const reader = r.body ? r.body.getReader() : null;
      if (!reader) {
        const b = await r.blob();
        if (onProgress) onProgress(b.size, b.size || 0);
        if (b.size < 4 || !isAudioContent(new Uint8Array(await b.slice(0, 16).arrayBuffer()))) {
          throw contentError("返回内容不是音频（可能拿到了错误页）");
        }
        return b;
      }
      const chunks = [];
      let received = 0;
      let sniffed = false;
      let invalid = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (!sniffed && received >= 4) {
          sniffed = true;
          // 前几块拼出足够字节做魔数校验
          let merged = chunks[0];
          if (merged.length < 8) {
            const tmp = new Uint8Array(received);
            let off = 0;
            for (const c of chunks) { tmp.set(c, off); off += c.length; }
            merged = tmp;
          }
          if (isAudioContent(merged)) {
            invalid = false;
          } else if (ctype && ctype.startsWith("audio/")) {
            // 类型声明是音频但魔数不对 → 内容被换过；仍交给解码兜底判定
            invalid = false;
          } else {
            invalid = true;
            break;
          }
        }
        if (onProgress && total) onProgress(received, total);
      }
      if (invalid) {
        throw contentError(`返回内容不是音频（${(ctype || "无类型")}，可能拿到了错误页/被代理替换）`);
      }
      if (received < 1024) {
        throw contentError("下载内容过小（不是有效音频）");
      }
      if (onProgress && !total) onProgress(received, received || 0);
      return new Blob(chunks, { type: r.headers.get("Content-Type") || "audio/mpeg" });
    };
    return fetchChain(url, proxy, consume);
  }

  // ---------- RSS 类型识别（对齐 importers.detect_kind） ----------
  function detectKind(url) {
    const u = url.toLowerCase();
    if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
    if (/\.(mp3|m4a|wav|aac|ogg|opus)(\?|$)/.test(u)) return "audio";
    if (/\.(xml|rss)(\?|$)/.test(u)) return "podcast";
    return "unknown"; // 需抓内容后再判定 podcast/web
  }

  // ---------- RSS 解析（对齐 importers.parse_rss） ----------
  function parseRss(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("RSS 解析失败：不是合法的 XML");
    const ch = doc.querySelector("channel");
    const feedTitle = ch ? textOf(ch.querySelector(":scope > title")) : "";
    const items = ch ? Array.from(ch.querySelectorAll(":scope > item")) : [];
    const episodes = [];
    for (const it of items) {
      const enc = it.querySelector("enclosure");
      const dur = it.getElementsByTagName("itunes:duration")[0];
      const ep = {
        title: textOf(it.querySelector(":scope > title")),
        url: enc ? (enc.getAttribute("url") || "") : "",
        duration: dur && dur.textContent ? dur.textContent.trim() : "",
        description: (textOf(it.querySelector(":scope > description")) || "").slice(0, 200),
        published: textOf(it.querySelector(":scope > pubDate")),
      };
      if (ep.title) episodes.push(ep);
    }
    return { title: feedTitle, episodes };
  }
  function textOf(el) { return el && el.textContent ? el.textContent.trim() : ""; }

  // ---------- feed 抓取 + 判定 ----------
  async function fetchFeed(url, proxy) {
    const kind = detectKind(url);
    if (kind === "audio") return { kind: "audio", url };
    if (kind === "youtube") throw new Error("网页/APK 暂不支持 YouTube 字幕抓取，请用桌面版或直接粘贴字幕");
    const text = await fetchText(url, proxy);
    const head = text.slice(0, 2000).toLowerCase();
    if (head.includes("<rss") || head.includes("<feed") || /itunes|podcast/i.test(text.slice(0, 5000))) {
      const feed = parseRss(text);
      if (!feed.episodes.length) throw new Error("该 RSS 没有可下载的单集音频");
      return { kind: "podcast", feed };
    }
    throw new Error("无法识别为播客 RSS 或音频直链；网页正文导入请用桌面版");
  }

  // ================= 分句（移植 textproc.split_sentences） =================
  const START_NOISE = /^(um+|uh+|er+|ah+|like|you know|i mean|well|so|okay?|right|hmm+)[,\s]+/i;
  const END_NOISE = /[,\s]*(you know|i mean|right|okay?|hmm+)$/i;
  const ABBR = /\b(Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|e\.g|i\.e|approx|min|max|hr|sec|oz|lb|kg|ft|in|cm|mm)\./g;

  function splitSentences(text) {
    if (!text) return [];
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text.replace(ABBR, "$1<DOT>");
    text = text.replace(/\b([A-Za-z])\.([A-Za-z])\./g, "$1<DOT>$2<DOT>");
    text = text.replace(/(\d)\.(\d)/g, "$1<DOT>$2");
    const parts = text.trim().split(/(?<=[.!?])\s+|\n+/);
    const out = [];
    for (let p of parts) {
      p = p.replace(/<DOT>/g, ".").trim();
      if (!p) continue;
      p = p.replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, "");
      p = p.replace(START_NOISE, "").trim();
      p = p.replace(END_NOISE, "").trim();
      if (p) out.push(p);
    }
    return out;
  }

  function cleanSpeakerLabel(text) {
    const m = text.match(/^\s*(?:speaker\s*\d+|\[[^\]]+\]|\([^)]*\))\s*:\s*/i);
    return m ? text.slice(m[0].length).trim() : text;
  }

  function wordCount(text) {
    const m = (text || "").toLowerCase().match(/[a-z']+/g);
    return m ? m.length : 0;
  }

  // ===== 句子时间线：跨窗口词流缝合 + 词级时间戳切分（保证“一句话=一个单元、时间跟着词走”） =====
  // 背景：whisper 按 30s 窗口独立转写，窗口边界常把句子拦腰截断（上一块结尾挂着逗号/半句）。
  // 旧的“逐窗口→按句切”会把这些残句当成完整句子 → 用户看到“以逗号断句”。
  // 正解：窗口间无损拼接（词级时间戳），只在真正句终（. ? !，且豁免 Mr./U.S./3.5 类缩写）
  // 收束一句；句子的 start/end 直接取首词/末词的时间戳（不再按词数猜时间）。
  // 拿不到词级时间戳时兜底：先把残句跨窗口合并，再按词数比例分配时间。
  function chunkWords(chunk) {
    const text = (chunk.text || "").trim();
    const ts = chunk.timestamps;
    if (!Array.isArray(ts) || !ts.length) return null;
    const toks = text.split(/\s+/);
    if (toks.length !== ts.length) return null;
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const a = ts[i];
      if (!Array.isArray(a) || a[0] == null || a[1] == null) return null;
      out.push({ w: toks[i], s: a[0], e: a[1] });
    }
    return out;
  }

  function isSentenceEnd(w) {
    let core = String(w || "").trim();
    if (!core) return false;
    if (/^[.!?…]+["'”’)\]]*$/.test(core)) return true; // 独立标点 token
    const last = core[core.length - 1];
    if (last !== "." && last !== "!" && last !== "?" && last !== "…") return false;
    core = core.slice(0, -1).replace(/["'”’)\]]+$/, "").trim();
    if (!core) return false;
    if (/\b(Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|e\.g|i\.e|approx|min|max|hr|sec|oz|lb|kg|ft|in|cm|mm)$/i.test(core)) return false;
    if (/\d+\.\d+$/.test(core)) return false;           // 3.5 / 编号 19.1
    if (/^[A-Za-z]$/.test(core)) return false;          // 首字母缩写 U.
    if (/^[A-Za-z]\.[A-Za-z]$/.test(core)) return false; // 缩写 U.S. / E.T.
    return true;
  }

  function endsSentenceEnd(text) {
    const toks = String(text || "").trim().split(/\s+/);
    return toks.length ? isSentenceEnd(toks[toks.length - 1]) : false;
  }

  function wordsToText(words) {
    return words
      .map((x) => x.w)
      .join(" ")
      .replace(/\s+([,.;:!?…])/g, "$1")
      .replace(/\s+(["'”’)\]]+)\s*$/g, "$1");
  }

  function cleanSentenceText(t) {
    let p = String(t || "").trim();
    p = p.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
    p = p.replace(START_NOISE, "").trim();
    p = p.replace(END_NOISE, "").trim();
    return p;
  }

  // 词级切句：整个音频的词和词的时间戳铺成一条流，遇句界收束
  function cutByWords(words) {
    const out = [];
    let cur = [];
    for (let i = 0; i < words.length; i++) {
      cur.push(words[i]);
      if (isSentenceEnd(words[i].w) || i === words.length - 1) {
        const text = cleanSentenceText(wordsToText(cur));
        if (text) {
          const first = cur.find((x) => x.s != null && x.e != null) || {};
          const last = [...cur].reverse().find((x) => x.s != null && x.e != null) || first;
          out.push({ text, start: first.s || 0, end: last.e || last.s || 0 });
        }
        cur = [];
      }
    }
    return out;
  }

  // 无词级时间戳兜底：先跨窗口缝合残句，再按句切分、词数比例分配时间
  function splitByTextSegments(segments) {
    const merged = [];
    let buf = null;
    for (const s of segments || []) {
      const text = (s.text || "").trim();
      if (!text) continue;
      if (buf && !endsSentenceEnd(buf.text)) {
        buf.text += " " + text;
        if (s.end != null) buf.end = s.end;
      } else {
        if (buf) merged.push(buf);
        buf = { text, start: s.start || 0, end: s.end || 0 };
      }
    }
    if (buf) merged.push(buf);
    const out = [];
    for (const m of merged) {
      const subs = splitSentences(m.text);
      if (!subs.length) continue;
      if (subs.length === 1) { out.push({ text: subs[0], start: m.start, end: m.end }); continue; }
      const weights = subs.map((x) => wordCount(x) || 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let cur = m.start;
      subs.forEach((x, i) => {
        const span = (m.end - m.start) * weights[i] / total;
        out.push({ text: x, start: Math.round(cur * 1000) / 1000, end: Math.round((cur + span) * 1000) / 1000 });
        cur += span;
      });
    }
    return out;
  }

  function sentenceTimeline(segments) {
    const words = [];
    let allWordLevel = true;
    for (const s of segments || []) {
      if (Array.isArray(s.words) && s.words.length && s.words.every((x) => x && x.w != null && x.s != null && x.e != null)) {
        words.push(...s.words);
      } else {
        allWordLevel = false;
      }
    }
    return allWordLevel && words.length ? cutByWords(words) : splitByTextSegments(segments);
  }

  // 移植 textproc.expand_segments_by_sentence：ASR chunk 按终止标点拆句、时间按词数比例分配（兜底路径用）
  function expandSegmentsBySentence(segments) {
    const out = [];
    for (const s of segments) {
      const text = cleanSpeakerLabel(s.text || "").trim();
      const subs = splitSentences(text);
      if (!subs.length) continue;
      const start = s.start || 0;
      const end = s.end || 0;
      if (subs.length === 1) {
        out.push({ text: subs[0], start, end });
        continue;
      }
      const dur = Math.max(0, end - start);
      const weights = subs.map((x) => wordCount(x) || 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let cur = start;
      subs.forEach((x, i) => {
        const span = dur * weights[i] / total;
        out.push({ text: x, start: Math.round(cur * 1000) / 1000, end: Math.round((cur + span) * 1000) / 1000 });
        cur += span;
      });
    }
    return out;
  }

  // ================= 轻量单元分析（简版 extract.analyze_unit_text） =================
  function estimateDifficulty(sentence) {
    const words = (sentence.toLowerCase().match(/[a-z']+/g)) || [];
    if (!words.length) return 1;
    const avgLen = words.reduce((a, w) => a + w.length, 0) / words.length;
    let d = 1.0;
    d += Math.min(2.0, words.length / 12.0);
    if (avgLen > 5.5) d += 1.4;
    if (avgLen > 7) d += 1.0;
    if (words.length > 22) d += 1.0;
    if (words.length <= 3) d -= 0.8;
    return Math.min(10, Math.max(1, Math.round(d * 10) / 10));
  }

  function learningValue(sentence, difficulty) {
    const n = wordCount(sentence);
    let v = 40;
    if (difficulty >= 3 && difficulty <= 7) v += 10;
    else if (difficulty <= 2) v += 4;
    if (n >= 5 && n <= 18) v += 10;
    else if (n > 30) v -= 20;
    else if (n > 22) v -= 8;
    if (/[?!]\s*$/.test(sentence.trim())) v += 5;
    if (n < 4) v -= 15;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function analyzeUnit(text) {
    const difficulty = estimateDifficulty(text);
    return { scene: "", difficulty, learning_value: learningValue(text, difficulty), expressions: [] };
  }

  // buildUnits：词级时间线切句 → analyze → 产出 engine.js 单元结构（ms 时间戳）
  function buildUnits(segments) {
    const timed = sentenceTimeline(segments);
    const units = [];
    timed.forEach((t, i) => {
      const ana = analyzeUnit(t.text);
      units.push({
        seq: i + 1,
        text: t.text,
        speaker: "",
        start_ms: Math.round((t.start || 0) * 1000),
        end_ms: Math.round((t.end || 0) * 1000),
        scene: ana.scene,
        difficulty: ana.difficulty,
        learning_value: ana.learning_value,
        expressions: ana.expressions,
      });
    });
    return units;
  }

  // ================= Whisper 转写（@huggingface/transformers） =================
  const MODEL_MAP = {
    "tiny.en": "Xenova/whisper-tiny.en",
    "base.en": "Xenova/whisper-base.en",
  };
  const TX_CDNS = [
    // 本地 vendor 优先（与 APK 一起打包，离线可用）；失败再走 CDN 兜底。
    // v2 系列（@xenova/transformers）：纯 WASM 起步，WebGPU 仅显式请求才启用，
    // 安卓 WebView 无 GPU adapter 时回退干净（v3.0.x 在 device 选择上有缺陷会崩）
    "./vendor/transformers@2.17.2.js",
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
    "https://unpkg.com/@xenova/transformers@2.17.2",
  ];
  let _tx = null;          // 已加载的 transformers 模块
  const _pipes = {};       // repo → pipeline

  async function loadTransformers() {
    if (_tx) return _tx;
    let lastErr = null;
    for (let i = 0; i < TX_CDNS.length; i++) {
      const cdn = TX_CDNS[i];
      try {
        _tx = await import(/* @vite-ignore */ cdn);
        // 允许读本机 /models/（APK 内置模型直接本地加载，不再联网下载）；
        // 无本地文件时自动回退远程下载（网页版行为不变）。
        _tx.env.allowLocalModels = true;
        _tx.env.localModelPath = "/models/";
        _tx.env.useBrowserCache = true; // 模型文件用浏览器 Cache API 缓存，二次离线可用
        if (i === 0) {
          // 本地 vendor：onnxruntime 的 wasm 内核也随包提供（库默认指向 jsdelivr，离线会挂）
          _tx.env.backends.onnx.wasm.wasmPaths = "./vendor/";
        }
        return _tx;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`加载语音识别库失败（需联网首次下载）：${lastErr}`);
  }

  async function getPipeline(modelName, onProgress) {
    const repo = MODEL_MAP[modelName] || MODEL_MAP["tiny.en"];
    if (_pipes[repo]) return _pipes[repo];
    const tx = await loadTransformers();
    const device = navigator.gpu ? "webgpu" : "wasm";
    const opts = {
      progress_callback: (p) => {
        if (onProgress && p && p.status === "progress" && p.total) {
          onProgress(p.loaded / p.total, p.file || "");
        }
      },
    };
    // 官方源下载失败（大陆网络常见）→ 自动切 hf-mirror.com 镜像；
    // WebGPU 不稳（安卓 WebView 常见）→ 回退 WASM。两个维度穷举。
    let pipe = null, lastErr = null;
    const prevHost = tx.env.remoteHost;
    try {
      for (const host of [null, "https://hf-mirror.com"]) {
        if (host) tx.env.remoteHost = host;
        for (const dev of [device, "wasm"]) {
          try {
            pipe = await tx.pipeline("automatic-speech-recognition", repo, { ...opts, device: dev });
            break;
          } catch (e) { lastErr = e; }
        }
        if (pipe) break;
      }
    } finally {
      tx.env.remoteHost = prevHost;
    }
    if (!pipe) throw new Error("语音识别模型下载失败：" + String((lastErr && lastErr.message) || lastErr) + "。请检查网络（模型来自 huggingface.co / hf-mirror.com）");
    _pipes[repo] = pipe;
    return pipe;
  }

  // 把音频 blob 解码为 16kHz 单声道 Float32Array（Whisper 输入要求）
  async function decodeAudio(blob) {
    if (!blob || blob.size < 1024) {
      throw new Error("音频文件过小或为空，不是有效的音频文件");
    }
    const buf = await blob.arrayBuffer();
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await tmpCtx.decodeAudioData(buf.slice(0));
    } catch (e) {
      throw new Error(
        "无法解码这份音频：文件可能不是受支持的音频格式（MP3/M4A/WAV），" +
        "或下载不完整、被代理换成了错误页。可换一集再试；或改用 APK / 桌面版导入。"
      );
    } finally {
      if (tmpCtx.close) tmpCtx.close();
    }
    if (!decoded || decoded.length < 1 || decoded.duration <= 0) {
      throw new Error(
        "这段音频解码后是空的（文件可能被截断或不是真正的音频），" +
        "请换一集，或改用 APK / 桌面版导入。"
      );
    }
    const targetRate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const off = new OAC(1, frames, targetRate);
    // 先混单声道（用源采样率的 buffer），再由 OfflineAudioContext 重采样到 16k
    const mono = off.createBuffer(1, decoded.length, decoded.sampleRate);
    const tmp = mono.getChannelData(0);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < data.length; i++) tmp[i] += data[i] / decoded.numberOfChannels;
    }
    const src = off.createBufferSource();
    src.buffer = mono;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  // 推理后端探测：WebView 里 navigator.gpu 可能存在但拿不到 adapter（会抛/返回 null）
  async function detectBackend() {
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) return "webgpu";
      }
    } catch (e) { /* 无 GPU → WASM */ }
    return "wasm";
  }

  // 并行转写：与 transformers v2 内部 chunked 完全同构——30s 窗口、20s 步长
  // （hop = chunk − 2×stride，stride 5s 作防截断缓冲），多 worker 并行推理利用多核；
  // 合并时每块丢弃左右各 stride 区间（首块左 0、末块右 0），重叠区归前块。
  const WINDOW_S = 30;
  const STRIDE_S = 5;
  const HOP_S = WINDOW_S - 2 * STRIDE_S;
  async function transcribeParallel(repo, audio, onProgress) {
    const dur = audio.length / 16000;
    // worker 数按内存分级（每 worker 一份模型+推理缓冲），低端机避免 OOM
    const mem = navigator.deviceMemory || 8;
    const nW = Math.max(2, Math.min(mem >= 8 ? 4 : mem >= 4 ? 3 : 2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    const starts = [];
    for (let s = 0; s < dur; s += HOP_S) starts.push(s);
    const jobs = starts.map((s) => ({
      i: s / HOP_S,
      s,
      len: Math.min(WINDOW_S, dur - s) * 16000,
    }));
    const workers = [];
    for (let w = 0; w < nW; w++) workers.push(new Worker("transcribe-worker.js", { type: "module" }));
    const results = new Array(jobs.length);
    let done = 0;
    try {
      await new Promise((resolve, reject) => {
        let wi = 0;
        const busy = workers.map(() => false);
        let failed = false;
        const pump = () => {
          for (let w = 0; w < workers.length && !failed; w++) {
            if (busy[w] || wi >= jobs.length) continue;
            const j = jobs[wi++];
            busy[w] = true;
            workers[w].postMessage({
              id: j.i, repo, offsetSec: j.s,
              audio: audio.slice(j.s * 16000, j.s * 16000 + j.len),
            });
          }
          if (wi >= jobs.length && busy.every((b) => !b)) resolve();
        };
        workers.forEach((wk, w) => {
          wk.onmessage = (ev) => {
            const d = ev.data;
            busy[w] = false;
            if (failed) return;
            if (!d.ok) { failed = true; reject(new Error(d.error)); return; }
            results[d.id] = d.chunks;
            done++;
            onProgress("transcribe", done / jobs.length);
            pump();
          };
          wk.onerror = (e) => {
            if (!failed) { failed = true; reject(new Error("转写 Worker 异常: " + (e.message || ""))); }
          };
        });
        pump();
      });
    } finally {
      workers.forEach((w) => w.terminate());
    }
    // 合并：每块只保留 [s+left, s+len−right)（首块 left=0、末块 right=0），与 v2 内部去重一致
    const out = [];
    for (let i = 0; i < jobs.length; i++) {
      const s = i * HOP_S;
      const left = i === 0 ? 0 : STRIDE_S;
      const right = i === jobs.length - 1 ? 0 : STRIDE_S;
      const lo = s + left;
      const hi = s + Math.min(WINDOW_S, dur - s) - right;
      for (const c of results[i] || []) {
        if (c.start >= lo && c.start < hi) out.push(c);
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

// 首尾静音裁剪：播客/录音常带片头片尾空播（音乐/拖堂），裁掉后 Whisper 不用白跑那几十秒。
  // 50ms 窗口 RMS < 阈值视为静音；两头各留 300ms 余量；返回裁剪样本 + 前导秒数（回补时间戳）。
  function trimEdgeSilence(samples, rate = 16000) {
    const win = Math.floor(rate * 0.05);
    const th = 0.004;
    const rms = (from, n) => {
      let s = 0;
      const lim = Math.min(from + n, samples.length);
      for (let i = from; i < lim; i++) s += samples[i] * samples[i];
      return Math.sqrt(s / Math.max(1, lim - from));
    };
    let first = 0;
    while (first + win <= samples.length && rms(first, win) < th) first += win;
    let last = samples.length;
    while (last - win >= 0 && rms(last - win, win) < th) last -= win;
    if (last - first < win) return { samples, leadSec: 0 }; // 整段都“静音”的异常输入不裁
    let lo = Math.max(0, Math.floor(first - rate * 0.3));
    let hi = Math.min(samples.length, Math.floor(last + rate * 0.3));
    if (lo === 0 && hi === samples.length) return { samples, leadSec: 0 };
    return { samples: samples.slice(lo, hi), leadSec: lo / rate };
  }

  // transcribe：blob → [{text,start,end}]（秒）。onProgress(phase, frac, extra)
  async function transcribe(blob, opts) {
    opts = opts || {};
    const model = opts.model || "tiny.en";
    const onProgress = opts.onProgress || function () {};
    onProgress("model", 0);
    const repo = MODEL_MAP[model] || MODEL_MAP["tiny.en"];
    // 主线程先建 pipeline：负责模型下载进度上报；worker 复用同一份缓存（Cache API）
    const pipe = await getPipeline(model, (frac, file) => onProgress("model", frac, file));
    onProgress("decode", 0);
    const audio = await decodeAudio(blob);
    const { samples, leadSec } = trimEdgeSilence(audio);
    const addLead = (chunks) => chunks.map((c) => ({
      text: c.text,
      start: c.start + leadSec,
      end: c.end + leadSec,
      words: c.words ? c.words.map((x) => ({ w: x.w, s: x.s + leadSec, e: x.e + leadSec })) : null,
    }));
    onProgress("transcribe", 0);
    const dur = samples.length / 16000;
    if (opts.parallel !== false && dur > WINDOW_S && typeof Worker !== "undefined") {
      try {
        const chunks = await transcribeParallel(repo, samples, onProgress);
        onProgress("transcribe", 1);
        return addLead(chunks);
      } catch (e) {
        console.warn("并行转写失败，回退单线程:", e);
      }
    }
    const result = await pipe(samples, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    onProgress("transcribe", 1);
    const chunks = (result && result.chunks) || [];
    if (chunks.length) {
      return addLead(chunks.map((c) => {
        const s0 = c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0;
        const e0 = c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : 0;
        return {
          text: (c.text || "").trim(),
          start: s0, end: e0,
          words: chunkWords(c),
        };
      }).filter((c) => c.text));
    }
    return [{ text: ((result && result.text) || "").trim(), start: leadSec, end: leadSec + dur, words: null }];
  }

  window.dsImport = {
    isNative: () => !!cap(),
    detectKind, fetchFeed, parseRss, fetchText, fetchBlob,
    splitSentences, expandSegmentsBySentence, buildUnits, analyzeUnit,
    transcribe, loadTransformers, detectBackend, decodeAudio, trimEdgeSilence,
  };
})();
