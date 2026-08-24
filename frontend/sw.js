/* DeepSpeak Service Worker — 离线优先 PWA 缓存
   策略：
   - 应用壳（HTML/CSS/JS/manifest）→ 预缓存 + stale-while-revalidate
   - 音频 .wav → cache-first（听过一次即可离线回放）
   - /api/ → 永远走网络（后端模式数据不落缓存）
   所有 URL 均为相对路径解析，GitHub Pages 子路径部署同样可用。
   发布新版本时递增 CACHE 版本号即可整体刷新。 */
const CACHE = "deepspeak-v15";
const PRECACHE = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./engine.js",
  "./engine-data.js",
  "./import-engine.js",
  "./transcribe-worker.js",
  "./tts-engine.js",
  "./recorder.js",
  "./manifest.webmanifest",
];

// 强制从网络拿新鲜副本（cache:"reload" 绕过浏览器 HTTP 缓存，避免 304 导致 SW 缓存永不过期）
function fresh(url) {
  return fetch(url, { cache: "reload" }).then((res) =>
    res.ok ? res : Promise.reject(new Error("HTTP " + res.status))
  );
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) =>
        Promise.allSettled(
          PRECACHE.map((u) =>
            fresh(u).then((res) => c.put(u, res)).catch(() => {})
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 后端 API 绝不缓存
  if (url.pathname.includes("/api/")) return;

  const isAudio = url.pathname.endsWith(".wav");
  const isNav = req.mode === "navigate";

  if (isAudio) {
    // cache-first：播放过的音频离线可回放
    e.respondWith(
      caches.match(req).then((hit) => hit || fresh(req).then((res) => {
        const clone = res.clone();
        return caches.open(CACHE).then((c) => c.put(req, clone)).then(() => res);
      }).catch(() => {
        // 离线且未缓存过：尝试返回任何已缓存页面兜底，音频失败留给页面处理
        return caches.match("./index.html");
      }))
    );
    return;
  }

  // 静态资源与导航：stale-while-revalidate（后台用新鲜副本刷新缓存）
  e.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fresh(req).then((res) => {
        const clone = res.clone();
        return caches.open(CACHE).then((c) => c.put(req, clone)).then(() => res);
      }).catch(() => null);
      if (hit) return hit; // 后台已在更新缓存，下次生效
      return refresh.then((res) => res || (isNav ? caches.match("./index.html") : undefined));
    })
  );
});
