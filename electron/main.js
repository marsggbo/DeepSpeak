// DeepSpeak 桌面壳（Electron 主进程）
// 职责：选空闲端口 → 拉起 PyInstaller 侧车（--port --no-browser）→ 等健康检查 → 开窗口 → 退出时杀侧车。
const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");

let win = null;
let sidecar = null;
let serverPort = null;
let quitting = false;

// ---------- 端口 ----------
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------- 侧车 ----------
function sidecarCommand() {
  if (app.isPackaged) {
    // extraResources: resources/deepspeak-server/
    const base = path.join(process.resourcesPath, "deepspeak-server");
    const exe = process.platform === "win32"
      ? path.join(base, "deepspeak-server.exe")
      : path.join(base, "deepspeak-server");
    return { cmd: exe, args: [], cwd: base };
  }
  // 开发模式：直接用项目 .venv 跑源码后端
  const proj = path.join(__dirname, "..");
  const py = process.platform === "win32"
    ? path.join(proj, ".venv", "Scripts", "python.exe")
    : path.join(proj, ".venv", "bin", "python");
  return { cmd: py, args: ["-m", "backend.server"], cwd: proj };
}

function startSidecar() {
  const { cmd, args, cwd } = sidecarCommand();
  sidecar = spawn(cmd, [...args, "--port", String(serverPort), "--no-browser"], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 侧车日志写进用户数据目录，便于排查
  const logPath = path.join(app.getPath("userData"), "sidecar.log");
  const log = fs.createWriteStream(logPath, { flags: "a" });
  sidecar.stdout.pipe(log);
  sidecar.stderr.pipe(log);

  sidecar.on("exit", (code) => {
    if (!quitting) {
      dialog.showErrorBox(
        "DeepSpeak 后端意外退出",
        `内置后端进程已退出（code=${code}）。\n日志：${logPath}`
      );
      app.quit();
    }
  });
  return logPath;
}

function killSidecar() {
  if (!sidecar) return;
  const pid = sidecar.pid;
  if (process.platform === "win32") {
    // Windows：taskkill /T 连子进程一起杀（Python 侧车常带子进程）
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } else {
    try { sidecar.kill("SIGTERM"); } catch (e) {}
    // SIGTERM 后 2 秒未退则强杀
    const killer = setTimeout(() => {
      try { sidecar.kill("SIGKILL"); } catch (e) {}
    }, 2000);
    killer.unref();
  }
}

function waitHealthy(timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (quitting) return;
      fetch(`http://127.0.0.1:${serverPort}/api/health`)
        .then((r) => r.json())
        .then((h) => {
          if (h && h.ok) return resolve(h);
          throw new Error("not ready");
        })
        .catch(() => {
          if (Date.now() > deadline) return reject(new Error("backend start timeout"));
          setTimeout(tick, 400);
        });
    };
    tick();
  });
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "DeepSpeak",
    icon: path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.icns"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  win.on("closed", () => { win = null; });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      serverPort = await pickPort();
      const logPath = startSidecar();
      await waitHealthy(120000);
      console.log(`[deepspeak] 后端就绪 http://127.0.0.1:${serverPort}（日志 ${logPath}）`);
      createWindow();
    } catch (err) {
      dialog.showErrorBox("DeepSpeak 启动失败", String(err));
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    killSidecar();
  });
}
