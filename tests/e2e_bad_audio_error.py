#!/usr/bin/env python3
"""Headless 负向验证：网页导入遇到"假装是音频"的内容，报错必须是友好中文，而非裸英文
"Unable to decode audio data"（用户网页端实测踩到）。

两条路径：
  1. 代理/源站返回 HTML（text/html，魔数不对）→ 下载阶段魔数校验拦截，
     报错含「返回内容不是音频」；
  2. 声明是 audio/mpeg 但内容不是音频（常见于代理偷换/源站错误页）→ 魔数校验放行
     交给解码，decodeAudioData 失败 → 报错含「无法解码这份音频」而非英文原文。

需要本机已装 chrome-headless-shell（与 e2e_import_audio.py 相同）。
用法：  python3 tests/e2e_bad_audio_error.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

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
PORT = 8768
CDP_PORT = 9336
MOCK_DIR = os.path.join(FRONTEND, "mock-bad")


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
    TEST_PORT = PORT
    os.makedirs(MOCK_DIR, exist_ok=True)
    # 1) text/html：应被魔数校验拦下
    with open(os.path.join(MOCK_DIR, "html-page.html"), "w", encoding="utf-8") as f:
        f.write("<!DOCTYPE html><html><head><title>404</title></head><body>" +
                "<h1>Proxy Error</h1>" + ("<p>not an audio file</p>" * 200) + "</body></html>")
    # 2) 扩展名是 .mp3 但内容是纯文本：躲过魔数校验（声明 audio/mpeg），decode 时才暴露
    with open(os.path.join(MOCK_DIR, "fake.mp3"), "w", encoding="utf-8") as f:
        f.write("This is not audio data at all. It is just text pretending to be an mp3. " + ("x" * 5000))
    html_abs = f"http://127.0.0.1:{TEST_PORT}/mock-bad/html-page.html"
    mp3_abs = f"http://127.0.0.1:{TEST_PORT}/mock-bad/fake.mp3"
    # 两个独立 feed，各指向一个坏音频
    with open(os.path.join(MOCK_DIR, "feed-page.xml"), "w", encoding="utf-8") as f:
        f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Bad Feed 1</title>
<item><title>Ep HTML</title><enclosure url="{html_abs}" type="text/html"/></item>
</channel></rss>""")
    with open(os.path.join(MOCK_DIR, "feed-mp3.xml"), "w", encoding="utf-8") as f:
        f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Bad Feed 2</title>
<item><title>Ep Fake MP3</title><enclosure url="{mp3_abs}" type="audio/mpeg"/></item>
</channel></rss>""")


E2E_JS = r"""
(async () => {
  const E = window.DeepSpeakEngine;
  if (!E) return { fail: "engine 未加载" };
  // 假转写：先走真实解码（验证 decode 兜底报友好错），解码若能过再显式报错“不应走到转写”
  window.dsImport.transcribe = async (blob) => {
    await window.dsImport.decodeAudio(blob); // 坏音频在此抛“无法解码这份音频”
    throw new Error("不应走到转写（坏音频）");
  };

  const run = async (feedPath) => {
    const r1 = await E.api("POST", "/api/materials/url", { url: feedPath });
    if (!r1.ok) return { fail: "materials/url: " + JSON.stringify(r1) };
    const mid = r1.material.id;
    const m0 = await E.api("GET", `/api/materials/${mid}`);
    const epUrl = m0.material.source.episodes[0].url;
    await E.api("POST", `/api/materials/${mid}/podcast-episode`, { url: epUrl });
    let m, t = 0;
    do {
      await new Promise(r => setTimeout(r, 150));
      m = (await E.api("GET", `/api/materials/${mid}`)).material;
    } while (m.status === "processing" && ++t < 200);
    return { mid, status: m.status, error: (m.source && m.source.error) || "" };
  };

  const p1 = await run("mock-bad/feed-page.xml");  // 步骤：魔数拦截
  const p2 = await run("mock-bad/feed-mp3.xml");   // 步骤二：解码兜底

  const good = (e) => e && e.length > 0
    && !e.includes("Unable to decode audio data");
  const verdict = {
    htmlStatus: p1.status,
    htmlMsg: p1.error,
    htmlFriendly: good(p1.error) && p1.error.includes("不是音频"),
    mp3Status: p2.status,
    mp3Msg: p2.error,
    mp3Friendly: good(p2.error) && p2.error.includes("无法解码这份音频"),
  };
  verdict.pass = p1.status === "error" && verdict.htmlFriendly
    && p2.status === "error" && verdict.mp3Friendly;
  // 顺手删掉两个坏材料，避免污染后续 E2E 的数据
  try { await E.api("DELETE", `/api/materials/${p1.mid}`); } catch (e) {}
  try { await E.api("DELETE", `/api/materials/${p2.mid}`); } catch (e) {}
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
        time.sleep(7)
        verdict = cdp.eval(E2E_JS, await_promise=True)
        print(json.dumps(verdict, ensure_ascii=False, indent=2))
        if isinstance(verdict, dict) and verdict.get("pass"):
            print("\nE2E PASS: 坏音频内容被友好拦截，不出现 Unable to decode")
            return 0
        print("\nE2E FAIL")
        return 1
    finally:
        try:
            chrome.terminate()
            server.terminate()
        except Exception:
            pass
        for f in os.listdir(MOCK_DIR) if os.path.isdir(MOCK_DIR) else []:
            os.remove(os.path.join(MOCK_DIR, f))
        if os.path.isdir(MOCK_DIR):
            os.rmdir(MOCK_DIR)


if __name__ == "__main__":
    sys.exit(main())