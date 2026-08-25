#!/usr/bin/env python3
"""Headless 冒烟：模型/库离线可用（APK 内置场景）。

验证链路与 APK 一致：transformers@2.17.2 从本地 vendor/ 加载、
onnxruntime wasm 从本地 vendor/ 加载、whisper 模型从 /models/ 读取
（此测试里由双根静态服务器模拟），**全程不允许出现任何外网请求**
（huggingface / jsdelivr / unpkg / hf-mirror 均断言为零）。

用法： python3 tests/e2e_offline_models.py
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

try:
    import websocket
except ImportError:
    sys.exit("缺少 websocket-client：python3 -m pip install websocket-client")

import http.server

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")
MODELS = os.path.join(ROOT, "models-js")
CHROME = os.path.expanduser(
    "~/Library/Caches/ms-playwright/chromium_headless_shell-1234/"
    "chrome-headless-shell-mac-arm64/chrome-headless-shell"
)
PORT = 8771
CDP_PORT = 9338


class DualRootHandler(http.server.SimpleHTTPRequestHandler):
    """/models/ → models-js/，其余 → frontend/（模拟 APK 内 assets 布局）"""

    def translate_path(self, path):
        if path.startswith("/models/"):
            rel = path[len("/models/"):]
            return os.path.join(MODELS, rel.lstrip("/"))
        return os.path.join(FRONTEND, path.lstrip("/"))

    def log_message(self, *a):
        pass


class CDP:
    def __init__(self, port):
        self.n = 0
        self.reqs = []  # 全部网络请求 URL
        for _ in range(60):
            try:
                targets = json.loads(urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/json", timeout=1).read())
                page = next(t for t in targets if t["type"] == "page")
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
                self.send("Network.enable")
                return
            except Exception:
                time.sleep(0.5)
        raise AssertionError("无法连接 CDP")

    def send(self, method, params=None):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("method") == "Network.requestWillBeSent":
                url = r["params"]["request"]["url"]
                if url.lower().startswith("http"):
                    self.reqs.append(url)
            if r.get("id") == self.n:
                return r.get("result", {})

    def evaluate(self, expr, await_promise=True, timeout=180):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": "Runtime.evaluate", "params": {
            "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
        }}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("method") == "Network.requestWillBeSent":
                u = r["params"]["request"]["url"]
                if u.startswith("http"):
                    self.reqs.append(u)
            if r.get("id") == self.n:
                if r.get("error"):
                    raise AssertionError("CDP error: " + json.dumps(r["error"])[:300])
                inner = r.get("result") or {}
                if inner.get("exceptionDetails"):
                    raise AssertionError("evaluate 异常: " + json.dumps(
                        inner["exceptionDetails"], ensure_ascii=False)[:500])
                return (inner.get("result") or {}).get("value")
                # Runtime.evaluate 返回 {result: {result: {type,value}}}


def main():
    server = http.server.HTTPServer(("127.0.0.1", PORT), DualRootHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    subprocess.run(["pkill", "-f", f"remote-debugging-port={CDP_PORT}"], stderr=subprocess.DEVNULL)
    time.sleep(0.3)
    chrome = subprocess.Popen(
        [CHROME, f"--remote-debugging-port={CDP_PORT}", "--remote-allow-origins=*",
         "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(1)
        cdp = CDP(CDP_PORT)
        cdp.evaluate(f'location.href = "http://127.0.0.1:{PORT}/index.html"', await_promise=False)
        # 等真实页面加载完成（about:blank 里 fetch 本地服务器会被 CORS 拦）
        t0 = time.time()
        while time.time() - t0 < 30:
            try:
                if cdp.evaluate('location.hostname === "127.0.0.1" && document.readyState === "complete"', await_promise=False):
                    break
            except Exception:
                pass
            time.sleep(0.4)
        else:
            raise AssertionError("页面加载超时")

        # 1. /models 由本机服务器提供（模拟 APK assets）
        ok = cdp.evaluate("fetch('/models/Xenova/whisper-tiny.en/config.json').then(r => r.ok)")
        assert ok, "本地 /models/ 模型文件不可达"
        print("[1/4] PASS 本机 /models/ 模型文件可达")

        # 2. 本地 vendor 库 + 本地模型构建 pipeline（真实转写，全程无外网）
        result = cdp.evaluate("""
          (async () => {
            const tx = await import("./vendor/transformers@2.17.2.js");
            tx.env.allowLocalModels = true;
            tx.env.localModelPath = "/models/";
            tx.env.backends.onnx.wasm.wasmPaths = "./vendor/";
            const pipe = await tx.pipeline("automatic-speech-recognition",
              "Xenova/whisper-tiny.en", { device: "wasm", quantized: true });
            const sr = 16000, dur = 8.0, n = Math.floor(sr * dur);
            const audio = new Float32Array(n);
            for (let i = 0; i < n; i++) audio[i] = 0.03 * Math.sin(2 * Math.PI * 220 * i / sr);
            const r = await pipe(audio, { return_timestamps: true });
            return { text: (r && r.text) || "", chunks: ((r && r.chunks) || []).length };
          })()
        """)
        assert isinstance(result, dict) and "text" in result, result
        print(f"[2/4] PASS 本地 pipeline 构建并完成推理（text={result['text']!r}, chunks={result['chunks']}）")

        # 3. 本地库+本地 wasm 确实被用了（库文件真的从 /vendor 加载）
        v = cdp.evaluate("fetch('/vendor/transformers@2.17.2.js').then(r => r.status)")
        assert v == 200
        print("[3/4] PASS vendor 库/wasm 文件就位")

        # 4. 全程零外网请求
        bad = [u for u in cdp.reqs
               if any(d in u for d in ("huggingface", "jsdelivr", "unpkg", "hf-mirror"))]
        print(f"      （本地请求 {len(cdp.reqs)} 条，外网 {len(bad)} 条）")
        assert not bad, "出现外网请求: " + ", ".join(bad[:5])
        print("[4/4] PASS 全程零外网请求（离线可用）")

        print("\nSMOKE PASS: 离线模型链路 4 项断言全过")
        return 0
    except Exception as e:
        print("SMOKE FAIL:", e)
        return 1
    finally:
        try:
            chrome.terminate()
        except Exception:
            pass
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())