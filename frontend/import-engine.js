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

  // 网页跨域代理：{proxy}URL 形式拼接（末尾带 = 或 ? 的代理直接前缀拼原始 URL）。
  function withProxy(url, proxy) {
    if (!proxy) return url;
    proxy = proxy.trim();
    if (!proxy) return url;
    // 形如 https://proxy/?url= 或 https://proxy/ → 前缀拼接（原始 URL 编码）
    if (/[?&=]$/.test(proxy)) return proxy + encodeURIComponent(url);
    if (proxy.endsWith("/")) return proxy + url;
    return proxy + "/" + url;
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
    const r = await fetch(withProxy(url, proxy), { redirect: "follow" });
    if (!r.ok) throw new Error(`网络请求失败 HTTP ${r.status}（跨域源可能需要在设置里配置 CORS 代理）`);
    return await r.text();
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
    const r = await fetch(withProxy(url, proxy), { redirect: "follow" });
    if (!r.ok) throw new Error(`音频下载失败 HTTP ${r.status}（跨域源可能需要 CORS 代理）`);
    const total = Number(r.headers.get("Content-Length") || 0);
    if (!r.body || !total) {
      const b = await r.blob();
      if (onProgress) onProgress(b.size, b.size || 0);
      return b;
    }
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }
    return new Blob(chunks, { type: r.headers.get("Content-Type") || "audio/mpeg" });
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

  // 移植 textproc.expand_segments_by_sentence：ASR chunk 按终止标点拆句、时间按词数比例分配
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

  // buildUnits：expand → analyze → 产出 engine.js 单元结构（ms 时间戳）
  function buildUnits(segments) {
    const timed = expandSegmentsBySentence(segments);
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
    // v2 系列（@xenova/transformers）：纯 WASM 起步，WebGPU 仅显式请求才启用，
    // 安卓 WebView 无 GPU adapter 时回退干净（v3.0.x 在 device 选择上有缺陷会崩）
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
    "https://unpkg.com/@xenova/transformers@2.17.2",
  ];
  let _tx = null;          // 已加载的 transformers 模块
  const _pipes = {};       // repo → pipeline

  async function loadTransformers() {
    if (_tx) return _tx;
    let lastErr = null;
    for (const cdn of TX_CDNS) {
      try {
        _tx = await import(/* @vite-ignore */ cdn);
        _tx.env.allowLocalModels = false;
        _tx.env.useBrowserCache = true; // 模型文件用浏览器 Cache API 缓存，二次离线可用
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
    let pipe;
    try {
      pipe = await tx.pipeline("automatic-speech-recognition", repo, { ...opts, device });
    } catch (e) {
      // WebGPU 不稳（安卓 WebView 常见）→ 回退 WASM
      pipe = await tx.pipeline("automatic-speech-recognition", repo, { ...opts, device: "wasm" });
    }
    _pipes[repo] = pipe;
    return pipe;
  }

  // 把音频 blob 解码为 16kHz 单声道 Float32Array（Whisper 输入要求）
  async function decodeAudio(blob) {
    const buf = await blob.arrayBuffer();
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await tmpCtx.decodeAudioData(buf.slice(0));
    } finally {
      if (tmpCtx.close) tmpCtx.close();
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
    onProgress("transcribe", 0);
    const dur = audio.length / 16000;
    if (opts.parallel !== false && dur > WINDOW_S && typeof Worker !== "undefined") {
      try {
        const chunks = await transcribeParallel(repo, audio, onProgress);
        onProgress("transcribe", 1);
        return chunks;
      } catch (e) {
        console.warn("并行转写失败，回退单线程:", e);
      }
    }
    const result = await pipe(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    onProgress("transcribe", 1);
    const chunks = (result && result.chunks) || [];
    if (chunks.length) {
      return chunks.map((c) => ({
        text: (c.text || "").trim(),
        start: c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0,
        end: c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : 0,
      })).filter((c) => c.text);
    }
    return [{ text: ((result && result.text) || "").trim(), start: 0, end: 0 }];
  }

  window.dsImport = {
    isNative: () => !!cap(),
    detectKind, fetchFeed, parseRss, fetchText, fetchBlob,
    splitSentences, expandSegmentsBySentence, buildUnits, analyzeUnit,
    transcribe, loadTransformers, detectBackend,
  };
})();
