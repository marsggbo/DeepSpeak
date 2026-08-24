// 纯浏览器 Kokoro 神经 TTS（网页版 + Android APK 共用，行为对齐桌面 backend/tts_engine_kokoro.py）。
// 用 kokoro-js（Kokoro v1.0 官方 ONNX 模型的 JS 移植）：espeak-ng 音素器 + onnxruntime-web
// 全部编译成 WASM，不碰 WebGPU，Android WebView 可用；q8 量化模型 ~114MB，首次使用时
// 从 HF CDN 下载（HTTP 缓存命中后再次加载约 3s），合成结果缓存 IndexedDB（对齐桌面文件缓存）。
// 模型下载需要联网；合成本身完全本地。
(() => {
  const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
  const KOKORO_CDNS = [
    "https://cdn.jsdelivr.net/npm/kokoro-js@1/+esm",
    "https://unpkg.com/kokoro-js@1/+esm",
  ];

  // 音色表与桌面 tts_engine_kokoro.py 的 _EN_VOICES / _EN_LOCALE 完全一致
  const EN_VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  ];
  const LEGACY_VOICES = { Samantha: "af_heart", Daniel: "am_michael" };
  const DEFAULT_VOICE = "af_heart";

  // ---- IndexedDB（与 engine.js 同一个库/表，blob 可直接复用） ----
  let _db = null;
  function openDB() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open("deepspeak-local", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("kv"); };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }
  function idbGet(key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  function idbSet(key, val) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  let _tts = null; // KokoroTTS 实例（模型加载后复用）
  let _ttsPromise = null;
  const _memCache = {}; // key → Promise<{url, duration_ms}>（同句并发只合成一次）

  function listVoices() {
    return EN_VOICES.map((v) => ({
      name: v,
      locale: v.startsWith("af_") || v.startsWith("am_") ? "en-US" : "en-GB",
    }));
  }

  function resolveVoice(voice) {
    if (EN_VOICES.includes(voice)) return voice;
    return LEGACY_VOICES[voice] || DEFAULT_VOICE;
  }

  function speedForRate(rate) {
    return Math.max(0.5, Math.min(2.0, (rate || 175) / 175.0));
  }

  function safeName(s) {
    const n = String(s).normalize("NFKD").toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return n.slice(0, 40) || "audio";
  }

  function loadTts(onProgress) {
    if (_tts) return Promise.resolve(_tts);
    if (_ttsPromise) return _ttsPromise;
    _ttsPromise = (async () => {
      let mod = null, lastErr = null;
      for (const cdn of KOKORO_CDNS) {
        try { mod = await import(cdn); break; } catch (e) { lastErr = e; }
      }
      if (!mod) throw new Error("无法加载 kokoro-js: " + ((lastErr && lastErr.message) || lastErr));
      const tts = await mod.KokoroTTS.from_pretrained(KOKORO_REPO, {
        dtype: "q8",
        progress_callback: onProgress
          ? (p) => onProgress({ phase: "model", status: p && p.status, file: p && p.file, loaded: p && p.loaded, total: p && p.total })
          : undefined,
      });
      _tts = tts;
      return tts;
    })();
    _ttsPromise.catch(() => { _ttsPromise = null; }); // 失败允许重试
    return _ttsPromise;
  }

  // Float32Array(24kHz) → 16bit PCM mono WAV blob（对齐桌面 synthesize 的 WAV 输出）
  function floatToWav(f32, sr) {
    const n = f32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); wstr(8, "WAVE");
    wstr(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); // PCM mono
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  /** 合成一句话：{voice, rate} → {url(objectURL), duration_ms}。同 (voice, rate, text) 只合成一次（IndexedDB 缓存）。 */
  async function synthesize(text, voice, rate, onProgress) {
    if (!text || !text.trim()) return null;
    const v = resolveVoice(voice);
    const key = `tts_kokoro_${v}_${rate || 175}_${safeName(text)}`;
    if (_memCache[key]) return _memCache[key];
    _memCache[key] = (async () => {
      const cached = await idbGet(key);
      if (cached && cached.blob && cached.duration_ms) {
        return { url: URL.createObjectURL(cached.blob), duration_ms: cached.duration_ms };
      }
      const tts = await loadTts(onProgress);
      const res = await tts.generate(text, { voice: v, speed: speedForRate(rate) });
      const sr = res.sampling_rate || 24000;
      const blob = floatToWav(res.audio, sr);
      const duration_ms = Math.round((res.audio.length / sr) * 1000);
      try { await idbSet(key, { blob, duration_ms }); } catch (e) { /* 缓存失败不阻塞播放 */ }
      return { url: URL.createObjectURL(blob), duration_ms };
    })();
    return _memCache[key];
  }

  window.dsTts = { listVoices, synthesize, resolveVoice };
})();
