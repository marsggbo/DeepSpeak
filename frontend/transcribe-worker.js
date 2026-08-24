// DeepSpeak 转写 Worker：多核并行 Whisper 推理。
// WebView 无跨源隔离（拿不到 SharedArrayBuffer），WASM 无法多线程；
// 多 worker 并行是移动端唯一能利用多核的路径（每个 worker 一份量化模型）。
self.onmessage = async (ev) => {
  const { id, repo, audio, offsetSec } = ev.data;
  try {
    const pipe = await getPipeline(repo);
    // 必须走 chunked 路径（chunk_length_s）才有 chunks 时间戳输出；块内 30s 只产生一块
    const r = await pipe(audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
    let chunks = ((r && r.chunks) || []).map((c) => ({
      text: (c.text || "").trim(),
      start: (c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0) + offsetSec,
      end: (c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : 0) + offsetSec,
    })).filter((c) => c.text);
    if (!chunks.length && r && r.text) {
      chunks = [{ text: r.text.trim(), start: offsetSec, end: offsetSec }];
    }
    self.postMessage({ id, ok: true, chunks });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};

let _pipe = null;
const TX_CDNS = [
  "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
  "https://unpkg.com/@xenova/transformers@2.17.2",
];

async function getPipeline(repo) {
  if (_pipe) return _pipe;
  let lastErr = null;
  for (const cdn of TX_CDNS) {
    try {
      const tx = await import(cdn);
      tx.env.allowLocalModels = false;
      tx.env.useBrowserCache = true; // 模型文件走 Cache API，主线程下载过即命中
      _pipe = await tx.pipeline("automatic-speech-recognition", repo, { device: "wasm" });
      return _pipe;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("语音识别库加载失败");
}
