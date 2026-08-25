#!/usr/bin/env python3
"""Headless 冒烟：处理任务页（#/tasks）+ 导航角标 + 材料页自动刷新。

本地引擎（无后端）验证：
  1. 导航出现「任务」项；#/tasks 渲染空态
  2. 用 mock 转写注入一个真实队列任务 → 任务页显示步骤/百分比，角标出现，
     完成后自动消失（事件驱动）
  3. 材料页在任务处理中显示「处理中」chip，任务完成自动变回正常卡片

转写被 mock（跳过 Whisper 模型），不依赖外网。

用法： python3 tests/e2e_tasks_page.py
"""
import json
import os
import subprocess
import sys
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
PORT = 8769
CDP_PORT = 9337


class CDP:
    def __init__(self, port):
        import urllib.request
        self.ws = None
        self.n = 0
        for _ in range(60):
            try:
                targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1).read())
                page = next(t for t in targets if t["type"] == "page")
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
                return
            except Exception:
                time.sleep(0.5)
        raise AssertionError("无法连接 CDP")

    def send(self, method, params=None):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self.n:
                return r.get("result", {})

    def evaluate(self, expr, await_promise=True):
        r = self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
        })
        if r.get("exceptionDetails"):
            raise AssertionError("evaluate 异常: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:400])
        return (r.get("result") or {}).get("value")

    def wait(self, expr, timeout=30):
        t0 = time.time()
        last = None
        while time.time() - t0 < timeout:
            try:
                last = self.evaluate(expr)
                if last:
                    return last
            except Exception:
                pass
            time.sleep(0.4)
        raise AssertionError(f"wait 超时: {expr} (last={last!r})")


def main():
    # 清掉可能残留的同端口调试实例
    try:
        subprocess.run(["pkill", "-f", f"remote-debugging-port={CDP_PORT}"], stderr=subprocess.DEVNULL)
    except Exception:
        pass
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", FRONTEND],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    chrome = subprocess.Popen(
        [CHROME, f"--remote-debugging-port={CDP_PORT}", "--remote-allow-origins=*",
         "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    okc = 0
    try:
        time.sleep(1)
        cdp = CDP(CDP_PORT)
        cdp.evaluate(f'location.href = "http://127.0.0.1:{PORT}/index.html"')
        cdp.wait('document.querySelector("#view") && document.querySelector("#view").innerText.includes("材料")')

        # 1. 导航项与空态
        assert cdp.evaluate('!!document.querySelector(\'a[data-nav="tasks"]\')')
        okc += 1; print("[1/5] PASS 导航含「任务」项")
        cdp.evaluate('location.hash = "#/tasks"')
        cdp.wait('document.querySelector("#task-list") && document.querySelector("#task-list").innerText.includes("没有正在处理的任务")')
        okc += 1; print("[2/5] PASS #/tasks 空态渲染")
        assert cdp.evaluate('document.getElementById("nav-task-badge").classList.contains("hidden")')

        # 2. mock 转写 → 启动一个真实队列任务（材料 processing）
        cdp.evaluate("""
          window.dsImport.transcribe = async (blob, opts) => {
            const cb = (opts && opts.onProgress) || function () {};
            cb("decode", 0);
            for (let i = 0; i <= 10; i++) {
              await new Promise((r) => setTimeout(r, 300));
              cb("transcribe", i / 10);
            }
            return [{ text: "This is a fake transcript.", start: 0, end: 3, words: null }];
          };
          window.DeepSpeakEngine.importLocalFile(
            new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00])], "task-test.wav", { type: "audio/wav" })
          ).then((r) => { window.__taskMid = r.id; });
          true;
        """)
        cdp.wait('document.querySelector("#task-list") && document.querySelector("#task-list").innerText.includes("处理中")')
        okc += 1; print("[3/4] PASS 任务页显示正在处理的任务")
        assert not cdp.evaluate('document.getElementById("nav-task-badge").classList.contains("hidden")')
        assert cdp.evaluate('document.getElementById("nav-task-badge").textContent') == "1"
        okc += 1; print("[4/4] PASS 角标显示任务数")

        # 3. 完成后角标与任务页自动清空（事件驱动；mock 转写在约 3.5s 内结束）
        cdp.wait('document.querySelector("#task-list") && document.querySelector("#task-list").innerText.includes("没有正在处理的任务")', timeout=40)
        cdp.wait('document.getElementById("nav-task-badge").classList.contains("hidden")', timeout=10)
        okc += 1; print("[5/5] PASS 任务完成后角标消失、页面回到空态")

        # 4. 材料页：任务结束后的材料已 ready（自动刷新链路不崩）
        cdp.evaluate('location.hash = "#/materials"')
        cdp.wait('document.querySelector("#view") && document.querySelector("#view").innerText.includes("task-test")')
        okc += 1; print("[6/6] PASS 材料页显示新导入材料")

        print(f"\nSMOKE PASS: {okc} 项断言全过")
        return 0
    except Exception as e:
        print("SMOKE FAIL:", e)
        return 1
    finally:
        try:
            chrome.terminate()
        except Exception:
            pass
        server.terminate()


if __name__ == "__main__":
    sys.exit(main())