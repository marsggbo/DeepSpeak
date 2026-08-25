// DeepSpeak 转写 Worker：多核并行 Whisper 推理。
// WebView 无跨源隔离（拿不到 SharedArrayBuffer），WASM 无法多线程；
// 多 worker 并行是移动端唯一能利用多核的路径（每个 worker 一份量化模型）。
self.onmessage = async (ev) => {
  const { id, repo, audio, offsetSec } = ev.data;
  try {
    const pipe = await getPipeline(repo);
    // 必须走 chunked 路径（chunk_length_s）才有 chunks 时间戳输出；块内 30s 只产生一块
    const r = await pipe(audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
    let chunks = ((r && r.chunks) || []).map((c) => {
      const words = chunkWords(c);
      return {
        text: (c.text || "").trim(),
        start: (c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0) + offsetSec,
        end: (c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : 0) + offsetSec,
        words: words ? words.map((x) => ({ w: x.w, s: x.s + offsetSec, e: x.e + offsetSec })) : null,
      };
    }).filter((c) => c.text);
    if (!chunks.length && r && r.text) {
      chunks = [{ text: r.text.trim(), start: offsetSec, end: offsetSec, words: null }];
    }
    self.postMessage({ id, ok: true, chunks });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};

// 从 whisper chunk 提词级时间戳（与 import-engine.js 的 chunkWords 保持同一份实现；
// worker 是独立文件无法 import 页面脚本，改动时两边同步）
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

let _pipe = null;
const TX_CDNS = [
  // 本地 vendor 优先（与 APK 一起打包，离线可用）；失败再走 CDN 兜底
  "./vendor/transformers@2.17.2.js",
  "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
  "https://unpkg.com/@xenova/transformers@2.17.2",
];

async function getPipeline(repo) {
  if (_pipe) return _pipe;
  let lastErr = null;
  for (let i = 0; i < TX_CDNS.length; i++) {
    const cdn = TX_CDNS[i];
    try {
      const tx = await import(cdn);
      tx.env.allowLocalModels = true; // APK 内置模型直接本地读；无本地文件自动回退远程
      tx.env.localModelPath = "/models/";
      tx.env.useBrowserCache = true; // 模型文件走 Cache API，主线程下载过即命中
      if (i === 0) {
        // 本地 vendor：onnxruntime wasm 内核随包提供（库默认指向 jsdelivr，离线会挂）
        tx.env.backends.onnx.wasm.wasmPaths = "./vendor/";
      }
      _pipe = await tx.pipeline("automatic-speech-recognition", repo, { device: "wasm" });
      return _pipe;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("语音识别库加载失败");
}
