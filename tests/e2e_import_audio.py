#!/usr/bin/env python3
"""Headless 端到端：RSS 导入 → 音频下载 → (mocked) 转写 → 逐句音频必须为 range 裁剪。

证明两件事：
  1. engine.js 在本地引擎模式下的导入链路（fetchFeed→podcast-episode→_transcribeAndBuild）
     产出的 unit.audio 是 kind:"range" + 精确 start/end（与桌面 server.py 一致）；
  2. end 缺失/非法时走 audio-contract 兜底（下一句起点或词数估算），
     即“一句播完不截断、继续往后播整段”的 bug 在两端都治好了。

转写被 mock（跳过 Whisper 模型下载）；不依赖外网。需要本机已装 chrome-headless-shell。
预备：python3 -m pip install websocket-client

用法：  python3 tests/e2e_import_audio.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import wave

try:
    import websocket
except ImportError:
    sys.exit("缺少 websocket-client：python3 -m pip install websocket-client")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")
CHROME = os.path.expanduser(
    "~/Library/Caches/ms-playwright/chromium_headless_shell-1234/"
    "chrome-headless-shell-mac-arm64/chrome-headless-shell"
)
PORT = 8767
CDP_PORT = 9335
MOCK_DIR = os.path.join(FRONTEND, "mock-test")


class CDP:
    def __init__(self, port):
        import urllib.request
        self.ws = None
        self.msg_id = 0
        for _ in range(60):
            try:
                targets = json.loads(urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/json", timeout=1).read())
                page = next(t for t in targets if t["type"] == "page")
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("CDP 连接失败")

    def send(self, method, params=None):
        self.msg_id += 1
        self.ws.send(json.dumps({"id": self.msg_id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.msg_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def eval(self, expr, await_promise=True):
        res = self.send("Runtime.evaluate", {
            "expression": expr, "awaitPromise": await_promise, "returnByValue": True,
        })
        val = res["result"]
        if val.get("subtype") == "error":
            raise RuntimeError(val.get("description") or val)
        return val.get("value")


def make_mock():
    os.makedirs(MOCK_DIR, exist_ok=True)
    wav_path = os.path.join(MOCK_DIR, "episode.wav")
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 16000 * 6)  # 6 秒静音
    with open(os.path.join(MOCK_DIR, "feed.xml"), "w", encoding="utf-8") as f:
        f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Mock Feed</title>
<item><title>Mock Episode</title>
<enclosure url="http://127.0.0.1:{PORT}/mock-test/episode.wav" type="audio/wav"/>
</item></channel></rss>""")


E2E_JS = r"""
(async () => {
  const E = window.DeepSpeakEngine;
  if (!E) return { fail: "engine 未加载" };
  // mock 转写：跳过 Whisper 模型下载；第一段故意不带靠谱 end 以触发回退
  const fakeSegs = [
    { text: "The world is a book.", start: 0.0, end: 0.0 },          // end 非法 → 应回退到下句起点
    { text: "Those who do not travel read only one page.", start: 1.5, end: 4.9 },
  ];
  window.dsImport.transcribe = async (blob, opts) => fakeSegs;

  // 1) RSS 导入成 draft
  const r1 = await E.api("POST", "/api/materials/url", { url: "mock-test/feed.xml" });
  if (!r1.ok) return { fail: "materials/url: " + JSON.stringify(r1) };
  const mid = r1.material.id;

  // 2) 选第一集 → mock 转写 → ready；轮询
  const m0 = await E.api("GET", `/api/materials/${mid}`);
  const epUrl = m0.material.source.episodes[0].url;
  await E.api("POST", `/api/materials/${mid}/podcast-episode`, { url: epUrl });
  let m, t = 0;
  do {
    await new Promise(r => setTimeout(r, 150));
    m = (await E.api("GET", `/api/materials/${mid}`)).material;
  } while (m.status === "processing" && ++t < 200);
  if (m.status !== "ready") return { fail: "转写未完成", status: m.status, error: m.source && m.source.error };

  const units = m.units.map(u => ({ seq: u.seq, text: u.text, audio: u.audio }));
  const au1 = units[0].audio, au2 = units[1].audio;

  // 契约期望值（同一份 audio-contract.js 在浏览器里直接算，保证自洽）
  const exp1 = window.dsAudioContract.resolveUnitRange(0, 0, units[0].text, 1500);
  const exp2 = window.dsAudioContract.resolveUnitRange(1500, 4900, units[1].text, 0);

  const verdict = {
    kind: [au1.kind, au2.kind],
    startsMs: [au1.start_ms, au2.start_ms],
    endsMs: [au1.end_ms, au2.end_ms],
    urlBlob: !!au1.url && au1.url.startsWith("blob:"),
    matchContract: au1.start_ms === exp1.start_ms && au1.end_ms === exp1.end_ms
      && au2.start_ms === exp2.start_ms && au2.end_ms === exp2.end_ms,
    kindAllBounded: [au1, au2].every(a => a.kind === "range" && a.end_ms > a.start_ms),
  };
  verdict.pass = verdict.matchContract && verdict.kindAllBounded && verdict.urlBlob;
  return verdict;
})()
"""


def main():
    make_mock()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", FRONTEND],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = subprocess.Popen(
        [CHROME, f"--remote-debugging-port={CDP_PORT}", "--remote-allow-origins=*",
         "--user-data-dir=" + tempfile.mkdtemp(prefix="ds-cdp-"), "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.5)
        cdp = CDP(CDP_PORT)
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        cdp.eval(f"location.href = 'http://127.0.0.1:{PORT}/'")
        time.sleep(7)  # 前端 + engine 加载
        verdict = cdp.eval(E2E_JS, await_promise=True)
        print(json.dumps(verdict, ensure_ascii=False, indent=2))
        if isinstance(verdict, dict) and verdict.get("pass"):
            print("\nE2E PASS: 逐句音频为 range 且与双端契约一致")
            return 0
        print("\nE2E FAIL")
        return 1
    finally:
        try:
            chrome.terminate()
            server.terminate()
        except Exception:
            pass
        for f in ("feed.xml", "episode.wav"):
            p = os.path.join(MOCK_DIR, f)
            if os.path.exists(p):
                os.remove(p)
        if os.path.isdir(MOCK_DIR):
            os.rmdir(MOCK_DIR)


if __name__ == "__main__":
    sys.exit(main())