/* DeepSpeak 前端主应用 */
"use strict";

/* ================= API ================= */
// 后端(桌面版 127.0.0.1:8531)与本地引擎(PWA/GitHub Pages/离线)透明切换：
// fetch 网络失败或返回非 JSON 的 404(静态托管无后端)→ 自动降级本地引擎(IndexedDB)。
let dsLocalEngine = null;
function useLocalEngine() {
  if (dsLocalEngine) return dsLocalEngine;
  if (!window.DeepSpeakEngine) return null;
  dsLocalEngine = window.DeepSpeakEngine;
  console.warn("未检测到后端服务，已切换到本地引擎（数据存于浏览器 IndexedDB）");
  toast("离线模式：数据保存在本机浏览器", "warn");
  return dsLocalEngine;
}
async function api(path, opts) {
  opts = opts || {};
  // 已确认本地模式：直接走本地引擎，不再探测后端
  if (dsLocalEngine) return dsLocalEngine.api(opts.method || "GET", path, opts.body);
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  if (opts.formData) {
    init.body = opts.formData;
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    // 网络失败（file:// 协议、离线）→ 本地引擎
    const eng = useLocalEngine();
    if (eng) return eng.api(init.method, path, opts.body);
    throw e;
  }
  let data = null;
  let isJson = false;
  try { data = await res.json(); isJson = true; } catch (e) { /* 非 JSON */ }
  if (!res.ok || !isJson) {
    // 无后端环境 → 本地引擎。覆盖三种形态：
    //   404 + HTML（GitHub Pages 静态托管 / 本机无 API）
    //   200 + HTML（Capacitor APK 的 SPA fallback 把未知路径回退到 index.html）
    //   网络错误（离线，已在上方 catch）
    if (!isJson) {
      const eng = useLocalEngine();
      if (eng) return eng.api(init.method, path, opts.body);
    }
    const msg = (data && data.error) || `请求失败 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ================= 工具 ================= */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function toast(msg, type) {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast" + (type ? " " + type : "");
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

function modal(html, { wide } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-mask"><div class="modal"${wide ? ' style="max-width:760px"' : ""}>${html}</div></div>`;
  const mask = $(".modal-mask", root);
  mask.addEventListener("click", (e) => { if (e.target === mask) closeModal(); });
  return mask;
}
function closeModal() { $("#modal-root").innerHTML = ""; }

const STATUS_LABEL = {
  NEW: "新", LISTENING: "盲听", DICTATION: "听写", REVEALED: "对照",
  UNDERSTOOD: "理解", SHADOWING: "跟读", ACTIVE_RECALL: "回忆",
  REVIEW_DUE: "待复习", MASTERED: "已掌握",
};

const FOCUS_STATUS_LABEL = {
  new: "未开始", listening: "通听中", dictation: "听写中", shadowing: "跟读中",
  offscript: "脱稿中", review_due: "待复习", mastered: "已练透",
};

const FOCUS_STEPS = [
  { key: "listen", label: "通听", icon: "🎧", desc: "不看文字，反复听整段，直到每个词都清晰" },
  { key: "dictation", label: "听写", icon: "✍️", desc: "逐句暂停，把听到的如实写下来；听不出的先空着" },
  { key: "shadowing", label: "跟读", icon: "🗣️", desc: "听一句模仿一句，熟练后整段同步跟读" },
  { key: "offscript", label: "脱稿", icon: "📖", desc: "合上文本，跟着原声节奏自己念出来" },
];

/* ================= 音频播放 ================= */
let audioEl = null;
let audioTimer = null;

function stopPlay() {
  if (audioTimer) { clearInterval(audioTimer); audioTimer = null; }
  if (audioEl) { audioEl.__dead = true; audioEl.pause(); audioEl.src = ""; audioEl = null; }
}

function playUnit(unit, { loop = false, rate = 1.0, onEnd } = {}) {
  stopPlay();
  const info = unit.audio;
  if (!info || !info.url) { toast("该单元没有音频", "error"); return; }
  const audio = new Audio(info.url);
  audio.__dead = false;
  audioEl = audio;
  audio.playbackRate = rate;
  const startMs = info.start_ms || 0;
  const endMs = info.end_ms || 0;
  const isRange = info.kind === "range" && endMs > startMs;
  // 进度条基准：range 播放时从 0 开始显示本句时长（0 = 句首）
  audio.__range = isRange ? { start: startMs / 1000, end: endMs / 1000 } : null;

  audio.addEventListener("loadedmetadata", () => {
    if (audio.__dead) return; // 已被路由切换清理，不再播放
    if (isRange && startMs > 0 && audio.duration > 0.1) {
      audio.currentTime = startMs / 1000;
    }
    audio.play().catch(() => toast("播放失败，浏览器可能不支持该音频格式", "error"));
  });
  audio.addEventListener("error", () => {
    if (audio.__dead) return; // 切页清理导致的加载中断不提示
    toast("音频加载失败（可能仍在生成中，请稍候重试）", "error");
  });

  if (isRange) {
    audioTimer = setInterval(() => {
      if (!audio.currentTime) return;
      if (audio.currentTime >= endMs / 1000 - 0.06) {
        if (loop) {
          audio.currentTime = startMs / 1000;
          audio.play();
        } else {
          audio.pause();
          if (onEnd) onEnd();
        }
      }
    }, 80);
  } else {
    audio.addEventListener("ended", () => {
      if (loop) audio.play();
      else if (onEnd) onEnd();
    });
  }
  return audio;
}

/* ================= 录音 + 转写 ================= */
let _healthCache = null;
async function getHealth() {
  if (!_healthCache) _healthCache = await api("/api/health");
  return _healthCache;
}

function recordUI(container, onText, opts = {}) {
  /* 返回 {destroy}；录音完成后 onText(text)。compact：只显示 🎤 按钮（无计时器）
     PWA/网页版（health.asr_engine==="web"）：改用浏览器 Web Speech API 实时识别；
     桌面版：录完音频 → 本地 faster-whisper 转写。 */
  const rec = new Recorder();
  let recording = false;
  let timerEl = null;
  let webRec = null;
  const compact = !!opts.compact;
  container.innerHTML = compact
    ? `<button class="record-btn" title="录音后自动转写（本地 ASR）">🎤</button>`
    : `
    <div class="record-wrap">
      <button class="record-btn" title="点击录音">🎤</button>
      <span class="record-timer">0.0s</span>
      <span class="hint" style="color:var(--muted);font-size:13px">录音后自动转写（本地 ASR），也可以直接打字</span>
    </div>`;
  const btn = $(".record-btn", container);
  timerEl = compact ? null : $(".record-timer", container);
  const setTimer = (s) => { if (timerEl) timerEl.textContent = s; };
  const setRecordingUI = (on) => {
    recording = on;
    btn.classList.toggle("recording", on);
    btn.textContent = on ? "⏹" : "🎤";
  };
  btn.addEventListener("click", async () => {
    // 网页版：Web Speech 实时识别（浏览器权限弹窗由浏览器管理）
    const health = await getHealth().catch(() => null);
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (health && health.asr_engine === "web" && SR) {
      if (!webRec) {
        webRec = new SR();
        webRec.lang = "en-US";
        webRec.interimResults = true;
        webRec.continuous = false;
        webRec.maxAlternatives = 1;
        webRec.onstart = () => { setRecordingUI(true); setTimer("听你说…"); };
        webRec.onresult = (ev) => {
          let interim = "", final = "";
          for (let i = 0; i < ev.results.length; i++) {
            const t = ev.results[i][0].transcript;
            if (ev.results[i].isFinal) final += t;
            else interim += t;
          }
          const shown = (final || interim).trim();
          if (shown) onText(shown); // 手动输入场景直接回填；自动提交场景在 final 到达时触发
        };
        webRec.onerror = (e) => {
          setRecordingUI(false);
          setTimer("");
          toast(e.error === "not-allowed" ? "麦克风权限被拒绝，请允许后重试" : `语音识别失败：${e.error}`, "error");
        };
        webRec.onend = () => {
          setRecordingUI(false);
          setTimer("✓");
        };
      }
      if (!recording) webRec.start();
      else webRec.stop();
      return;
    }
    if (!recording) {
      setRecordingUI(true);
      rec.start({
        onTick: (s) => { setTimer(s.toFixed(1) + "s"); },
        onDone: async (b64, seconds) => {
          setRecordingUI(false);
          setTimer("转写中…");
          try {
            const r = await api("/api/speech/transcribe", { method: "POST", body: { audio_b64: b64 } });
            setTimer("✓");
            onText(r.text);
          } catch (e) {
            setTimer("");
            toast(e.message, "error");
          }
        },
        onError: (msg) => { setRecordingUI(false); toast(msg, "error"); },
      });
    } else {
      rec.stop();
    }
  });
  return { destroy: () => { if (webRec) { try { webRec.abort(); } catch (e) {} } rec.stop(); } };
}

/* ================= 路由 ================= */
const routes = {
  "#/": viewToday,
  "#/materials": viewMaterials,
  "#/material/": viewMaterial,
  "#/focus/": viewFocus,
  "#/unit/": viewUnit,
  "#/review": viewReview,
  "#/stats": viewStats,
  "#/settings": viewSettings,
  "#/generate": viewGenerate,
};

async function router() {
  const hash = location.hash || "#/";
  stopPlay();
  // 切页清理：停止精听音频轮询、销毁录音器
  if (focusCtx) focusCtx.pollStop = true;
  if (studioCtx && studioCtx.recorder) {
    try { studioCtx.recorder.destroy(); } catch (e) { /* ignore */ }
    studioCtx.recorder = null;
  }
  $$(".nav-item").forEach(a => {
    const prefix = { today: "#/", materials: "#/materials", review: "#/review", stats: "#/stats", settings: "#/settings" }[a.dataset.nav] || "#/";
    a.classList.toggle("active", hash.startsWith(prefix));
  });
  const view = $("#view");
  view.innerHTML = `<div class="loading">加载中…</div>`;
  const isToday = hash === "#/" || hash === "#" || hash === "";
  try {
    for (const key of Object.keys(routes)) {
      const match = key === "#/"
        ? isToday
        : key.endsWith("/") ? hash.startsWith(key) : hash === key;
      if (match) {
        await routes[key](hash);
        return;
      }
    }
    await viewToday();
  } catch (e) {
    view.innerHTML = `<div class="empty"><div class="big">😵</div><div>${esc(e.message)}</div></div>`;
  }
  updateReviewBadge();
}

async function updateReviewBadge() {
  try {
    const t = await api("/api/today");
    const b = $("#nav-review-badge");
    if (t.review_due > 0) { b.textContent = t.review_due; b.classList.remove("hidden"); }
    else b.classList.add("hidden");
  } catch (e) { /* ignore */ }
}

let _lastHash = location.hash || "#/";
const LEARNING_HASH = /^#\/(unit\/\d+|focus\/\d+)/;
// 退出提醒：默认每次提醒；用户勾选「今后不再提醒」后写 settings.exit_confirm=0
let _exitConfirmEnabled = true;
let _skipExitConfirm = false;
let _pendingExit = null;
(async () => {
  try {
    const { settings } = await api("/api/settings");
    _exitConfirmEnabled = settings.exit_confirm !== "0";
  } catch (e) { /* 默认提醒 */ }
})();

window.addEventListener("hashchange", () => {
  const next = location.hash || "#/";
  const leavingLearning = LEARNING_HASH.test(_lastHash) && !LEARNING_HASH.test(next);
  if (leavingLearning && !_skipExitConfirm && _exitConfirmEnabled) {
    // 只有停在中间步骤（句子未完成）才提醒；已到完成页直接放行
    const inMiddleStep = studioCtx && studioCtx.currentStep && !["done", "r_done"].includes(studioCtx.currentStep);
    const leavingFocus = /^#\/focus\/\d+/.test(_lastHash);
    if (inMiddleStep || leavingFocus) {
      _pendingExit = next;
      location.hash = _lastHash; // 先退回原页面，弹自定义确认（原生 confirm 无法带选项）
      askExitConfirm();
      return;
    }
  }
  _skipExitConfirm = false;
  _lastHash = next;
  router();
});

function askExitConfirm() {
  modal(`
    <h3>退出当前学习？</h3>
    <p style="color:var(--muted);font-size:14px;margin:10px 0">已完成的步骤会自动保存，可随时从「今日」页继续。</p>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer">
      <input type="checkbox" id="exit-norepeat" style="accent-color:var(--accent)"> 今后不再提醒（切出时自动保存进度）
    </label>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn primary" id="exit-yes">退出</button>
      <button class="btn" id="exit-no">继续学习</button>
    </div>`);
  $("#exit-yes").addEventListener("click", async () => {
    if ($("#exit-norepeat").checked) {
      try {
        await api("/api/settings", { method: "PUT", body: { exit_confirm: "0" } });
        _exitConfirmEnabled = false;
        toast("已记住：以后切出学习不再提醒", "success");
      } catch (e) { /* ignore */ }
    }
    closeModal();
    _skipExitConfirm = true;
    location.hash = _pendingExit;
  });
  $("#exit-no").addEventListener("click", () => { closeModal(); _pendingExit = null; });
}

/* ================= 今日 ================= */
async function viewToday() {
  const t = await api("/api/today");
  const weak = t.weak_scenes || [];
  const cont = t.continue_unit;
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">今日</div>
        <div class="page-sub">${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })} · 少而精，练透为止</div>
      </div>
    </div>
    <div id="checkin-card"></div>
    <div class="grid today-cards">
      <div class="card"><div class="card-label">🔁 复习到期</div><div class="big-num orange-num">${t.review_due}<span class="unit">个</span></div><div class="hint">间隔复习是记忆的关键</div></div>
      <div class="card"><div class="card-label">✨ 新学习</div><div class="big-num accent-num">${t.new_count}<span class="unit">句</span></div><div class="hint">还没开始的训练单元</div></div>
      <div class="card"><div class="card-label">🗣️ 口语待练</div><div class="big-num green-num">${t.speaking_due}<span class="unit">个</span></div><div class="hint">主动回忆偏弱，需要开口</div></div>
      <div class="card"><div class="card-label">🏆 累计掌握</div><div class="big-num">${t.mastered}<span class="unit">/ ${t.total_units}</span></div><div class="hint">整体掌握度 ≥ 80%</div></div>
    </div>
    <div class="divider"></div>
    ${t.continue_focus ? `
    <div class="panel focus-panel">
      <div class="panel-title">🎧 整段精听（尚雯婕法）</div>
      <div class="panel-sub">${esc(t.continue_focus.title)} · ${FOCUS_STATUS_LABEL[t.continue_focus.status] || t.continue_focus.status}${t.continue_focus.listen_count ? ` · 已通听 ${t.continue_focus.listen_count} 遍` : ""}</div>
      <div class="focus-steps">
        ${[["listen", "通听"], ["dictation", "听写"], ["shadowing", "跟读"], ["offscript", "脱稿"]].map(([k, label]) =>
          `<span class="focus-step ${t.continue_focus.steps[k] ? "done" : ""}">${t.continue_focus.steps[k] ? "✓" : "·"} ${label}</span>`).join("")}
      </div>
      <div class="btn-row">
        <a class="btn primary big" href="#/focus/${t.continue_focus.material_id}">${t.continue_focus.status === "new" ? "▶ 开始精听" : "▶ 继续 →"}</a>
        <a class="btn" href="#/materials">浏览材料</a>
      </div>
    </div>` : ""}
    ${cont ? `
    <div class="panel">
      <div class="panel-title">继续训练</div>
      <div class="panel-sub">材料 #${cont.material_id} · 第 ${cont.seq} 句 · <span class="badge ${cont.status}">${STATUS_LABEL[cont.status] || cont.status}</span></div>
      <div class="reference-text">${esc(cont.text)}</div>
      <div class="btn-row">
        <a class="btn primary big" href="#/unit/${cont.id}">▶ 继续 →</a>
        <a class="btn" href="#/materials">浏览材料</a>
      </div>
    </div>` : `<div class="empty"><div class="big">🎉</div><div>没有待训练的内容，去导入一个新材料吧</div><div style="margin-top:12px"><a class="btn primary" href="#/materials">+ 导入材料</a></div></div>`}
    ${weak.length ? `
    <div class="section-title">你的薄弱场景</div>
    <div class="card"><div class="weak-chips">
      ${weak.map(w => `<span class="chip">${w.emoji} ${esc(w.label)} <b style="margin-left:4px">${Math.round(w.avg_mastery * 100)}%</b></span>`).join("")}
    </div><div class="hint" style="margin-top:10px">多导入这些场景的真实材料，针对性练透</div></div>` : ""}
  `;
  loadCheckinCard();
}

async function loadCheckinCard() {
  const box = $("#checkin-card");
  if (!box) return;
  let s;
  try { s = await api("/api/stats"); } catch (e) { box.innerHTML = ""; return; }
  const t = s.today;
  box.innerHTML = `
    <div class="card checkin-card ${t.checked ? "checked" : ""}">
      <div class="checkin-left">
        <div class="card-label">${t.checked ? "✅ 今日已打卡" : "📅 今日打卡"}</div>
        <div class="hint">${t.checked ? `连续坚持 ${t.streak} 天，太棒了` : "学完记得打个卡，坚持看得见"}</div>
      </div>
      ${t.checked
        ? `<div class="checkin-streak">🔥 ${t.streak} 天</div>`
        : `<button class="btn primary" id="btn-checkin">✅ 打卡</button>`}
    </div>`;
  if (!t.checked) {
    $("#btn-checkin").addEventListener("click", async () => {
      await api("/api/checkin", { method: "POST" });
      toast("打卡成功，今天也坚持住了！", "success");
      loadCheckinCard();
    });
  }
}

/* ================= 统计 ================= */
async function viewStats() {
  const [s, mats] = await Promise.all([api("/api/stats"), api("/api/materials")]);
  const t = s.today;
  const v = $("#view");
  const max7 = Math.max(1, ...s.last7.map(d => d.dict + d.speak + d.review + d.focus));
  v.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">统计</div>
        <div class="page-sub">打卡与进步，用数字看见坚持</div>
      </div>
    </div>
    <div class="card checkin-card ${t.checked ? "checked" : ""}">
      <div class="checkin-left">
        <div class="card-label">${t.checked ? "✅ 今日已打卡" : "📅 今日打卡"}</div>
        <div class="hint">${t.checked ? `连续坚持 ${t.streak} 天` : "学完记得打个卡，坚持看得见"}</div>
      </div>
      ${t.checked
        ? `<div class="checkin-streak">🔥 ${t.streak} 天</div>`
        : `<button class="btn primary" id="btn-checkin">✅ 打卡</button>`}
    </div>
    <div class="grid today-cards">
      <div class="card"><div class="card-label">✍️ 今日听写</div><div class="big-num accent-num">${t.dict}<span class="unit">次</span></div><div class="hint">${t.dict_units} 个句子</div></div>
      <div class="card"><div class="card-label">🗣️ 今日开口</div><div class="big-num green-num">${t.speak}<span class="unit">次</span></div><div class="hint">其中回忆 ${t.recall} 次</div></div>
      <div class="card"><div class="card-label">🔁 今日复习</div><div class="big-num orange-num">${t.unit_review}<span class="unit">句</span></div><div class="hint">整段精听 ${t.focus} 次</div></div>
      <div class="card"><div class="card-label">📅 打卡连续</div><div class="big-num">${t.streak}<span class="unit">天</span></div><div class="hint">${t.checked ? "今天已打" : "今天还没打"}</div></div>
    </div>
    <div class="section-title">近 7 天训练量</div>
    <div class="card"><div class="bar-chart">
      ${s.last7.map(d => {
        const total = d.dict + d.speak + d.review + d.focus;
        return `<div class="bar-col" title="${d.date}：听写${d.dict} · 开口${d.speak} · 复习${d.review} · 精听${d.focus}">
          <div class="bar-stack">
            <div class="bar-seg seg-focus" style="height:${Math.round(d.focus / max7 * 100)}%"></div>
            <div class="bar-seg seg-review" style="height:${Math.round(d.review / max7 * 100)}%"></div>
            <div class="bar-seg seg-speak" style="height:${Math.round(d.speak / max7 * 100)}%"></div>
            <div class="bar-seg seg-dict" style="height:${Math.round(d.dict / max7 * 100)}%"></div>
          </div>
          <div class="bar-label">${total || ""}</div>
          <div class="bar-date">${d.date.slice(5)}</div>
        </div>`;
      }).join("")}
    </div>
    <div class="legend">
      <span><i class="seg-dict"></i>听写</span>
      <span><i class="seg-speak"></i>开口</span>
      <span><i class="seg-review"></i>复习</span>
      <span><i class="seg-focus"></i>精听</span>
    </div></div>
    <div class="section-title">近 30 天热力</div>
    <div class="card"><div class="heat">
      ${s.heat.map(d => {
        const lv = d.count === 0 ? 0 : d.count <= 2 ? 1 : d.count <= 5 ? 2 : d.count <= 10 ? 3 : 4;
        return `<div class="heat-cell lv${lv}" title="${d.date}：${d.count} 次训练"></div>`;
      }).join("")}
    </div>
    <div class="heat-legend"><span>少</span>${[0, 1, 2, 3, 4].map(l => `<i class="heat-cell lv${l}"></i>`).join("")}<span>多</span></div></div>
    <div class="section-title">进步对比 · 整段精听准确率</div>
    <div class="panel">
      <select class="input" id="prog-select" style="max-width:400px">
        <option value="">选择一段材料，看历次听写准确率…</option>
        ${mats.materials.map(m => `<option value="${m.id}">${esc(m.title)}</option>`).join("")}
      </select>
      <div id="prog-box"><div class="hint" style="color:var(--muted);margin-top:10px">同一段材料隔几天重听重写，准确率会在这里连成对比曲线</div></div>
    </div>
  `;
  if (!t.checked) {
    $("#btn-checkin").addEventListener("click", async () => {
      await api("/api/checkin", { method: "POST" });
      toast("打卡成功，今天也坚持住了！", "success");
      viewStats();
    });
  }
  $("#prog-select").addEventListener("change", async (e) => {
    const mid = e.target.value;
    const box = $("#prog-box");
    if (!mid) { box.innerHTML = ""; return; }
    const p = await api(`/api/materials/${mid}/progress`);
    if (!p.dictations.length) {
      box.innerHTML = `<div class="hint" style="color:var(--muted);margin-top:10px">还没有整段听写记录——完成一次「整段精听 → 听写」后，这里就会出现对比曲线</div>`;
      return;
    }
    const acc = p.dictations.map(d => Math.round((1 - d.overall_wer) * 100));
    const W = 560, H = 160, PAD = 26;
    const maxA = Math.max(...acc, 100);
    const x = (i) => PAD + (acc.length === 1 ? 0 : i * (W - PAD * 2) / (acc.length - 1));
    const y = (a) => H - PAD - a / maxA * (H - PAD * 2);
    const pts = acc.map((a, i) => `${x(i).toFixed(1)},${y(a).toFixed(1)}`).join(" ");
    box.innerHTML = `
      <div class="prog-chart">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:660px">
          ${[0.25, 0.5, 0.75, 1].map(f => `<line x1="${PAD}" y1="${y(maxA * f)}" x2="${W - PAD}" y2="${y(maxA * f)}" class="prog-grid"/>`).join("")}
          <polyline points="${pts}" class="prog-line"/>
          ${acc.map((a, i) => `<circle cx="${x(i)}" cy="${y(a)}" r="4" class="prog-dot"/><text x="${x(i) + 7}" y="${y(a) - 7}" class="prog-text">${a}%</text>`).join("")}
        </svg>
        <div class="hint" style="color:var(--muted);font-size:12px">共 ${acc.length} 次整段听写 · ${p.dictations.map(d => (d.created_at || "").slice(0, 10)).join(" → ")}</div>
        ${p.dictations.length > 1 && acc[acc.length - 1] > acc[0]
          ? `<div class="hint" style="color:var(--green);font-size:13px;margin-top:4px">📈 相比第一次提高了 ${acc[acc.length - 1] - acc[0]} 个百分点，坚持有效！</div>` : ""}
      </div>`;
  });
}

/* ================= 材料列表 ================= */
const GROUP_LABEL = { todo: "未开始", active: "进行中", mastered: "已掌握" };
const SRC_LABEL = {
  builtin: ["⭐", "内置"], podcast: ["📻", "播客 RSS"], youtube: ["▶️", "YouTube"],
  web_article: ["🌐", "网页文章"], local_file: ["🎬", "本地文件"], manual_text: ["📝", "粘贴文本"],
};

function matGroup(m) {
  // 分组：未开始 / 进行中 / 已掌握（精听状态 + 逐句完成度）
  if (m.focus_status === "mastered") return "mastered";
  if (m.unit_total > 0 && m.unit_done >= m.unit_total) return "mastered";
  const active = ["listening", "dictation", "shadowing", "offscript", "review_due"];
  if (active.includes(m.focus_status) || m.unit_done > 0) return "active";
  return "todo";
}

async function viewMaterials() {
  const { materials } = await api("/api/materials");
  const v = $("#view");
  const filter = { tab: "all", q: "", scene: "", src: "", tag: "" };
  const allTags = [...new Set(materials.flatMap(m => (m.tags || "").split(",").map(t => t.trim()).filter(Boolean)))].sort();
  const allScenes = [...new Set(materials.map(m => m.scene_label).filter(Boolean))];
  const allSrcs = [...new Set(materials.map(m => m.source_type).filter(Boolean))];
  v.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">材料</div>
        <div class="page-sub">把真实英语内容变成可反复训练的材料</div>
      </div>
    </div>
    <div class="import-bar">
      <button class="btn primary" id="btn-import">＋ 导入内容</button>
      <a class="btn" href="#/generate">✨ AI 生成</a>
      <a class="btn" href="#/review">复习队列</a>
    </div>
    <div class="mat-filter">
      <div class="tabs" id="mat-tabs">
        <div class="tab active" data-tab="all">全部 ${materials.length}</div>
        <div class="tab" data-tab="todo">未开始</div>
        <div class="tab" data-tab="active">进行中</div>
        <div class="tab" data-tab="mastered">已掌握</div>
      </div>
      <div class="mat-filter-row">
        <input class="input" id="mat-search" placeholder="🔍 搜索标题 / 描述 / 标签…" style="max-width:320px">
        <span class="filter-chips" id="mat-scenes">${allScenes.map(s => `<button class="chip filter-chip" data-k="scene" data-v="${esc(s)}">${s}</button>`).join("")}</span>
        <span class="filter-chips" id="mat-srcs">${allSrcs.map(s => {
          const [e, l] = SRC_LABEL[s] || ["📄", s];
          return `<button class="chip filter-chip" data-k="src" data-v="${esc(s)}">${e} ${l}</button>`;
        }).join("")}</span>
        ${allTags.length ? `<span class="filter-chips" id="mat-tags">${allTags.map(t => `<button class="chip filter-chip" data-k="tag" data-v="${esc(t)}">#${esc(t)}</button>`).join("")}</span>` : ""}
      </div>
    </div>
    <div class="grid" id="mat-list"></div>
  `;
  $("#btn-import").addEventListener("click", importModal);
  const list = $("#mat-list");

  const matches = (m) => {
    if (filter.tab !== "all" && matGroup(m) !== filter.tab) return false;
    if (filter.scene && m.scene_label !== filter.scene) return false;
    if (filter.src && m.source_type !== filter.src) return false;
    if (filter.tag && !(m.tags || "").split(",").map(t => t.trim()).includes(filter.tag)) return false;
    if (filter.q) {
      const hay = `${m.title} ${m.description || ""} ${m.tags || ""}`.toLowerCase();
      if (!hay.includes(filter.q.toLowerCase())) return false;
    }
    return true;
  };

  const render = () => {
    const shown = materials.filter(matches);
    if (!shown.length) {
      list.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">${materials.length ? "🔎" : "📂"}</div><div>${materials.length ? "没有符合条件的材料，调整筛选试试" : "还没有材料，点「导入内容」开始，或先练内置材料"}</div></div>`;
      return;
    }
    list.innerHTML = shown.map(m => {
      const tags = (m.tags || "").split(",").map(t => t.trim()).filter(Boolean);
      const [e, l] = SRC_LABEL[m.source_type] || ["📄", m.source_type || ""];
      return `
      <div class="card mat-card hover">
        <div class="mat-meta">
          ${m.is_builtin ? `<span class="badge builtin">内置</span>` : ""}
          <span class="chip">${m.scene_emoji} ${esc(m.scene_label)}</span>
          <span class="chip gray">${e} ${l}</span>
          <span class="chip gray">${m.unit_total} 句</span>
          ${tags.map(t => `<span class="chip tag-chip">#${esc(t)}</span>`).join("")}
          <span style="margin-left:auto;color:var(--muted);font-size:12px">${GROUP_LABEL[matGroup(m)]}</span>
        </div>
        <div class="mat-title">${esc(m.title)}</div>
        <div class="mat-desc">${esc(m.description || "")}</div>
        <div class="progress"><i style="width:${m.unit_total ? Math.round(m.unit_done / m.unit_total * 100) : 0}%"></i></div>
        <div class="mat-actions">
          <a class="btn sm" href="#/material/${m.id}">打开</a>
          <button class="btn sm danger" data-del="${m.id}">删除</button>
        </div>
      </div>`;
    }).join("");
    $$("[data-del]", list).forEach(b => b.addEventListener("click", async () => {
      if (!confirm("删除这个材料？所有训练记录会一起删除。")) return;
      await api(`/api/materials/${b.dataset.del}`, { method: "DELETE" });
      toast("已删除", "success");
      viewMaterials();
    }));
  };

  // tabs
  $$("#mat-tabs .tab").forEach(t => t.addEventListener("click", () => {
    $$("#mat-tabs .tab").forEach(x => x.classList.toggle("active", x === t));
    filter.tab = t.dataset.tab;
    render();
  }));
  // 筛选 chips（scene / src / tag 互斥切换）
  $$(".filter-chip").forEach(c => c.addEventListener("click", () => {
    const k = c.dataset.k;
    if (filter[k] === c.dataset.v) { filter[k] = ""; c.classList.remove("on"); }
    else {
      filter[k] = c.dataset.v;
      $$(`.filter-chip[data-k="${k}"]`).forEach(x => x.classList.toggle("on", x === c));
    }
    render();
  }));
  // 搜索（防抖）
  let st;
  $("#mat-search").addEventListener("input", (e) => {
    clearTimeout(st);
    st = setTimeout(() => { filter.q = e.target.value.trim(); render(); }, 200);
  });
  render();
}

function importModal() {
  modal(`
    <button class="close-x" id="modal-x">✕</button>
    <h3>导入内容</h3>
    <div class="page-sub" style="color:var(--muted);font-size:13px">本地文件 / URL / 粘贴文本，自动变成训练单元</div>
    <div class="tabs">
      <div class="tab active" data-tab="file">📁 本地文件</div>
      <div class="tab" data-tab="url">🔗 URL</div>
      <div class="tab" data-tab="text">📝 粘贴文本</div>
    </div>
    <div id="import-body"></div>
  `);
  $("#modal-x").addEventListener("click", closeModal);
  const body = $("#import-body");
  const show = async (tab) => {
    $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
    if (tab === "file") {
      body.innerHTML = `
        <div class="dropzone" id="dropzone">📁 点击选择或拖入文件<br><span style="font-size:12px">音频 MP3/M4A/WAV… 视频 MP4/MOV… 字幕 SRT/VTT… 文本 TXT</span></div>
        <input type="file" id="file-input" class="hidden" accept=".mp3,.m4a,.wav,.aiff,.flac,.mp4,.mov,.mkv,.srt,.vtt,.txt,.webm,.aac,.ogg">
        <div class="hint" style="color:var(--muted);font-size:12px;margin-top:8px">音频/视频会自动本地转写（faster-whisper，数据不出本机）</div>`;
      const dz = $("#dropzone");
      const fi = $("#file-input");
      dz.addEventListener("click", () => fi.click());
      dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("over"));
      dz.addEventListener("drop", (e) => {
        e.preventDefault(); dz.classList.remove("over");
        if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
      });
      fi.addEventListener("change", () => { if (fi.files.length) uploadFile(fi.files[0]); });
    } else if (tab === "url") {
      body.innerHTML = `
        <label class="field">粘贴链接（YouTube / Podcast RSS / 网页文章 / 音频直链）</label>
        <input class="input" id="url-input" placeholder="https://…" style="margin-bottom:10px">
        <div class="hint" style="color:var(--muted);font-size:12px;margin-bottom:6px">
          YouTube：自动抓取公开字幕（不下载视频）；Podcast：解析 RSS 后选一集；
          网页：提取正文生成阅读训练。遵守网站条款，仅导入可合法获取的内容。
        </div>
        <div class="hint" style="color:var(--muted);font-size:12px;margin-bottom:8px">✨ 推荐学习源（点一下直接导入，解析后选一集）：</div>
        <div id="preset-feeds" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px"></div>
        <button class="btn primary" id="url-go">解析并导入</button>`;
      const PRESET_FEEDS = [
        ["🧠 科学 60 秒·大脑（SciAm）", "https://www.scientificamerican.com/sciam/xml/iTunes.cfm?id=60-second-mind"],
        ["❤️ 科学 60 秒·健康（SciAm）", "https://www.scientificamerican.com/sciam/xml/iTunes.cfm?id=60-second-health"],
        ["🔬 科学 60 秒·科技（SciAm）", "https://www.scientificamerican.com/sciam/xml/iTunes.cfm?id=60-second-tech"],
        ["⚡ Science Quickly（60秒科学升级版）", "https://www.scientificamerican.com/sciam/xml/iTunes.cfm?id=science-quickly"],
        ["🎧 6 Minute English（BBC）", "https://podcasts.files.bbci.co.uk/p02pc9tn.rss"],
        ["📖 American Stories（VOA 慢速）", "https://learningenglish.voanews.com/podcast/?zoneId=1581"],
      ];
      $("#preset-feeds").innerHTML = PRESET_FEEDS.map(([label, url]) =>
        `<button class="preset-chip" data-url="${esc(url)}">${esc(label)}</button>`).join("");
      $$("#preset-feeds .preset-chip").forEach(chip => chip.addEventListener("click", () => {
        importWithStatus(() => api("/api/materials/url", { method: "POST", body: { url: chip.dataset.url } }));
      }));
      $("#url-go").addEventListener("click", async () => {
        const url = $("#url-input").value.trim();
        if (!url) return toast("请输入 URL", "error");
        await importWithStatus(() => api("/api/materials/url", { method: "POST", body: { url } }));
      });
      $("#url-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#url-go").click(); });
    } else {
      body.innerHTML = `
        <label class="field">标题（可选）</label>
        <input class="input" id="txt-title" placeholder="例如：The Convo Starters - Episode 12" style="margin-bottom:10px">
        <label class="field">文本 / 字幕内容（SRT / VTT / 纯文本自动识别）</label>
        <textarea class="input" id="txt-text" placeholder="每句一行，或粘贴带时间轴的字幕…" style="min-height:150px"></textarea>
        <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="txt-go">生成训练单元</button></div>`;
      $("#txt-go").addEventListener("click", async () => {
        const text = $("#txt-text").value.trim();
        if (!text) return toast("请输入内容", "error");
        await importWithStatus(() => api("/api/materials", {
          method: "POST",
          body: { title: $("#txt-title").value.trim(), text, source_type: "manual_text" },
        }));
      });
    }
  };
  $$(".tab").forEach(t => t.addEventListener("click", () => show(t.dataset.tab)));
  show("file");

  async function uploadFile(file) {
    const fd = new FormData();
    fd.append("file", file);
    await importWithStatus(() => api("/api/materials/upload", { method: "POST", formData: fd }));
  }

  async function importWithStatus(reqFn) {
    closeModal();
    const modalBox = modal(`<h3>正在处理…</h3><div style="padding:10px 0"><span class="spin"></span> <span id="import-proc-text">准备中…</span></div><div id="import-proc-bar" style="padding:0 10px 12px"></div>`);
    try {
      const r = await reqFn();
      const mid = r.id;
      // 轮询直到就绪或出错，实时显示步骤与百分比
      for (let i = 0; i < 300; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
        try {
          const { material } = await api(`/api/materials/${mid}`);
          const procText = modalBox && modalBox.querySelector("#import-proc-text");
          if (procText && material.status === "processing") {
            const step = PROCESS_STEP_LABELS[material.process_step] || "处理中";
            const pct = material.process_pct || 0;
            procText.textContent = pct > 0 ? `正在${step}… ${pct}%` : `正在${step}…`;
            const barBox = modalBox && modalBox.querySelector("#import-proc-bar");
            if (barBox) barBox.innerHTML = `<div class="progress-bar" style="cursor:default"><div class="progress-fill" style="width:${Math.max(2, pct)}%"></div></div>`;
          }
          if (material.status === "ready" || material.status === "draft") {
            closeModal();
            toast("导入成功，已生成 " + material.unit_total + " 个训练单元", "success");
            location.hash = "#/material/" + mid;
            return;
          }
          if (material.status === "error") {
            closeModal();
            toast(material.description || "处理失败", "error");
            location.hash = "#/material/" + mid;
            return;
          }
        } catch (e) { /* 继续轮询 */ }
      }
      closeModal();
      toast("处理仍在进行，可稍后查看", "");
      location.hash = "#/material/" + mid;
    } catch (e) {
      closeModal();
      toast(e.message, "error");
    }
  }
}

/* ================= 材料详情 ================= */
async function viewMaterial(hash) {
  const mid = parseInt(hash.split("/")[2], 10);
  const { material: m } = await api(`/api/materials/${mid}`);
  const src = m.source || {};
  const v = $("#view");
  const tags = (m.tags || "").split(",").map(t => t.trim()).filter(Boolean);
  v.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/materials" style="font-size:13px">← 材料</a>
        <div class="page-title">${esc(m.title)}</div>
        <div class="page-sub">${esc(m.description || "")}</div>
      </div>
      <div class="mat-meta">
        ${m.is_builtin ? `<span class="badge builtin">内置</span>` : ""}
        <span class="chip">${m.scene_emoji} ${esc(m.scene_label)}</span>
        <span class="chip gray">${m.duration_ms ? Math.round(m.duration_ms / 1000) + "s" : ""} ${m.unit_total} 句 · 完成 ${m.unit_done}</span>
        ${tags.map(t => `<span class="chip tag-chip" data-tag="${esc(t)}">#${esc(t)}</span>`).join("")}
        <button class="btn sm" id="btn-edit-tags">🏷 ${tags.length ? "编辑标签" : "加标签"}</button>
      </div>
    </div>
    <div id="tags-edit" style="display:none"></div>
    ${m.status === "draft" ? renderPodcastShell(m, src) : ""}
    ${m.status === "error" ? renderErrorPanel(m, src) : ""}
    ${m.status === "processing" ? `
    <div class="panel"><span class="spin"></span> <span id="mat-proc-text">正在处理…</span></div>
    <div id="mat-proc-progress"></div>` : ""}
    ${m.status === "ready" ? `
    <div class="panel focus-panel">
      <div class="panel-title">🎧 整段精听</div>
      <div class="panel-sub">不看文字反复听整段 → 逐句听写 → 红笔校对 → 跟着原声模仿 → 合上文本自己念出来</div>
      <div class="focus-steps">
        ${FOCUS_STEPS.map(s => `<span class="focus-step ${m.focus.steps[s.key] ? "done" : ""}">${m.focus.steps[s.key] ? "✓" : "·"} ${s.label}</span>`).join("")}
        ${m.focus.status === "mastered" ? `<span class="badge builtin">已练透 · ${m.focus.reviews_done} 次复习</span>` : ""}
        ${m.focus.next_review_at ? `<span class="chip gray">下次复习 ${esc((m.focus.next_review_at || "").slice(5, 16))}</span>` : ""}
      </div>
      <div class="btn-row">
        <a class="btn primary big" href="#/focus/${mid}">${m.focus.due ? "🔁 到期复习" : m.focus.status === "new" ? "▶ 开始精听" : "▶ 继续精听"}</a>
      </div>
    </div>
    <div id="mat-words-panel"></div>` : ""}
    ${m.unit_total ? `
    <div class="section-title">逐句强化 <span style="font-weight:400;color:var(--muted);font-size:13px">（可选）单句反复练</span></div>
    <div class="panel" style="padding:8px 10px">
      <div class="unit-list" id="unit-list"></div>
    </div>` : (m.status === "ready" ? `<div class="empty"><div class="big">🗒️</div><div>该材料还没有单元，可在下方粘贴字幕/文本</div></div>` : "")}
    ${m.status === "ready" && !m.unit_total ? renderTranscriptForm(mid, true) : ""}
  `;
  if (m.status === "draft") bindPodcastPicks(v, mid);
  if (m.status === "ready") loadWordsPanel(mid);
  if (m.status === "error") {
    const rb = $("#btn-reprocess");
    if (rb) rb.addEventListener("click", async () => {
      if (!confirm("重新处理会删除该材料已有的训练单元和进度，确定继续？")) return;
      rb.disabled = true;
      rb.textContent = "已提交，正在转写…";
      try {
        await api(`/api/materials/${mid}/reprocess`, { method: "POST" });
        viewMaterial(`#/material/${mid}`);
      } catch (e) { toast(e.message, "error"); rb.disabled = false; }
    });
  }
  if (m.status === "processing") {
    // 轮询处理进度：下载 → 转写 → 建单元 → 完成
    (async () => {
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const node = $("#mat-proc-text");
        if (!node) return;
        let mm = null;
        try { ({ material: mm } = await api(`/api/materials/${mid}`)); } catch (e) { continue; }
        if (mm.status === "ready" || mm.status === "error") { viewMaterial(`#/material/${mid}`); return; }
        const step = PROCESS_STEP_LABELS[mm.process_step] || "处理中";
        const pct = mm.process_pct || 0;
        node.textContent = pct > 0 ? `正在${step}… ${pct}%` : `正在${step}…`;
        const bar = $("#mat-proc-progress");
        if (bar) {
          bar.innerHTML = `<div class="progress-bar" style="cursor:default"><div class="progress-fill" style="width:${Math.max(2, pct)}%"></div></div>`;
        }
      }
      const node = $("#mat-proc-text");
      if (node) node.textContent = "处理超时，请刷新页面查看最新状态";
    })();
  }
  $("#btn-edit-tags").addEventListener("click", () => {
    const box = $("#tags-edit");
    const showing = box.style.display !== "none";
    box.style.display = showing ? "none" : "";
    if (!showing) {
      box.innerHTML = `
        <div class="panel" style="padding:12px 14px">
          <div class="label" style="font-size:12px;color:var(--muted);margin-bottom:6px">标签（逗号分隔，用于筛选归类，例如：新闻, 科技, 想精听）</div>
          <div class="word-add-row">
            <input class="input" id="tags-input" placeholder="news, 科技, 慢速…" value="${esc(tags.join(", "))}" style="flex:1;min-height:38px">
            <button class="btn sm primary" id="tags-save">保存</button>
          </div>
        </div>`;
      const save = async () => {
        const val = $("#tags-input").value.trim();
        try {
          await api(`/api/materials/${mid}/tags`, { method: "POST", body: { tags: val } });
          toast("标签已保存", "success");
          viewMaterial(`#/material/${mid}`);
        } catch (e) { toast(e.message, "error"); }
      };
      $("#tags-save").addEventListener("click", save);
      $("#tags-input").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
      $("#tags-input").focus();
    }
  });
  if (m.unit_total) {
    const list = $("#unit-list");
    list.innerHTML = m.units.map(u => `
      <div class="unit-row ${u.status === "MASTERED" ? "mastered" : ""}" data-id="${u.id}">
        <div class="unit-seq">${u.seq}</div>
        <div class="unit-text" title="${esc(u.text)}">${esc(u.text)}</div>
        <div class="unit-side">
          <span class="meter" title="难度">${"★".repeat(Math.max(1, Math.round(u.difficulty / 2)))}</span>
          <span style="font-size:12px;color:var(--muted)" title="学习价值（0-100）：由场景、句式、难度与长度自动评分，越高越值得精学">💎 学习价值 ${u.learning_value}</span>
          <span class="badge ${u.status}">${STATUS_LABEL[u.status] || u.status}</span>
        </div>
      </div>`).join("");
    $$(".unit-row", list).forEach(row => row.addEventListener("click", () => {
      // 延迟跳转：双击是点词查词（explainer 会设置 __explainerDblAt）。
      // 每次 click 重置定时器，等待双点序列结束后再决定是否跳转。
      clearTimeout(row.__navTimer);
      row.__navTimer = setTimeout(() => {
        if (Date.now() - (window.__explainerDblAt || 0) < 800) return;
        location.hash = "#/unit/" + row.dataset.id;
      }, 400);
    }));
  }
}

function renderPodcastShell(m, src) {
  const eps = src.episodes || [];
  return `
    <div class="panel">
      <div class="panel-title">🎙️ 选择一期节目</div>
      <div class="panel-sub">${src.url || ""}</div>
      ${eps.length ? `
      <div class="unit-list">${eps.map((e, i) => `
        <div class="unit-row" data-url="${esc(e.url)}">
          <div class="unit-seq">${i + 1}</div>
          <div class="unit-text">${esc(e.title)}</div>
          <div class="unit-side"><span style="font-size:12px;color:var(--muted)">${esc(e.duration || "")}</span>
          <button class="btn sm primary pick">选这集</button></div>
        </div>`).join("")}</div>
      <div class="hint" style="color:var(--muted);font-size:12px;margin-top:8px">下载音频并本地转写后自动生成训练单元</div>`
      : `<div class="empty"><div class="big">😕</div><div>未能解析出节目，检查 RSS 地址</div></div>`}
    </div>`;
}

function bindPodcastPicks(scope, mid) {
  $$(".pick", scope).forEach(b => b.addEventListener("click", async () => {
    const row = b.closest(".unit-row");
    const url = row && row.dataset.url;
    if (!url) return;
    b.disabled = true;
    b.textContent = "下载中…";
    try {
      await api(`/api/materials/${mid}/podcast-episode`, { method: "POST", body: { url } });
      toast("开始下载并转写该集（本机处理，约 1-2 分钟）", "success");
      // 轮询直到转写完成或出错
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { material } = await api(`/api/materials/${mid}`);
        if (material.status === "ready") {
          toast("转写完成，已生成 " + material.unit_total + " 个训练单元", "success");
          viewMaterial("#/material/" + mid);
          return;
        }
        if (material.status === "error") break;
        b.textContent = "转写中… " + Math.floor((i + 1) / 60) + ":" + String((i + 1) % 60).padStart(2, "0");
      }
      viewMaterial("#/material/" + mid);
    } catch (e) {
      toast(e.message, "error");
      b.disabled = false;
      b.textContent = "选这集";
    }
  }));
}

function renderErrorPanel(m, src) {
  return `
    <div class="panel" style="border-color:rgba(255,107,107,.4)">
      <div class="panel-title" style="color:var(--red)">⚠️ 处理未完成</div>
      <div class="panel-sub">${esc(m.description || src.error || "未知错误")}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn sm" id="btn-reprocess">🔁 重新处理（有音频时重新转写）</button>
      </div>
      ${renderTranscriptForm(m.id)}
    </div>`;
}

function renderTranscriptForm(mid, standalone) {
  const inner = `
    <div class="panel-title">📝 粘贴字幕 / 文本</div>
    <div class="panel-sub">手动提供转写文本（支持 SRT / VTT / 纯文本），App 会重新生成训练单元</div>
    <textarea class="input" id="attach-text" placeholder="把字幕或逐句文本粘贴到这里…" style="min-height:120px"></textarea>
    <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="attach-go">生成训练单元</button></div>`;
  return standalone ? `<div class="panel" style="margin-top:14px">${inner}</div>` : inner;
}

/* ================= 生词词组 ================= */
async function fetchWordMeanings(rows) {
  // 优先已存释义，缺的查离线词库（零网络）；返回带 meaning 的新数组
  return Promise.all(rows.map(async w => {
    let meaning = (w.meaning || "").trim();
    if (!meaning) {
      try {
        const r = await api(`/api/wordbank?q=${encodeURIComponent(w.expression)}`);
        if (r.found) meaning = `${r.pos ? r.pos + " " : ""}${r.meaning}`;
      } catch (e) { /* 查不到就显示暂无释义 */ }
    }
    return { ...w, meaning };
  }));
}

function wordRowHtml(w, opts = {}) {
  return `
    <div class="word-row" data-id="${w.id}">
      <div class="word-main">
        <div class="word-expr">${esc(w.expression)}${w.source === "rule" ? '<span class="badge" style="margin-left:6px">推荐</span>' : ""}</div>
        <div class="word-meaning">${w.meaning ? esc(w.meaning) : `<span class="muted">暂无释义</span>`}</div>
        ${w.unit_text ? `<div class="word-src">「${esc(w.unit_text.slice(0, 64))}${w.unit_text.length > 64 ? "…" : ""}」</div>` : ""}
        ${w.note ? `<div class="word-src">📝 ${esc(w.note)}</div>` : ""}
      </div>
      <div class="word-actions">
        ${w.audio ? `<button class="btn sm" data-play="${w.id}">🔊 听原句</button>` : ""}
        <button class="btn sm" data-edit="${w.id}">✏️ 释义</button>
        <button class="btn sm danger" data-del="${w.id}">🗑</button>
      </div>
    </div>`;
}

function bindWordRowActions(box, items, onChanged) {
  $$("[data-play]", box).forEach(b => b.addEventListener("click", () => {
    const w = items.find(x => x.id === +b.dataset.play);
    if (w && w.audio) playUnit({ audio: w.audio });
  }));
  $$("[data-del]", box).forEach(b => b.addEventListener("click", async () => {
    const w = items.find(x => x.id === +b.dataset.del);
    if (!w || !confirm(`删除生词「${w.expression}」？`)) return;
    try {
      await api(`/api/words/${w.id}`, { method: "DELETE" });
      toast("已删除", "success");
      onChanged();
    } catch (e) { toast(e.message, "error"); }
  }));
  $$("[data-edit]", box).forEach(b => b.addEventListener("click", () => {
    const w = items.find(x => x.id === +b.dataset.edit);
    const row = b.closest(".word-row");
    if (!w || row.dataset.editing) return;
    row.dataset.editing = "1";
    row.innerHTML = `
      <div class="word-edit">
        <div class="word-expr">${esc(w.expression)}</div>
        <input class="input" id="we-meaning-${w.id}" placeholder="中文释义（可留空用离线词库）" value="${esc(w.meaning || "")}">
        <input class="input" id="we-note-${w.id}" placeholder="自己的笔记 / 联想记忆…" value="${esc(w.note || "")}">
        <div class="btn-row" style="margin:0">
          <button class="btn sm" id="we-cancel-${w.id}">取消</button>
          <button class="btn sm primary" id="we-save-${w.id}">保存</button>
        </div>
      </div>`;
    $(`#we-cancel-${w.id}`, row).addEventListener("click", () => onChanged());
    $(`#we-save-${w.id}`, row).addEventListener("click", async () => {
      const meaning = $(`#we-meaning-${w.id}`, row).value.trim();
      const note = $(`#we-note-${w.id}`, row).value.trim();
      try {
        await api(`/api/words/${w.id}`, { method: "PATCH", body: { meaning, note } });
        toast("已保存", "success");
        onChanged();
      } catch (e) { toast(e.message, "error"); }
    });
  }));
}

async function loadWordsPanel(mid) {
  const box = $("#mat-words-panel");
  if (!box) return;
  let rows;
  try {
    rows = (await api(`/api/materials/${mid}/words`)).words;
  } catch (e) { box.innerHTML = ""; return; }
  if (!rows.length) {
    box.innerHTML = `
      <div class="panel mat-words">
        <div class="panel-title">📒 生词词组</div>
        <div class="panel-sub">听写红笔校对时保存的生词会出现在这里；逐句强化与到期复习时会提示你重点记忆</div>
      </div>`;
    return;
  }
  const items = await fetchWordMeanings(rows);
  box.innerHTML = `
    <div class="panel mat-words">
      <div class="panel-title">📒 生词词组 <span class="badge builtin">${rows.length}</span></div>
      <div class="panel-sub">点 🔊 听该词所在的原句；释义可随时补充</div>
      <div class="word-list">${items.map(w => wordRowHtml(w)).join("")}</div>
    </div>`;
  bindWordRowActions(box, items, () => loadWordsPanel(mid));
}

// 逐句强化 reveal / 复习对照：展示本句关联的生词
async function renderUnitWords(u, box) {
  box = box || $("#unit-words");
  if (!box || !u.material_id) return;
  let rows;
  try {
    rows = (await api(`/api/materials/${u.material_id}/words`)).words.filter(w => w.unit_id === u.id);
  } catch (e) { box.innerHTML = ""; return; }
  if (!rows.length) { box.innerHTML = ""; return; }
  const items = await fetchWordMeanings(rows);
  box.innerHTML = `
    <div class="panel" style="margin-top:12px;border-left:3px solid var(--orange)">
      <div class="panel-title" style="font-size:15px">📒 本句重点词组</div>
      <div class="word-list">${items.map(w => wordRowHtml(w)).join("")}</div>
    </div>`;
  bindWordRowActions(box, items, () => renderUnitWords(u, box));
}

/* ================= 单元训练工作台 ================= */
let unitNav = { prev: null, next: null };

async function viewUnit(hash) {
  const unitId = parseInt(hash.split("/")[2], 10);
  const { unit: u } = await api(`/api/units/${unitId}`);
  unitNav = { prev: null, next: null };
  try {
    const mat = await api(`/api/materials/${u.material_id}`);
    const units = mat.units || (mat.material && mat.material.units) || [];
    const idx = units.findIndex(x => x.id === unitId);
    if (idx > 0) unitNav.prev = units[idx - 1];
    if (idx >= 0 && idx < units.length - 1) unitNav.next = units[idx + 1];
  } catch (e) { /* 取不到相邻句也不阻塞学习 */ }
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/material/${u.material_id}" style="font-size:13px">← 返回材料</a>
        <div class="page-title">第 ${u.seq} 句</div>
        <div class="page-sub">
          <span class="badge ${u.status}">${STATUS_LABEL[u.status] || u.status}</span>
          ${u.scene ? `<span class="chip" style="margin-left:6px">场景：${esc(u.scene)}</span>` : ""}
          <span class="chip gray" style="margin-left:6px" title="难度 1-10（生词率/句长）；学习价值 0-100（场景、句式、难度自动评分）">难度 ${u.difficulty} · 💎 学习价值 ${u.learning_value}</span>
        </div>
      </div>
      <div class="unit-nav">
        ${unitNav.prev ? `<a class="btn sm" href="#/unit/${unitNav.prev.id}" title="上一句">← 上一句</a>` : ""}
        ${unitNav.next ? `<a class="btn sm primary" href="#/unit/${unitNav.next.id}" title="下一句">下一句 →</a>` : ""}
      </div>
    </div>
    <div class="studio" id="studio"></div>
  `;
  const isReview = u.status === "REVIEW_DUE" || u.status === "MASTERED";
  renderStudio(u, { review: isReview });
}

const STEP_DEFS = [
  { key: "listening", label: "盲听" },
  { key: "dictation", label: "听写" },
  { key: "reveal", label: "对照理解" },
  { key: "shadowing", label: "跟读" },
  { key: "recall", label: "主动回忆" },
  { key: "done", label: "完成" },
];

const REVIEW_STEPS = [
  { key: "r_listen", label: "复习听力" },
  { key: "r_dict", label: "听写" },
  { key: "r_speak", label: "口语复述" },
  { key: "r_done", label: "完成" },
];

function stepForStatus(status) {
  switch (status) {
    case "NEW": case "LISTENING": return "listening";
    case "DICTATION": return "dictation";
    case "REVEALED": return "reveal";
    case "UNDERSTOOD": case "SHADOWING": return "shadowing";
    case "ACTIVE_RECALL": return "recall";
    default: return "done";
  }
}

let studioCtx = null;

function updateStepBar(key) {
  /* 步骤条随 showStep 实时更新（done/current 高亮） */
  const steps = studioCtx.review ? REVIEW_STEPS : STEP_DEFS;
  const idx = steps.findIndex(s => s.key === key);
  if (idx < 0) return;
  document.querySelectorAll("#studio .steps .step").forEach((el, i) => {
    el.classList.toggle("done", i < idx);
    el.classList.toggle("current", i === idx);
    const n = el.querySelector(".n");
    if (n) n.textContent = i < idx ? "✓" : i + 1;
  });
}

function bingoFeedback() {
  /* 每句完成时的庆祝提示：大字 Bingo 弹出后自动淡出 */
  const el = document.createElement("div");
  el.className = "bingo-pop";
  el.innerHTML = `<div class="bingo-word">Bingo!</div><div class="bingo-sub">🎉 本句完成</div>`;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 450);
  }, 1500);
}

function renderUnitArrow() {
  /* 句子切换在页面右上角（unit-nav），不再使用悬浮箭头 */
}

/* ================= 主题（白天/黑夜） ================= */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  try { localStorage.setItem("ds_theme", theme); } catch (e) { /* ignore */ }
  document.querySelectorAll("[data-theme-btn]").forEach(b => {
    b.textContent = theme === "light" ? "🌙 夜间模式" : "☀️ 白天模式";
  });
}
function currentTheme() {
  try { return localStorage.getItem("ds_theme") === "light" ? "light" : "dark"; } catch (e) { return "dark"; }
}
function bindThemeButtons() {
  document.querySelectorAll("[data-theme-btn]").forEach(b => {
    b.addEventListener("click", () => applyTheme(currentTheme() === "light" ? "dark" : "light"));
  });
}

function bindTextCorrection(panel, u) {
  /* 听写检查的原文来自 ASR 转录，可能有错：允许用户就地纠正并保存 */
  const btn = $("#edit-text", panel);
  if (!btn) return;
  btn.addEventListener("click", () => {
    const ref = $(".reference-text", panel);
    if (!ref) return;
    ref.innerHTML = `
      <textarea class="input" id="text-fix" style="min-height:72px">${esc(u.text)}</textarea>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn sm primary" id="text-fix-save">💾 保存纠错</button>
        <button class="btn sm" id="text-fix-cancel">取消</button>
      </div>`;
    $("#text-fix").focus();
    $("#text-fix-save").addEventListener("click", async () => {
      const t = $("#text-fix").value.trim();
      if (!t) return toast("内容不能为空", "error");
      const saveBtn = $("#text-fix-save");
      saveBtn.disabled = true;
      try {
        const r = await api(`/api/units/${u.id}`, { method: "PUT", body: { text: t } });
        studioCtx.unit = r.unit;
        await showStep(studioCtx.currentStep);
        toast("已保存，后续听写与复习将以新文本为准", "success");
      } catch (e) { toast(e.message, "error"); saveBtn.disabled = false; }
    });
    $("#text-fix-cancel").addEventListener("click", () => showStep(studioCtx.currentStep));
  });
}

async function renderStudio(u, opts) {
  studioCtx = { unit: u, sessionId: null, dictAttempts: 0, lastDict: null, recorder: null, review: !!opts.review, currentStep: null };
  renderUnitArrow();
  const studio = $("#studio");
  const steps = studioCtx.review ? REVIEW_STEPS : STEP_DEFS;
  let stepIdx;
  if (studioCtx.review) stepIdx = 0;
  else stepIdx = Math.max(0, STEP_DEFS.findIndex(s => s.key === stepForStatus(u.status)));
  const current = steps[stepIdx].key;

  studio.innerHTML = `
    <div class="steps">${steps.map((s, i) => `
      <div class="step ${i < stepIdx ? "done" : ""} ${i === stepIdx ? "current" : ""}">
        <span class="n">${i < stepIdx ? "✓" : i + 1}</span>${s.label}
      </div>`).join("")}</div>
    <div class="panel" id="step-panel"></div>
    <div class="panel" id="expr-panel" style="display:none"></div>
  `;

  await showStep(current);
}

async function showStep(key) {
  if (studioCtx) studioCtx.currentStep = key;
  updateStepBar(key);
  const u = studioCtx.unit;
  const panel = $("#step-panel");
  const exprs = $("#expr-panel");
  exprs.style.display = "none";
  exprs.innerHTML = "";
  panel.innerHTML = "";
  checkConsentBanner(u);

  if (key === "r_listen") {
    panel.innerHTML = `
      <div class="panel-title">🎧 复习 · 盲听</div>
      <div class="panel-sub">不看文字，重新听一遍（下次复习：${u.mastery.next_review_at || "—"} · 整体掌握 ${Math.round((u.mastery.overall || 0) * 100)}%）</div>
      ${speakerTag(u)}
      <div class="playbar">
        <button class="btn primary" id="play">▶ 播放</button>
        <button class="btn" id="rate">语速 1x</button>
        <button class="btn" id="loop">🔁 循环</button>
        <button class="btn green" id="r-go">听清了，听写 →</button>
      </div>`;
    bindPlaybar(panel, u, {});
    $("#r-go").addEventListener("click", () => showStep("r_dict"));

  } else if (key === "r_dict") {
    await startSession("review");
    panel.innerHTML = `
      <div class="panel-title">✍️ 复习 · 听写</div>
      <div class="panel-sub">还记得吗？凭记忆把句子打出来（第 ${studioCtx.dictAttempts + 1} 次尝试）</div>
      <div class="playbar">
        <button class="btn primary" id="play">▶ 播放</button>
        <button class="btn" id="rate">语速 1x</button>
        <button class="btn" id="loop">🔁 循环</button>
      </div>
      <textarea class="input" id="dict-input" placeholder="输入你听到的句子…"></textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn green" id="dict-submit">提交</button>
        <button class="btn ghost" id="dict-giveup">忘了，看原文</button>
      </div>
      <div id="dict-result"></div>`;
    bindPlaybar(panel, u, {});
    const input = $("#dict-input");
    input.focus();
    const submit = async () => {
      const val = input.value.trim();
      if (!val) return toast("先输入内容", "error");
      const btn = $("#dict-submit");
      btn.disabled = true;
      try {
        const r = await api(`/api/units/${u.id}/dictation`, {
          method: "POST",
          body: { session_id: studioCtx.sessionId, input: val, assess_only: true },
        });
        studioCtx.dictAttempts++;
        studioCtx.lastDict = r;
        renderDictResult(r, input, submit);
        $("#dict-giveup").remove();
        btn.textContent = r.passed ? "很好，继续 →" : "看原文 →";
        $("#dict-input").disabled = true;
        btn.disabled = false;
        btn.onclick = async () => {
          if (!studioCtx.reviewShownRef && !r.passed) {
            studioCtx.reviewShownRef = true;
            showStep("r_showref");
          } else {
            showStep("r_speak");
          }
        };
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    };
    $("#dict-submit").addEventListener("click", submit);
    $("#dict-giveup").addEventListener("click", async () => {
      studioCtx.dictGiveup = true;
      studioCtx.reviewShownRef = true;
      showStep("r_showref");
    });

  } else if (key === "r_showref") {
    panel.innerHTML = `
      <div class="panel-title">🔎 对照</div>
      <div class="panel-sub">对照原文，找出记错的地方</div>
      ${speakerTag(u)}
      <div class="reference-text">${esc(u.text)}</div>
      ${studioCtx.lastDict ? renderDiffMini(studioCtx.lastDict) : ""}
      <div id="unit-words"></div>
      <div class="btn-row" style="margin-top:8px"><button class="btn sm" id="edit-text">✏️ 原文有误？纠正</button></div>
      <div class="btn-row"><button class="btn primary" id="r-next">记住了，口语复述 →</button></div>`;
    renderUnitWords(u);
    bindTextCorrection(panel, u);
    $("#r-next").addEventListener("click", () => showStep("r_speak"));

  } else if (key === "r_speak") {
    await startSession("review");
    panel.innerHTML = `
      <div class="panel-title">🗣️ 复习 · 口语复述</div>
      <div class="panel-sub">不看原文，用自己的话把这句话说出来（能说出来才是真的记住了）</div>
      <div class="reference-text" style="border-left-color:var(--orange)">🎬 ${esc(scenePromptText(u))}</div>
      <div id="rec-area"></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn green" id="r-speak-submit">提交</button>
      </div>
      <div id="r-speak-result"></div>`;
    const area = $("#rec-area");
    const ta = document.createElement("textarea");
    ta.className = "input";
    ta.placeholder = "录音自动转写，或直接打字";
    studioCtx.recorder = recordUI(area, (text) => { ta.value = text; });
    area.appendChild(ta);
    $("#r-speak-submit").addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) return toast("先录音或输入内容", "error");
      const btn = $("#r-speak-submit");
      btn.disabled = true;
      try {
        const r = await api(`/api/units/${u.id}/speaking`, {
          method: "POST",
          body: { session_id: studioCtx.sessionId, kind: "shadowing", text, assess_only: true },
        });
        studioCtx.reviewSpeak = r;
        const box = $("#r-speak-result");
        box.innerHTML = `
          <div class="result-banner ${r.passed ? "pass" : "fail"}">${r.passed ? "✅ 表达有效" : "💪 再练练"} · 匹配 ${r.match ? r.match.score : 0} 分</div>
          ${r.asr_text ? `<div style="font-size:13px;color:var(--muted);margin-top:8px">你说的是：<b style="color:var(--text)">${esc(r.asr_text)}</b></div>` : ""}
          ${r.evaluation && r.evaluation.feedback_zh ? `<div class="result-banner partial" style="margin-top:8px">🤖 ${esc(r.evaluation.feedback_zh)}</div>` : ""}
          <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="r-finish">完成复习 →</button></div>`;
        $("#r-finish").addEventListener("click", finishReview);
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    });

  } else if (key === "r_done") {
    renderReviewDone();

  } else if (key === "listening") {
    await startSession("blind_listening");
    panel.innerHTML = `
      <div class="panel-title">🎧 盲听</div>
      <div class="panel-sub">不看文字，反复听直到听清每一个词（<b>听不清是正常的</b>，多听几遍）</div>
      ${speakerTag(u)}
      <div class="playbar">
        <button class="btn primary" id="play">▶ 播放</button>
        <button class="btn" id="rate">语速 1x</button>
        <button class="btn" id="loop">🔁 循环</button>
        <button class="btn green" id="done">我听清了，开始听写 →</button>
      </div>`;
    // 盲听播放结束（未开循环时）自动进入听写，可随时回退
    bindPlaybar(panel, u, { onEnd: () => showStep("dictation") });
    $("#done").addEventListener("click", async () => {
      await api(`/api/units/${u.id}/listening`, { method: "POST", body: { session_id: studioCtx.sessionId } });
      studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
      showStep("dictation");
    });

  } else if (key === "dictation") {
    await startSession("dictation");
    panel.innerHTML = `
      <div class="panel-title">✍️ 听写</div>
      <div class="panel-sub">把听到的内容完整打出来（第 ${studioCtx.dictAttempts + 1} 次尝试）</div>
      ${speakerTag(u)}
      <div class="playbar">
        <button class="btn primary" id="play">▶ 播放</button>
        <button class="btn" id="rate">语速 1x</button>
        <button class="btn" id="loop">🔁 循环</button>
      </div>
      <textarea class="input" id="dict-input" placeholder="在这里输入你听到的句子…"></textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn green" id="dict-submit">提交</button>
        <button class="btn ghost" id="dict-giveup">听不出，看原文</button>
      </div>
      <div id="dict-result"></div>`;
    bindPlaybar(panel, u, {});
    const input = $("#dict-input");
    input.focus();
    const submit = async () => {
      const val = input.value.trim();
      if (!val) return toast("先输入内容", "error");
      const btn = $("#dict-submit");
      btn.disabled = true;
      try {
        const r = await api(`/api/units/${u.id}/dictation`, {
          method: "POST",
          body: { session_id: studioCtx.sessionId, input: val },
        });
        studioCtx.dictAttempts++;
        studioCtx.lastDict = r;
        renderDictResult(r, input, submit);
        if (r.passed) {
          // 通过后：恢复按钮可点（此前遗漏 disabled=false 导致“看原文”点了没反应）、
          // 移除“听不出”按钮，主按钮改为明确的下一步
          btn.disabled = false;
          btn.classList.remove("green");
          btn.classList.add("primary");
          btn.textContent = "进入对照理解 →";
          const g = $("#dict-giveup");
          if (g) g.remove();
          btn.onclick = async () => {
            studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
            showStep("reveal");
          };
        } else {
          btn.disabled = false;
          btn.textContent = "再试一次";
        }
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    };
    $("#dict-submit").addEventListener("click", submit);
    $("#dict-giveup").addEventListener("click", async () => {
      await api(`/api/units/${u.id}/reveal`, { method: "POST" });
      studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
      showStep("reveal");
    });

  } else if (key === "reveal") {
    panel.innerHTML = `
      <div class="panel-title">🔎 对照理解</div>
      <div class="panel-sub">对照原文，找出你听错/写错的地方</div>
      ${speakerTag(u)}
      <div class="reference-text">${esc(u.text)}</div>
      ${studioCtx.lastDict ? renderDiffMini(studioCtx.lastDict) : ""}
      <div id="unit-words"></div>
      <div class="btn-row" style="margin-top:8px"><button class="btn sm" id="edit-text">✏️ 原文有误？纠正</button></div>
      <div class="btn-row">
        <button class="btn primary" id="ack">明白了，进入跟读 →</button>
      </div>`;
    renderExpressionsPanel(u);
    renderUnitWords(u);
    bindTextCorrection(panel, u);
    $("#ack").addEventListener("click", async () => {
      const cur = (await api(`/api/units/${u.id}`)).unit;
      if (cur.status === "REVEALED") await api(`/api/units/${u.id}/ack`, { method: "POST" });
      studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
      showStep("shadowing");
    });

  } else if (key === "shadowing") {
    await startSession("shadowing");
    panel.innerHTML = `
      <div class="panel-title">🗣️ 跟读</div>
      <div class="panel-sub">先听原声，然后录下自己说的。目标是语速、语调尽量贴近原声。</div>
      ${speakerTag(u)}
      <div class="playbar">
        <button class="btn primary" id="play">▶ 播放</button>
        <button class="btn" id="rate">语速 1x</button>
        <button class="btn" id="loop">🔁 循环</button>
      </div>
      <div class="reference-text">${esc(u.text)}</div>
      <div id="rec-area"></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn green" id="speak-submit">提交</button>
        <button class="btn ghost" id="speak-skip">跟读困难，跳过</button>
      </div>
      <div id="speak-result"></div>`;
    bindPlaybar(panel, u, {});
    const area = $("#rec-area");
    const ta = document.createElement("textarea");
    ta.className = "input";
    ta.placeholder = "转写结果会填在这里，也可以直接打字";
    // 录音停止后自动转写并自动提交判定（保留手动修改/重录能力）
    studioCtx.recorder = recordUI(area, (text) => { ta.value = text; const b = $("#speak-submit"); if (b) b.click(); });
    area.appendChild(ta);
    $("#speak-submit").addEventListener("click", submitSpeaking);
    $("#speak-skip").addEventListener("click", async () => {
      await api(`/api/units/${u.id}/advance`, { method: "POST", body: { to: "ACTIVE_RECALL" } });
      studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
      showStep("recall");
    });
    async function submitSpeaking() {
      const text = ta.value.trim();
      if (!text) return toast("先录音或输入内容", "error");
      const btn = $("#speak-submit");
      btn.disabled = true;
      try {
        const r = await api(`/api/units/${u.id}/speaking`, {
          method: "POST",
          body: { session_id: studioCtx.sessionId, kind: "shadowing", text },
        });
        renderSpeakResult(r, "跟读", async () => {
          studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
          showStep(r.status === "ACTIVE_RECALL" ? "recall" : "shadowing");
        });
        // 提交后：通过则禁用绿色按钮（避免误点重复提交），失败可重试
        btn.disabled = r.passed;
        btn.textContent = r.passed ? "✅ 已通过" : "再试一次";
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    }

  } else if (key === "recall") {
    await startSession("active_recall");
    const scenePrompt = scenePromptText(u);
    panel.innerHTML = `
      <div class="panel-title">🧠 主动回忆</div>
      <div class="panel-sub">这是最重要的练习：不看原文，自己说出这句话（或表达同一意思的任意说法）</div>
      <div class="reference-text" style="border-left-color:var(--orange);background:var(--bg2)">
        🎬 ${esc(scenePrompt)}
      </div>
      <button class="btn sm" id="recall-hint" style="margin-top:8px">✨ 中文提示（AI）</button>
      <div id="rec-hint-box"></div>
      <div id="rec-area"></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn green" id="recall-submit">提交</button>
        <button class="btn ghost" id="recall-giveup">想不起来，看原文</button>
      </div>
      <div id="recall-ref" style="display:none;margin-top:12px"></div>
      <div id="recall-result"></div>`;
    const refBox = $("#recall-ref", panel);
    const showRef = () => {
      if (refBox.style.display === "none" || !refBox.innerHTML) {
        refBox.innerHTML = `
          <div class="reference-text">${esc(u.text)}</div>
          <div id="recall-unit-words"></div>
          <div class="hint" style="font-size:12px;color:var(--muted);margin-top:6px">记住原文后，再试一次；也可以直接「完成本句」进入下一步。</div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn primary" id="rec-ref-skip">完成本句 →</button>
          </div>`;
        renderUnitWords(u, $("#recall-unit-words"));
        $("#rec-ref-skip", refBox).addEventListener("click", skipRecall);
      }
      refBox.style.display = "block";
      const g = $("#recall-giveup", panel);
      if (g) g.textContent = "收起原文";
    };
    const hideRef = () => { refBox.style.display = "none"; };
    // 回忆失败后直接完成本句：状态 ACTIVE_RECALL → REVIEW_DUE（跳过剩余练习，进入复习周期）
    const skipRecall = async () => {
      try {
        await api(`/api/units/${u.id}/advance`, { method: "POST", body: { to: "REVIEW_DUE" } });
        studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
        showStep("done");
      } catch (e) { toast(e.message, "error"); }
    };
    // 有 LLM 时：句子翻成中文 → 用户看中文回译成英文（无 AI 则隐藏按钮，纯自评）
    getHealth().then(h => {
      if (!h.ai_provider) $("#recall-hint", panel).style.display = "none";
    }).catch(() => { $("#recall-hint", panel).style.display = "none"; });
    $("#recall-hint").addEventListener("click", async () => {
      const btn = $("#recall-hint");
      btn.disabled = true;
      btn.textContent = "生成中…";
      try {
        const r = await api(`/api/units/${u.id}/recall-hint`, { method: "POST" });
        $("#rec-hint-box").innerHTML = `
          <div class="reference-text" style="border-left-color:var(--accent);background:var(--bg2);margin-top:8px">
            💡 中文意思：${esc(r.translation_zh)}
            <div style="font-size:12px;color:var(--muted);margin-top:4px">看中文，把它翻译回英文（贴近原文即可，不必一字不差）</div>
          </div>`;
        btn.textContent = "✨ 重新生成中文提示";
        btn.disabled = false;
      } catch (e) {
        toast(e.message, "error");
        btn.textContent = "✨ 中文提示（AI）";
        btn.disabled = false;
      }
    });
    const area = $("#rec-area");
    const ta = document.createElement("textarea");
    ta.className = "input";
    ta.placeholder = "用自己的话说出来，录音自动转写，或直接打字";
    // 录音停止后自动转写并自动提交判定（保留手动修改/重录能力）
    studioCtx.recorder = recordUI(area, (text) => { ta.value = text; const b = $("#recall-submit"); if (b) b.click(); });
    area.appendChild(ta);
    $("#recall-submit").addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) return toast("先录音或输入内容", "error");
      const btn = $("#recall-submit");
      btn.disabled = true;
      try {
        const r = await api(`/api/units/${u.id}/recall`, {
          method: "POST",
          body: { session_id: studioCtx.sessionId, text },
        });
        renderSpeakResult(r, "主动回忆", async () => {
          studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
          showStep("done");
        }, true, { showRef, skipRecall });
        // 通过后禁用绿色按钮（避免“完成”误点重复提交），完成用结果区蓝色按钮
        btn.disabled = r.passed;
        btn.textContent = r.passed ? "✅ 已通过" : "再试一次";
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    });
    $("#recall-giveup").addEventListener("click", () => {
      if (refBox.style.display === "none" || !refBox.innerHTML) showRef();
      else hideRef();
    });

  } else if (key === "done") {
    bingoFeedback();
    const m = u.mastery;
    panel.innerHTML = `
      <div class="panel-title">🎉 完成！</div>
      <div class="panel-sub">系统已安排下一次复习（${m.next_review_at || "明天"}）。间隔重复会让它真正变成你的。</div>
      <div class="mastery-bar">
        ${[["listening", "听力"], ["dictation", "听写"], ["recall", "回忆"], ["speaking", "口语"]].map(([k, label]) => `
          <div class="mastery-item"><div class="v">${Math.round((m[k] || 0) * 100)}%</div><div class="k">${label}</div></div>`).join("")}
        <div class="mastery-item"><div class="v" style="color:var(--accent2)">${Math.round((m.overall || 0) * 100)}%</div><div class="k">整体</div></div>
      </div>
      <div class="btn-row" style="margin-top:16px">
        ${unitNav.next ? `<a class="btn primary" href="#/unit/${unitNav.next.id}">下一句 →</a>` : ""}
        <a class="btn" href="#/material/${u.material_id}">返回材料</a>
        <a class="btn" href="#/materials">其他材料</a>
      </div>`;
  }

  // 步骤导航：只保留「← 上一步」回退（前进由各面板主按钮承担，避免按钮重复）；
  // 句子切换用两侧悬浮大箭头
  if (key !== "done" && key !== "r_done") {
    const steps = studioCtx.review ? REVIEW_STEPS : STEP_DEFS;
    const idx = steps.findIndex(s => s.key === key);
    if (idx >= 0 && idx > 0) {
      const prevKey = steps[idx - 1].key;
      const nav = document.createElement("div");
      nav.className = "step-nav";
      nav.innerHTML = `
        <button class="btn sm" data-nav="prev">← 上一步</button>
        ${key === "recall" ? `<button class="btn sm primary" data-nav="skip">跳过，完成本句 →</button>` : ""}
      `;
      nav.querySelectorAll("button[data-nav]").forEach(b =>
        b.addEventListener("click", async () => {
          if (b.dataset.nav === "skip") {
            try {
              await api(`/api/units/${u.id}/advance`, { method: "POST", body: { to: "REVIEW_DUE" } });
              studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
              showStep("done");
            } catch (e) { toast(e.message, "error"); }
            return;
          }
          showStep(prevKey);
        }));
      panel.appendChild(nav);
    }
  }
}

async function finishReview() {
  const u = studioCtx.unit;
  const skills = { listening: "pass" };
  skills.dictation = studioCtx.lastDict && studioCtx.lastDict.passed ? "pass" : "fail";
  skills.speaking = studioCtx.reviewSpeak && studioCtx.reviewSpeak.passed ? "pass" : "fail";
  const btn = $("#r-finish");
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/review/${u.id}/complete`, {
      method: "POST",
      body: { skills, session_id: studioCtx.sessionId },
    });
    studioCtx.unit = r.unit;
    studioCtx.reviewResult = r;
    showStep("r_done");
  } catch (e) { toast(e.message, "error"); if (btn) btn.disabled = false; }
}

function renderReviewDone() {
  bingoFeedback();
  const u = studioCtx.unit;
  const m = u.mastery;
  const r = studioCtx.reviewResult || {};
  const panel = $("#step-panel");
  const title = r.status === "MASTERED" ? "🎉 已掌握！" : r.status === "ACTIVE_RECALL" ? "💪 需要再巩固" : "✅ 复习完成";
  const sub = r.status === "MASTERED"
    ? "四项技能都达标，这个单元已经真正属于你了。"
    : r.status === "ACTIVE_RECALL"
      ? "复习没过关，系统已把它退回「主动回忆」阶段，练熟后再进入复习周期。"
      : "复习通过，已安排下一次更长的间隔。";
  panel.innerHTML = `
    <div class="panel-title">${title}</div>
    <div class="panel-sub">${sub}</div>
    <div class="mastery-bar">
      ${[["listening", "听力"], ["dictation", "听写"], ["recall", "回忆"], ["speaking", "口语"]].map(([k, label]) => `
        <div class="mastery-item"><div class="v">${Math.round((m[k] || 0) * 100)}%</div><div class="k">${label}</div></div>`).join("")}
      <div class="mastery-item"><div class="v" style="color:var(--accent2)">${Math.round((m.overall || 0) * 100)}%</div><div class="k">整体</div></div>
    </div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn primary" id="next-review">下一个复习 →</button>
      <a class="btn" href="#/">回到今日</a>
    </div>`;
  $("#next-review").addEventListener("click", async () => {
    try {
      const { due } = await api("/api/review/due");
      if (due.length) location.hash = "#/unit/" + due[0].id;
      else { toast("今天的复习都完成啦 🎉", "success"); location.hash = "#/"; }
    } catch (e) { location.hash = "#/"; }
  });
}

function speakerTag(u) {
  const label = u.speaker === "a" ? "角色 A" : u.speaker === "b" ? "角色 B" : "";
  return label ? `<div class="speaker-tag">${label}</div>` : "";
}

function scenePromptText(u) {
  const sceneMap = {
    restaurant: "在餐厅", doctor: "在看医生", pharmacy: "在药店", shopping: "在商场",
    groceries: "在超市买菜", small_talk: "和陌生人闲聊", phone: "打电话", directions: "问路",
    cooking: "做饭", haircut: "理发", hotel: "在酒店", travel: "在旅途中", office: "在工作中",
    home: "在家里", weather: "聊天气", other: "日常场景",
  };
  const scene = sceneMap[u.scene] || u.scene || "日常场景";
  // 注意：这里绝不能兜底回显原文——主动回忆要求不看原文
  const intent = (u.expressions && u.expressions[0] && u.expressions[0].label) || "";
  return intent ? `${scene}，你要表达：${intent}` : `${scene}，用自己的话回忆这句话（想不起可点下方「看原文」）`;
}

function bindPlaybar(panel, u, { auto, onEnd } = {}) {
  let loop = false;
  let rate = 1;
  attachProgressBar(panel, "prog", "progfill", "ptime");
  $("#play", panel).addEventListener("click", () => playUnit(u, { loop, rate, onEnd }));
  $("#rate", panel).addEventListener("click", (e) => {
    rate = rate === 1 ? 0.8 : 1;
    e.target.textContent = "语速 " + rate + "x";
  });
  $("#loop", panel).addEventListener("click", (e) => {
    loop = !loop;
    e.target.classList.toggle("primary", loop);
    e.target.textContent = loop ? "🔁 循环中" : "🔁 循环";
  });
}

/* 播放进度条：已播/总时长 + 点击跳转。面板销毁时自清理。
   range 播放（导入材料按句定位）时以句首为 0 基准，只显示本句时长。 */
function attachProgressBar(panel, barId, fillId, timeId) {
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  bar.id = barId;
  bar.innerHTML = `<div class="progress-fill" id="${fillId}"></div>`;
  const time = document.createElement("div");
  time.className = "progress-time";
  time.id = timeId;
  time.textContent = "0:00 / 0:00";
  panel.appendChild(bar);
  panel.appendChild(time);
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  const iv = setInterval(() => {
    const a = audioEl;
    const f = $("#" + fillId, panel);
    const t = $("#" + timeId, panel);
    if (!f || !t) { clearInterval(iv); return; }
    const rng = a && a.__range;
    if (!a || !a.duration || (!a.currentTime && !rng)) {
      f.style.width = "0%";
      t.textContent = "0:00 / " + fmt(rng ? (rng.end - rng.start) : (a && a.duration ? a.duration : 0));
      return;
    }
    if (rng) {
      const span = Math.max(0.001, rng.end - rng.start);
      const rel = Math.min(span, Math.max(0, a.currentTime - rng.start));
      f.style.width = ((rel / span) * 100).toFixed(2) + "%";
      t.textContent = fmt(rel) + " / " + fmt(span);
    } else {
      f.style.width = ((a.currentTime / a.duration) * 100).toFixed(2) + "%";
      t.textContent = fmt(a.currentTime) + " / " + fmt(a.duration);
    }
  }, 250);
  bar.addEventListener("click", (e) => {
    const a = audioEl;
    if (!a || !a.duration) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (a.__range) {
      const { start, end } = a.__range;
      a.currentTime = start + ratio * (end - start);
    } else {
      a.currentTime = ratio * a.duration;
    }
  });
}

async function startSession(type) {
  if (!studioCtx.sessionId) {
    const r = await api(`/api/units/${studioCtx.unit.id}/session`, { method: "POST", body: { type } });
    studioCtx.sessionId = r.session_id;
  }
}

function renderDictResult(r, input, submit) {
  const box = $("#dict-result");
  const verdictText = r.verdict === "pass" ? "完全正确 ✅" : r.verdict === "close_enough" ? "几乎正确（仅轻微差异）✅" : "有差异，再听一遍 👂";
  box.innerHTML = `
    <div class="result-banner ${r.passed ? "pass" : "fail"}">${verdictText} <span style="margin-left:auto;font-weight:500">WER ${(r.wer * 100).toFixed(0)}%</span></div>
    ${renderDiff(r.diff)}`;
}

function renderDiffMini(r) {
  return `<div style="font-size:13px;color:var(--muted);margin:8px 0">你的听写（错误已标出）：</div>${renderDiff(r.diff)}`;
}

function renderDiff(diff) {
  if (!diff || !diff.length) return "";
  return `<div class="diff-line">${diff.map(d => {
    if (d.op === "equal") return `<span class="diff-word equal">${esc(d.t)}</span>`;
    if (d.op === "delete") return `<span class="diff-word bad ${d.minor ? "diff-minor" : ""}">${esc(d.t)}</span>`;
    if (d.op === "insert") return `<span class="diff-word good">${esc(d.t)}</span>`;
    // replace: 用户词 ↓ 参考词
    return `<span class="diff-arrow"><span class="diff-word good ${d.minor ? "diff-minor" : ""}">${esc(d.t)}</span><span>↓</span><span class="diff-word bad ${d.minor ? "diff-minor" : ""}">${esc(d.ref)}</span></span>`;
  }).join("")}</div>`;
}

function renderSpeakResult(r, kindName, onContinue, isRecall, recallExtra) {
  const box = $(isRecall ? "#recall-result" : "#speak-result");
  if (!box) return;
  const score = r.match ? r.match.score : 0;
  const ev = r.evaluation || {};
  const banner = r.passed
    ? `<div class="result-banner pass">✅ 表达有效 · 匹配 ${score} 分</div>`
    : `<div class="result-banner fail">💪 再来一次 · 匹配 ${score} 分</div>`;
  const refText = r.asr_text ? `<div style="font-size:13px;color:var(--muted);margin-top:8px">你说的是：<b style="color:var(--text)">${esc(r.asr_text)}</b></div>` : "";
  const evHtml = ev.feedback_zh ? `
    <div class="result-banner ${r.passed ? "pass" : "partial"}" style="margin-top:8px">
      🤖 ${esc(ev.feedback_zh)}${ev.alternative ? `<br><span style="font-weight:400;font-size:13px">更自然：${esc(ev.alternative)}</span>` : ""}
    </div>` : "";
  box.innerHTML = `
    ${banner}${refText}${evHtml}
    ${r.passed && !isRecall ? `<div class="btn-row" style="margin-top:10px"><button class="btn primary" id="cont">进入主动回忆 →</button></div>` : ""}
    ${r.passed && isRecall ? `<div class="btn-row" style="margin-top:10px"><button class="btn primary" id="cont">完成 →</button></div>` : ""}
    ${!r.passed && isRecall && recallExtra ? `
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" id="rec-fail-ref">👀 看原文（不跳步）</button>
        <button class="btn primary" id="rec-fail-skip">跳过，完成本句 →</button>
      </div>` : ""}`;
  const cont = $("#cont", box);
  if (cont) cont.addEventListener("click", onContinue);
  if (!r.passed && isRecall && recallExtra) {
    $("#rec-fail-ref", box).addEventListener("click", () => recallExtra.showRef());
    $("#rec-fail-skip", box).addEventListener("click", () => recallExtra.skipRecall());
  }
}

function renderExpressionsPanel(u) {
  const exprs = u.expressions || [];
  const panel = $("#expr-panel");
  if (!exprs.length) return;
  panel.style.display = "block";
  panel.innerHTML = `
    <div class="panel-title">💎 高价值表达</div>
    <div class="panel-sub">学表达，不学单词 — 记住「意图 → 说法」</div>
    ${exprs.map(e => `
      <div class="expr-item">
        <div class="expr-en">${esc(e.expression)}</div>
        ${e.meaning ? `<div class="expr-zh">${esc(e.meaning)}</div>` : ""}
        ${e.intent ? `<div class="expr-zh">意图：${esc(e.intent)}${e.source === "llm" ? " <span class='badge NEW'>AI</span>" : ""}</div>` : ""}
        ${e.variants && e.variants.length ? `<div class="expr-vars">${e.variants.map(v => `<span class="expr-var">${esc(v)}</span>`).join("")}</div>` : ""}
        <div class="btn-row" style="margin-top:6px">
          <button class="btn sm save-expr" data-expr="${esc(e.expression)}" data-meaning="${esc(e.meaning || e.intent || "")}">⭐ 收藏到生词本</button>
        </div>
      </div>`).join("")}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn sm" id="enhance-btn">✨ AI 增强（可选）</button>
      <button class="btn sm" id="listen-expr">🔊 听原文</button>
    </div>`;
  // 收藏表达到生词本（后续可在材料页生词面板复习回顾）
  $$(".save-expr", panel).forEach(b => b.addEventListener("click", async () => {
    try {
      const r = await api(`/api/materials/${u.material_id}/focus/expressions`, {
        method: "POST",
        body: { items: [{ expression: b.dataset.expr, meaning: b.dataset.meaning, unit_id: u.id }] },
      });
      b.disabled = true;
      b.textContent = r.saved ? "✅ 已收藏" : "已在生词本";
      toast(r.saved ? "已加入生词本，可在材料页回顾" : "这个表达已经在生词本里了", r.saved ? "success" : "");
    } catch (err) { toast(err.message, "error"); }
  }));
  $("#enhance-btn").addEventListener("click", async () => {
    try {
      const r = await api(`/api/units/${u.id}/enhance`, { method: "POST" });
      toast("AI 增强完成", "success");
      studioCtx.unit = (await api(`/api/units/${u.id}`)).unit;
      renderExpressionsPanel(studioCtx.unit);
    } catch (e) {
      if (e.status === 428) consentModal(() => $("#enhance-btn").click());
      else toast(e.message, "error");
    }
  });
  $("#listen-expr").addEventListener("click", () => playUnit(u, { loop: true }));
}

/* ---------- AI 隐私同意 ---------- */
let consentChecked = false;

async function checkConsentBanner(u) {
  const box = $("#step-panel");
  if (consentChecked) return;
  try {
    const [health, priv] = await Promise.all([api("/api/health"), api("/api/ai/privacy")]);
    if (!health.ai_provider || priv.consent !== "ask") return;
    consentChecked = true;
    const banner = document.createElement("div");
    banner.className = "consent-banner";
    banner.innerHTML = `
      <b>🔒 隐私提示</b>：你配置了 AI Provider。跟读/回忆评估时，会把你说的句子发给该 Provider 做语义评价。<br>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn sm" data-a="grant">仅本次允许</button>
        <button class="btn sm" data-a="allow">始终允许</button>
        <button class="btn sm ghost" data-a="never">禁止发送</button>
      </div>`;
    box.prepend(banner);
    $$("[data-a]", banner).forEach(b => b.addEventListener("click", async () => {
      await api("/api/ai/consent", { method: "POST", body: { action: b.dataset.a } });
      banner.remove();
      toast(b.dataset.a === "never" ? "已禁止发送（本地判定仍可用）" : "已保存", "success");
    }));
  } catch (e) { /* ignore */ }
}

function consentModal(onGrant) {
  modal(`
    <h3>🔒 发送到 AI Provider</h3>
    <div class="page-sub" style="color:var(--muted);font-size:13px;margin:8px 0">
      将把<b>当前句子</b>发送给你配置的 AI Provider（如 OpenAI / Ollama）进行语义评估。
      数据只用于本次评估，不会上传到 DeepSpeak 服务器（本应用没有服务器）。
    </div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn primary" id="c-grant">仅本次允许</button>
      <button class="btn" id="c-allow">始终允许</button>
      <button class="btn ghost" id="c-never">禁止</button>
    </div>`);
  $("#c-grant").addEventListener("click", async () => {
    await api("/api/ai/consent", { method: "POST", body: { action: "grant" } });
    closeModal(); onGrant();
  });
  $("#c-allow").addEventListener("click", async () => {
    await api("/api/ai/consent", { method: "POST", body: { action: "allow" } });
    closeModal(); onGrant();
  });
  $("#c-never").addEventListener("click", async () => {
    await api("/api/ai/consent", { method: "POST", body: { action: "never" } });
    closeModal();
  });
}

/* ================= 复习 ================= */
async function viewReview() {
  const [focusRes, unitRes] = await Promise.all([api("/api/focus/due"), api("/api/review/due")]);
  const focusDue = focusRes.due || [];
  const due = unitRes.due || [];
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">复习队列</div>
        <div class="page-sub">整段回炉 ${focusDue.length} 篇 · 单句到期 ${due.length} 个</div>
      </div>
    </div>`;
  if (!focusDue.length && !due.length) {
    v.insertAdjacentHTML("beforeend", `<div class="empty"><div class="big">🌴</div><div>今天没有到期复习</div></div>`);
    return;
  }
  if (focusDue.length) {
    v.insertAdjacentHTML("beforeend", `
      <div class="section-title">🎧 整段回炉（重听 + 脱稿复述）</div>
      <div class="grid" id="focus-due-list"></div>`);
    const fl = $("#focus-due-list");
    fl.innerHTML = focusDue.map(f => `
      <div class="card review-card hover" data-mid="${f.material_id}">
        <div style="flex:1;min-width:0">
          <div class="mat-title">${esc(f.title)}</div>
          <div style="margin-top:6px">
            <span class="chip">${f.scene_emoji} ${esc(f.scene_label)}</span>
            <span style="font-size:12px;color:var(--muted);margin-left:8px">间隔复习 #${f.reviews_done + 1} · 下次：${esc(f.next_review_at || "")}</span>
          </div>
        </div>
        <div class="mastery-mini"><b style="color:var(--orange)">回炉</b></div>
      </div>`).join("");
    $$("#focus-due-list .review-card").forEach(c => c.addEventListener("click", () => {
      location.hash = "#/focus/" + c.dataset.mid + "?review=1";
    }));
  }
  if (due.length) {
    v.insertAdjacentHTML("beforeend", `
      <div class="section-title">📄 单句复习</div>
      <div class="grid" id="unit-due-list"></div>`);
    const list = $("#unit-due-list");
    list.innerHTML = due.map(u => `
      <div class="card review-card hover" data-id="${u.id}">
        <div class="unit-seq">${u.seq}</div>
        <div style="flex:1;min-width:0">
          <div class="unit-text" style="white-space:normal">${esc(u.text)}</div>
          <div style="margin-top:6px">
            <span class="badge ${u.status}">${STATUS_LABEL[u.status] || u.status}</span>
            <span style="font-size:12px;color:var(--muted);margin-left:8px">下次：${esc(u.mastery.next_review_at || "")}</span>
          </div>
        </div>
        <div class="mastery-mini">
          <b style="color:var(--accent2)">${Math.round((u.mastery.overall || 0) * 100)}%</b>
          <span style="font-size:11px;color:var(--muted)">整体掌握</span>
        </div>
      </div>`).join("");
    $$("#unit-due-list .review-card").forEach(c => c.addEventListener("click", () => {
      location.hash = "#/unit/" + c.dataset.id;
    }));
  }
}

/* ================= 整段精听（尚雯婕法） ================= */
let focusCtx = null;  // {mid, material, focus, reviewMode, dictAnswers, words}

function focusFullAudio() {
  const url = dsLocalEngine
    ? `assets/audio/full_${focusCtx.mid}.wav`
    : `/api/audio/material/${focusCtx.mid}/full.wav`;
  return { audio: { url, start_ms: 0, end_ms: 0, kind: "file" } };
}

function focusStepForStatus(status) {
  if (status === "new" || status === "listening") return "listen";
  if (status === "dictation") return "dictation";
  if (status === "shadowing") return "shadowing";
  if (status === "review_due" || status === "mastered") return "done";
  return "offscript";
}

function wordDiff(userText, refText) {
  /* 前端"红笔校对"：词级 diff（与后端 token_diff 同构），仅作校对参考，不判分。 */
  const a = String(userText || "").toLowerCase().split(/\s+/).filter(Boolean);
  const b = String(refText || "").toLowerCase().split(/\s+/).filter(Boolean);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: "equal", t: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: "delete", t: a[i] }); i++; }
    else { out.push({ op: "insert", t: b[j] }); j++; }
  }
  while (i < n) { out.push({ op: "delete", t: a[i] }); i++; }
  while (j < m) { out.push({ op: "insert", t: b[j] }); j++; }
  // 相邻 insert+delete 合并为 replace
  const merged = [];
  for (const d of out) {
    const last = merged[merged.length - 1];
    if (d.op === "insert" && last && last.op === "delete") {
      last.op = "replace"; last.ref = d.t;
    } else if (d.op === "delete" && last && last.op === "insert") {
      last.op = "replace"; last.ref = last.t; last.t = d.t;
    } else merged.push(d);
  }
  return merged;
}

async function viewFocus(hash) {
  const mid = parseInt(hash.split("/")[2], 10);
  const reviewMode = /review=1/.test(hash);
  const { material: m } = await api(`/api/materials/${mid}`);
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/material/${mid}" style="font-size:13px">← 返回材料</a>
        <div class="page-title">🎧 整段精听</div>
        <div class="page-sub">${esc(m.title)}</div>
      </div>
    </div>
    <div id="focus-body"></div>`;
  focusCtx = { mid, material: m, focus: m.focus, reviewMode, dictAnswers: [], words: "" };
  try {
    const { settings } = await api("/api/settings");
    focusCtx.freeNav = settings.focus_free_nav === "1" || settings.focus_free_nav === "true";
  } catch (e) { focusCtx.freeNav = false; }
  await ensureFocusAudio();
  renderFocusBody();
}

const PROCESS_STEP_LABELS = {
  download: "下载音频",
  preparing: "准备中",
  transcribing: "语音转写中",
  building: "生成训练单元",
  generating: "AI 生成对话中",
  synthesizing: "语音合成中",
  done: "完成",
  error: "处理失败",
};

async function ensureFocusAudio() {
  if (focusCtx.material.focus.audio_ready) return;
  const body = $("#focus-body");
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `<span class="spin"></span> <span id="focus-wait-text">正在生成整段音频…</span>`;
  body.appendChild(panel);
  focusCtx.pollStop = false;
  try { await api(`/api/materials/${focusCtx.mid}/focus/prepare`, { method: "POST" }); } catch (e) { /* ignore */ }
  for (let i = 0; i < 120; i++) {
    if (focusCtx.pollStop) return; // 用户已切换页面，停止轮询
    await new Promise(r => setTimeout(r, 2000));
    let m = null;
    try { ({ material: m } = await api(`/api/materials/${focusCtx.mid}`)); } catch (e) { continue; }
    const txt = $("#focus-wait-text");
    if (txt) {
      const step = (m && m.process_step) || "";
      const pct = (m && m.process_pct) || 0;
      const label = PROCESS_STEP_LABELS[step] || (m && m.status === "error" ? "处理失败" : "生成中");
      if (m && m.status === "error") {
        txt.textContent = `生成失败：${m.description || "未知错误"}。可返回重新处理。`;
        break;
      }
      if (step === "done") break;
      txt.textContent = pct > 0
        ? `正在${label}… ${pct}%`
        : `正在${label}…`;
    }
    if (m && m.focus && m.focus.audio_ready) { focusCtx.focus = m.focus; return; }
  }
  if (focusCtx.pollStop) return;
  toast("整段音频生成超时，请稍后重试", "error");
}

function renderFocusBody() {
  const f = focusCtx.focus;
  const body = $("#focus-body");
  const stepsDone = [["listen", f.listen_count > 0], ["dictation", !!f.dict_done],
                     ["shadowing", !!f.shadow_done], ["offscript", !!f.offscript_done]];
  const freeNav = !!focusCtx.freeNav && f.status !== "review_due" && f.status !== "mastered";
  body.innerHTML = `
    <div class="focus-steps-bar">
      ${FOCUS_STEPS.map(s => {
        const done = stepsDone.find(x => x[0] === s.key)[1];
        const cur = focusStepForStatus(f.status) === s.key && !focusCtx.reviewMode;
        const cls = `focus-step ${done ? "done" : ""} ${cur ? "cur" : ""}${freeNav ? " clickable" : ""}`;
        const tag = freeNav ? `<button class="${cls}" data-step="${s.key}" title="${s.desc}">${done ? "✓" : "·"} ${s.label}</button>`
                            : `<span class="${cls}" title="${s.desc}">${done ? "✓" : "·"} ${s.label}</span>`;
        return tag;
      }).join("")}
      ${f.status === "review_due" || f.status === "mastered" ? `<span class="chip gray">回炉复习 · 第 ${f.reviews_done + 1} 次</span>` : ""}
      ${freeNav ? `<span class="hint" style="font-size:12px;color:var(--muted)">自由导航已开启：可直接点击步骤跳转/跳过</span>` : ""}
    </div>
    <div id="focus-panel"></div>`;
  if (freeNav) {
    $$("[data-step]", body).forEach(b => b.addEventListener("click", () => jumpFocusStep(b.dataset.step)));
  }
  if (focusCtx.reviewMode) renderFocusReview();
  else renderFocusTrain();
}

/* 自由导航：计算从当前状态到目标步骤的动作序列并逐步执行 */
async function jumpFocusStep(targetKey) {
  const status = focusCtx.focus.status;
  const cur = focusStepForStatus(status);
  const order = ["listen", "dictation", "shadowing", "offscript"];
  const curIdx = order.indexOf(cur);
  const tgtIdx = order.indexOf(targetKey);
  if (tgtIdx < 0 || curIdx < 0 || tgtIdx === curIdx) return;
  if (status === "review_due" || status === "mastered") { toast("复习阶段请按流程走", ""); return; }

  const acts = [];
  if (tgtIdx > curIdx) {
    for (let s = curIdx; s < tgtIdx; s++) acts.push(["listen_done", "dict_done", "shadow_done"][s]);
  } else {
    for (let s = curIdx; s > tgtIdx; s--) acts.push("back");
  }
  const target = FOCUS_STEPS[tgtIdx];
  const skipped = tgtIdx > curIdx
    ? order.slice(curIdx + 1, tgtIdx).map(k => FOCUS_STEPS.find(s => s.key === k).label)
    : order.slice(tgtIdx, curIdx).map(k => FOCUS_STEPS.find(s => s.key === k).label);
  const msg = `跳到「${target.label}」？\n\n${target.desc}\n${skipped.length ? `（会跳过：${skipped.join("、")}）` : "（回退上一步）"}`;
  if (!confirm(msg)) return;
  for (const a of acts) await focusAct(a);
}

async function focusAct(action) {
  try {
    const { focus } = await api(`/api/materials/${focusCtx.mid}/focus`, { method: "POST", body: { action } });
    focusCtx.focus = focus;
    renderFocusBody();
  } catch (e) {
    toast(e.message || "操作失败，请重试", "error");
  }
}

function focusPlaybar(loop = false) {
  return `
    <div class="playbar">
      <button class="btn primary" id="fplay">▶ 播放整段</button>
      <button class="btn" id="fpause">⏸ 暂停</button>
      <button class="btn" id="fback" title="回退 10 秒">⏪ 10s</button>
      <button class="btn" id="ffwd" title="前进 10 秒">⏩ 10s</button>
      <button class="btn" id="frate">语速 1x</button>
      <button class="btn" id="floop">${loop ? "🔁 循环中" : "🔁 循环"}</button>
    </div>`;
}

function bindFocusPlaybar(panel, { loop = false, onEnd } = {}) {
  let l = loop, rate = 1;
  attachProgressBar(panel, "fprog", "fprogfill", "ftime");
  const pauseBtn = $("#fpause", panel);
  const syncPauseLabel = () => {
    pauseBtn.textContent = audioEl && !audioEl.paused ? "⏸ 暂停" : "▶ 继续";
  };
  $("#fplay", panel).addEventListener("click", () => {
    playUnit(focusFullAudio(), { loop: l, rate, onEnd });
    pauseBtn.textContent = "⏸ 暂停";
  });
  pauseBtn.addEventListener("click", () => {
    if (!audioEl) return;
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
    syncPauseLabel();
  });
  $("#fback", panel).addEventListener("click", () => {
    if (audioEl) audioEl.currentTime = Math.max(0, (audioEl.currentTime || 0) - 10);
  });
  $("#ffwd", panel).addEventListener("click", () => {
    if (audioEl) audioEl.currentTime = (audioEl.currentTime || 0) + 10;
  });
  $("#frate", panel).addEventListener("click", (e) => {
    rate = rate === 1 ? 0.8 : 1;
    e.target.textContent = "语速 " + rate + "x";
  });
  $("#floop", panel).addEventListener("click", (e) => {
    l = !l;
    e.target.classList.toggle("primary", l);
    e.target.textContent = l ? "🔁 循环中" : "🔁 循环";
  });
}

function renderFocusTrain() {
  const f = focusCtx.focus;
  const step = focusStepForStatus(f.status);
  const panel = $("#focus-panel");
  if (step === "done") { renderFocusDone(); return; }
  if (step === "listen") {
    panel.innerHTML = `
      <div class="panel">
        <div class="panel-title">🎧 第一步 · 通听</div>
        <div class="panel-sub">不看文字，把整段反复听。刚开始只能听出零星单词是正常的——多听几遍，直到每个词都清晰。</div>
        ${focusPlaybar(true)}
        <div class="hint" style="margin-top:10px">已通听 <b>${f.listen_count || 0}</b> 遍</div>
        <div class="btn-row">
          <button class="btn" id="f-again">🔁 再听一遍</button>
          <button class="btn primary" id="f-heard">听出大意了，开始听写 →</button>
        </div>
      </div>`;
    bindFocusPlaybar(panel, { loop: true, onEnd: () => focusAct("listen_done") });
    $("#f-again").addEventListener("click", () => focusAct("listen_again"));
    $("#f-heard").addEventListener("click", () => focusAct("listen_done"));
  } else if (step === "dictation") {
    panel.innerHTML = `
      <div class="panel">
        <div class="panel-title">✍️ 第二步 · 逐句听写</div>
        <div class="panel-sub">逐句播放，把听到的如实写下来。听不出的先空着，别为一个小词卡壳。输入会自动保存，中途退出不会丢。</div>
        <div id="f-dict-list"></div>
        <div class="btn-row">
          <button class="btn primary" id="f-check">✍️ 写完了，红笔校对 →</button>
        </div>
      </div>`;
    const list = $("#f-dict-list");
    const draft = loadFocusDraft();
    list.innerHTML = focusCtx.material.units.map((u, i) => `
      <div class="focus-dict-row" data-i="${i}">
        <button class="btn sm" data-play="${i}" title="播放这句">🔊</button>
        <span class="unit-seq">${i + 1}</span>
        <textarea class="input" data-ta="${i}" rows="1" placeholder="写下你听到的…">${draft && draft[i] != null ? esc(draft[i]) : ""}</textarea>
        <span class="focus-mic" data-mic="${i}"></span>
      </div>`).join("");
    if (draft) focusCtx.dictAnswers = draft.map(s => (s || "").trim());
    const collectDict = () => {
      focusCtx.dictAnswers = $$("[data-ta]", list).map(ta => ta.value.trim());
      return focusCtx.dictAnswers;
    };
    $$("[data-ta]", list).forEach(ta => ta.addEventListener("input", () => {
      collectDict();
      saveFocusDraft();
    }));
    $$("[data-play]", list).forEach(b => b.addEventListener("click", () => {
      playUnit({ audio: focusCtx.material.units[+b.dataset.play].audio });
    }));
    // 语音输入：ASR 可用才显示 🎤（零 AI 原则下纯打字也可）
    getHealth().then(h => {
      if (!h.asr_available) return;
      $$("[data-mic]", list).forEach(micEl => {
        const ta = $(`[data-ta="${micEl.dataset.mic}"]`, list);
        recordUI(micEl, (text) => {
          ta.value = text;
          collectDict();
          saveFocusDraft();
        }, { compact: true });
      });
    }).catch(() => {});
    $("#f-check").addEventListener("click", () => {
      focusCtx.dictAnswers = collectDict();
      renderFocusProof();
    });
  } else if (step === "shadowing") {
    panel.innerHTML = `
      <div class="panel">
        <div class="panel-title">🗣️ 第三步 · 跟读模仿</div>
        <div class="panel-sub">先逐句「听一句 → 暂停 → 模仿一句」；熟练后跟着原声一起说，注意语速、重音、停顿。</div>
        <div class="unit-list" id="f-shadow-list"></div>
        <div class="section-title">整段同步跟读</div>
        <div class="reference-text focus-fulltext">${focusCtx.material.units.map(u => esc(u.text)).join(" ")}</div>
        ${focusPlaybar(true)}
        <div class="btn-row">
          <button class="btn primary" id="f-shadow-done">跟得上了，进入脱稿 →</button>
        </div>
      </div>`;
    const list = $("#f-shadow-list");
    list.innerHTML = focusCtx.material.units.map((u, i) => `
      <div class="unit-row">
        <button class="btn sm" data-play="${i}">🔊</button>
        <div class="unit-text" style="white-space:normal">${esc(u.text)}</div>
      </div>`).join("");
    $$("[data-play]", list).forEach(b => b.addEventListener("click", () => {
      playUnit({ audio: focusCtx.material.units[+b.dataset.play].audio });
    }));
    bindFocusPlaybar(panel, { loop: true });
    $("#f-shadow-done").addEventListener("click", () => focusAct("shadow_done"));
  } else if (step === "offscript") {
    panel.innerHTML = `
      <div class="panel">
        <div class="panel-title">📖 第四步 · 背诵脱稿</div>
        <div class="panel-sub">合上文本！跟着音频的节奏自己念出来，直到能像原声一样说出来。</div>
        ${focusPlaybar(true)}
        <div class="hint" style="margin-top:10px;color:var(--muted)">（这一页没有文字——试着不看任何提示）</div>
        <div class="btn-row">
          <button class="btn" id="f-off-back">回到跟读</button>
          <button class="btn primary" id="f-off-done">能按原声念出来了！完成 →</button>
        </div>
        <div class="recite-box" style="margin-top:16px;border-top:1px dashed var(--border);padding-top:14px">
          <div class="panel-title">🎙 整段背诵对照（可选）</div>
          <div class="panel-sub">不看文字把整段说出来：录音自动转写，或直接打字，然后对照全文看准确率</div>
          <div id="recite-mic" style="margin-top:8px"></div>
          <textarea class="input" id="recite-ta" rows="3" placeholder="背诵内容会填在这里，也可以直接打字…" style="margin-top:8px"></textarea>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn primary" id="recite-submit">📊 对照评分</button>
          </div>
          <div id="recite-result"></div>
        </div>
      </div>`;
    bindFocusPlaybar(panel, { loop: true });
    $("#f-off-back").addEventListener("click", () => focusAct("back"));
    $("#f-off-done").addEventListener("click", () => focusAct("offscript_done"));
    // 整段背诵：ASR 可用时显示话筒（录音停止自动转写填入）
    getHealth().then(h => {
      if (!h.asr_available) return;
      recordUI($("#recite-mic"), (text) => { $("#recite-ta").value = text; });
    }).catch(() => { /* 无 ASR：纯打字 */ });
    $("#recite-submit").addEventListener("click", async () => {
      const ta = $("#recite-ta");
      const text = ta.value.trim();
      if (!text) return toast("先背诵输入内容（录音或打字）", "error");
      const btn = $("#recite-submit");
      btn.disabled = true;
      try {
        const r = await api(`/api/materials/${focusCtx.mid}/focus/recite`, {
          method: "POST", body: { text },
        });
        const acc = Math.round((1 - r.wer) * 100);
        const verdict = r.passed ? "🎉 整段背诵通过" : "💪 再练练";
        $("#recite-result").innerHTML = `
          <div class="result-banner ${r.passed ? "pass" : "fail"}" style="margin-top:12px">
            ${verdict} · 准确率 ${acc}%（正确 ${r.correct}/${r.total} 词）
          </div>
          <div class="recite-diff">${renderReciteDiff(r.diff)}</div>`;
      } catch (e) { toast(e.message, "error"); }
      btn.disabled = false;
    });
  }
}

/* 整段背诵 diff 渲染：正确词绿、漏词红（删除）、多词黄（插入）、替换红黄 */
function renderReciteDiff(diff) {
  if (!diff || !diff.length) return "";
  let html = "";
  for (const d of diff) {
    if (d.op === "equal") html += `<span class="rd-ok">${esc(d.t)}</span>`;
    else if (d.op === "delete") html += `<span class="rd-miss">${esc(d.t)}</span>`;
    else if (d.op === "insert") html += `<span class="rd-extra">${esc(d.t)}</span>`;
    else html += `<span class="rd-miss">${esc(d.ref)}</span>`;
    html += " ";
  }
  return `<div class="reference-text" style="margin-top:8px">${html}</div>
    <div class="hint" style="font-size:12px;color:var(--muted);margin-top:6px">
      <span class="rd-ok">绿</span>=对 · <span class="rd-miss">红</span>=漏/错 · <span class="rd-extra">黄</span>=多背的</div>`;
}

/* ================= 听写草稿（localStorage 自动保存） ================= */
function focusDraftKey() { return "focus_dict_draft_" + focusCtx.mid; }
function saveFocusDraft() {
  const list = $("#f-dict-list");
  if (!list) return;
  try { localStorage.setItem(focusDraftKey(), JSON.stringify($$("[data-ta]", list).map(ta => ta.value))); } catch (e) { /* ignore */ }
}
function loadFocusDraft() {
  try {
    const raw = localStorage.getItem(focusDraftKey());
    if (!raw) return null;
    const vals = JSON.parse(raw);
    return Array.isArray(vals) ? vals : null;
  } catch (e) { return null; }
}
function clearFocusDraft() {
  try { localStorage.removeItem(focusDraftKey()); } catch (e) { /* ignore */ }
}

/* 红笔校对重建行：正确词绿色；漏写/多写/写错 → 空白（不显示原文）。
   简单模式：漏词处给占位方块（能看出漏了几个词）；困难模式：一律空白不提示数量。 */
function renderProofReconstruct(diff, mode) {
  let html = "";
  for (const d of diff) {
    if (d.op === "equal") { html += `<span class="diff-word equal">${esc(d.t)}</span> `; continue; }
    if (d.op === "insert") {
      const n = Math.max(1, d.t.trim().split(/\s+/).length);
      html += mode === "easy"
        ? `<span class="proof-gap">${"▢".repeat(Math.min(n, 8))}</span> `
        : `<span class="proof-blank">&nbsp;</span> `;
      continue;
    }
    // delete（多写）/ replace（写错）→ 空白
    html += `<span class="proof-blank">&nbsp;</span> `;
  }
  return html;
}

function renderFocusProof() {
  const panel = $("#focus-panel");
  const units = focusCtx.material.units;
  const wrongWords = [];
  const mode = localStorage.getItem("focus_proof_mode") === "hard" ? "hard" : "easy";
  // 逐句正确率统计（保存到 focus_dictations 供「进步对比」）
  focusCtx.proofResults = units.map((u, i) => {
    const mine = focusCtx.dictAnswers[i] || "";
    const diff = wordDiff(mine, u.text);
    let correct = 0;
    diff.forEach(d => {
      if (d.op === "equal") correct++;
      else if (d.op === "delete" || d.op === "replace") wrongWords.push(d.t);
    });
    return { unit_id: u.id, correct, total: u.text.trim().split(/\s+/).length || 1 };
  });
  panel.innerHTML = `
    <div class="panel">
      <div class="panel-title">🔴 红笔校对</div>
      <div class="panel-sub">先别看原文——绿色是你听对的词，空白处就是和原文有出入的地方。差异大多来自发音记错、连读弱读没听出来。</div>
      <div class="proof-toolbar">
        <span class="proof-mode">
          <button class="btn sm ${mode === "easy" ? "primary" : ""}" id="f-mode-easy">😌 简单</button>
          <button class="btn sm ${mode === "hard" ? "primary" : ""}" id="f-mode-hard">🤔 困难</button>
        </span>
        <button class="btn sm" id="f-show-ref">👁 显示原文</button>
      </div>
      <div id="f-proof-list"></div>
      <div class="section-title">📝 生词和词组</div>
      <div class="word-chips" id="f-word-chips"></div>
      <div class="word-add-row">
        <input class="input" id="f-word-input" placeholder="补充你想记的生词 / 词组…" style="flex:1;min-height:38px">
        <button class="btn sm" id="f-word-add">＋ 添加</button>
      </div>
      <div class="btn-row">
        <button class="btn" id="f-proof-back">回去改</button>
        <button class="btn primary" id="f-save-words">📒 保存生词</button>
        <button class="btn primary" id="f-proof-done">校对完毕，进入跟读 →</button>
      </div>
    </div>`;
  const list = $("#f-proof-list");
  list.innerHTML = units.map((u, i) => {
    const mine = focusCtx.dictAnswers[i] || "";
    const diff = wordDiff(mine, u.text);
    let correct = 0;
    diff.forEach(d => { if (d.op === "equal") correct++; });
    const total = u.text.trim().split(/\s+/).length;
    const empty = !mine;
    return `
      <div class="focus-proof-row">
        <div class="focus-proof-head"><span class="unit-seq">${i + 1}</span>
          <button class="btn sm" data-play="${i}">🔊 再听</button>
          <span class="proof-score">${empty ? "没写" : `✅ ${correct}/${total}`}</span></div>
        <div class="label">你听到的</div>
        ${empty
          ? `<div class="proof-reconstruct muted">（空着没写——先回去听一遍，或展开原文认认发音）</div>`
          : `<div class="proof-reconstruct">${renderProofReconstruct(diff, mode)}</div>`}
        <div class="proof-ref" style="display:none"><div class="label">原文</div><div class="reference-text">${esc(u.text)}</div></div>
      </div>`;
  }).join("");
  $$("[data-play]", list).forEach(b => b.addEventListener("click", () => {
    playUnit({ audio: units[+b.dataset.play].audio });
  }));
  $("#f-mode-easy").addEventListener("click", () => {
    localStorage.setItem("focus_proof_mode", "easy");
    renderFocusProof();
  });
  $("#f-mode-hard").addEventListener("click", () => {
    localStorage.setItem("focus_proof_mode", "hard");
    renderFocusProof();
  });
  const showBtn = $("#f-show-ref");
  showBtn.addEventListener("click", () => {
    const refs = $$(".proof-ref", list);
    const showing = refs[0] && refs[0].style.display !== "none";
    refs.forEach(r => { r.style.display = showing ? "none" : ""; });
    showBtn.textContent = showing ? "👁 显示原文" : "🙈 收起原文";
  });

  // 生词：系统推荐（听错的词，默认保留，可 ✕ 删除）+ 用户自写（去重保存）
  const recWords = [...new Set(wrongWords)].filter(w => w.length > 1);
  const wordSet = new Set([
    ...(focusCtx.words || "").split(/[,，]/).map(s => s.trim()).filter(Boolean),
    ...recWords,
  ]);
  const chipsBox = $("#f-word-chips");
  const renderChips = () => {
    const all = [...wordSet].map(w => ({ w, rec: recWords.includes(w) }));
    chipsBox.innerHTML = all.length ? all.map(({ w, rec }) => `
      <span class="word-chip ${rec ? "rec" : ""}">${rec ? "🤖 " : ""}${esc(w)}
        <button class="chip-x" data-w="${esc(w)}">✕</button></span>`).join("")
      : `<span class="hint" style="color:var(--muted);font-size:13px">没有推荐生词——需要记的话直接在下面添加</span>`;
    $$(".chip-x", chipsBox).forEach(b => b.addEventListener("click", () => {
      wordSet.delete(b.dataset.w);
      renderChips();
    }));
  };
  renderChips();
  $("#f-word-add").addEventListener("click", () => {
    const v = $("#f-word-input").value.trim();
    if (!v) return;
    wordSet.add(v);
    $("#f-word-input").value = "";
    renderChips();
  });
  $("#f-word-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#f-word-add").click(); }
  });
  $("#f-save-words").addEventListener("click", async () => {
    if (!wordSet.size) return toast("还没有要保存的生词", "");
    const btn = $("#f-save-words");
    btn.disabled = true;
    try {
      const items = [...wordSet].map(expression => ({ expression, unit_id: null }));
      const r = await api(`/api/materials/${focusCtx.mid}/focus/expressions`, { method: "POST", body: { items } });
      toast(`已保存 ${r.saved} 个生词到材料生词本（重复的自动跳过）`, "success");
    } catch (e) { toast(e.message, "error"); }
    btn.disabled = false;
  });
  $("#f-proof-back").addEventListener("click", () => renderFocusTrain());
  $("#f-proof-done").addEventListener("click", async () => {
    focusCtx.words = [...wordSet].join(", ");
    clearFocusDraft();
    // 记录本次听写准确率（供进步对比），失败不阻塞流程
    try {
      await api(`/api/materials/${focusCtx.mid}/focus/dictation-result`, {
        method: "POST", body: { results: focusCtx.proofResults },
      });
    } catch (e) { /* ignore */ }
    focusAct("dict_done");
  });
}

function renderFocusDone() {
  const f = focusCtx.focus;
  const panel = $("#focus-panel");
  panel.innerHTML = `
    <div class="panel">
      <div class="panel-title">🎉 完成！</div>
      <div class="panel-sub">定时回炉很重要——系统已安排 <b>${esc((f.next_review_at || "").slice(5, 16))}</b> 再听一遍、再念一遍。</div>
      <div class="mastery-bar">
        <div class="mastery-item"><div class="v">${f.listen_count || 0} 遍</div><div class="k">通听</div></div>
        <div class="mastery-item"><div class="v">${f.offscript_done ? "✓" : "·"}</div><div class="k">脱稿</div></div>
        <div class="mastery-item"><div class="v">${f.reviews_done}</div><div class="k">回炉</div></div>
        <div class="mastery-item"><div class="v">${focusCtx.words ? focusCtx.words.split(/[,，\n]/).filter(Boolean).length : 0}</div><div class="k">生词</div></div>
      </div>
      ${focusCtx.words ? `<div class="hint" style="margin-top:8px">📝 ${esc(focusCtx.words)}</div>` : ""}
      <div class="btn-row">
        <a class="btn primary" href="#/material/${focusCtx.mid}">返回材料</a>
        <a class="btn" href="#/">回到今日</a>
      </div>
    </div>`;
}

function renderFocusReview() {
  const f = focusCtx.focus;
  const panel = $("#focus-panel");
  if (f.status === "offscript") {
    // 复习失败被回退：从脱稿重新练
    focusCtx.reviewMode = false;
    renderFocusTrain();
    return;
  }
  panel.innerHTML = `
    <div class="panel">
      <div class="panel-title">🔁 段落复习 · 重听</div>
      <div class="panel-sub">不看文字，把整段再听一遍，找回语感。</div>
      ${focusPlaybar(true)}
      <div class="btn-row">
        <button class="btn primary" id="f-r-listen">听清了，脱稿复述 →</button>
      </div>
    </div>`;
  bindFocusPlaybar(panel, { loop: true });
  $("#f-r-listen").addEventListener("click", () => renderFocusReviewSpeak());
}

function renderFocusReviewSpeak() {
  const panel = $("#focus-panel");
  panel.innerHTML = `
    <div class="panel">
      <div class="panel-title">🗣️ 段落复习 · 脱稿复述</div>
      <div class="panel-sub">合上文本，跟着音频自己念出来——能像原声一样说出来，这次复习才算过。</div>
      ${focusPlaybar(true)}
      <div class="btn-row">
        <button class="btn" id="f-r-fail">还不行，再练练</button>
        <button class="btn primary" id="f-r-pass">能念出来了，完成复习 →</button>
      </div>
    </div>`;
  bindFocusPlaybar(panel, { loop: true });
  $("#f-r-fail").addEventListener("click", async () => {
    await api(`/api/focus/${focusCtx.mid}/review`, { method: "POST", body: { passed: false } });
    const { focus } = await api(`/api/materials/${focusCtx.mid}/focus`);
    focusCtx.focus = focus;
    focusCtx.reviewMode = false;
    renderFocusBody();
  });
  $("#f-r-pass").addEventListener("click", async () => {
    const { focus } = await api(`/api/focus/${focusCtx.mid}/review`, { method: "POST", body: { passed: true } });
    focusCtx.focus = focus;
    focusCtx.reviewMode = false;
    renderFocusDone();
  });
}

/* ================= 设置 ================= */
async function viewSettings() {
  const [health, settings, providers, privacy, voices] = await Promise.all([
    api("/api/health"), api("/api/settings"), api("/api/ai/providers"),
    api("/api/ai/privacy"), api("/api/tts/voices"),
  ]);
  const s = settings.settings;
  const hasTts = !!(voices.voices && voices.voices.length);
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head"><div>
      <div class="page-title">设置</div>
      <div class="page-sub">本地优先 · 所有数据默认只保存在这台电脑</div>
    </div></div>

    <div class="section-title">🗣️ 语音识别（本地 ASR）</div>
    <div class="card">
      <div class="setting-row">
        <div><div class="label">faster-whisper</div>
          <div class="desc">${health.asr_engine === "web"
            ? "✅ 浏览器语音识别（Web Speech API）— 录音会自动转写"
            : health.asr_available
              ? "✅ 已安装 · 录音会自动本地转写"
              : "❌ 未安装 — 运行 ./run.sh 会自动安装（首次需联网下载模型）"}</div></div>
        <select id="asr-model">
          ${["tiny.en", "base.en", "small.en", "medium.en"].map(m => `<option ${s.asr_model === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
      </div>
      ${hasTts ? `
      <div class="setting-row">
        <div><div class="label">语音合成（TTS）</div><div class="desc">Kokoro 神经引擎离线生成；更换音色后内置材料会重新合成</div></div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:12px;color:var(--muted)">A</span>
          <select id="tts-voice-a" style="width:140px">${voices.voices.filter(v => v.locale.startsWith("en")).map(v => `<option ${s.tts_voice_a === v.name ? "selected" : ""}>${v.name}</option>`).join("")}</select>
          <button class="btn sm" id="preview-a" title="试听这个音色">🔊 试音</button>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">角色 B 音色</div><div class="desc">内置对话材料里第二位说话人的声音</div></div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:12px;color:var(--muted)">B</span>
          <select id="tts-voice-b" style="width:140px">${voices.voices.filter(v => v.locale.startsWith("en")).map(v => `<option ${s.tts_voice_b === v.name ? "selected" : ""}>${v.name}</option>`).join("")}</select>
          <button class="btn sm" id="preview-b" title="试听这个音色">🔊 试音</button>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">语速（词/分钟）</div><div class="desc">影响内置材料的生成语速</div></div>
        <input type="number" id="tts-rate" value="${s.tts_rate}" min="120" max="220" style="width:90px">
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn sm primary" id="save-voice">保存</button></div>
      ` : `
      <div class="setting-row">
        <div><div class="label">语音合成（TTS）</div>
          <div class="desc">网页版没有内置离线 TTS。桌面版内置 Kokoro 神经引擎（28 个音色），在桌面版设置里换音色后，内置材料会按新音色重新合成。</div></div>
      </div>
      `}
    </div>

    <div class="section-title">⚖️ 训练判定阈值</div>
    <div class="card">
      <div class="setting-row">
        <div><div class="label">听写通过 WER</div><div class="desc">低于该词错率判定通过；轻微错误（冠词/时态）自动豁免</div></div>
        <input type="number" id="set-wer" step="0.01" min="0" max="1" value="${s.dictation_pass_wer}" style="width:90px">
      </div>
      <div class="setting-row">
        <div><div class="label">口语匹配通过分</div><div class="desc">跟读/回忆的本地匹配分数（0-100）</div></div>
        <input type="number" id="set-speak" min="0" max="100" value="${s.speaking_pass_score}" style="width:90px">
      </div>
      <div class="setting-row">
        <div><div class="label">主动回忆通过分</div><div class="desc">无 AI 时的本地语义判定</div></div>
        <input type="number" id="set-recall" min="0" max="100" value="${s.recall_pass_score}" style="width:90px">
      </div>
      <div class="setting-row">
        <div><div class="label">精听自由导航</div><div class="desc">开启后整段精听的 4 个步骤可直接点击跳转 / 跳过（默认锁定，按顺序进行）</div></div>
        <input type="checkbox" id="set-free-nav" ${s.focus_free_nav === "1" || s.focus_free_nav === "true" ? "checked" : ""} style="width:auto">
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn sm primary" id="save-threshold">保存</button></div>
    </div>

    <div class="section-title">🤖 AI Providers（可选增强）</div>
    <div class="card">
      <div class="page-sub" style="margin-bottom:12px">没有 AI 也能完整学习；配置后获得语义评估、表达解释等增强。API Key 只存在本机钥匙串（Keychain），不写入数据库。</div>
      <div id="provider-list"></div>
      <div class="divider"></div>
      <div class="panel-title" style="font-size:15px">添加 Provider</div>
      <label class="field">类型</label>
      <select class="input" id="pv-type">
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="gemini">Gemini</option>
        <option value="ollama">Ollama（本地）</option>
        <option value="openai_compatible" selected>OpenAI 兼容（自定义 Base URL）</option>
      </select>
      <label class="field">名称</label>
      <input class="input" id="pv-name" placeholder="例如：我的 Ollama">
      <label class="field">Base URL</label>
      <input class="input" id="pv-url" placeholder="http://localhost:11434/v1">
      <label class="field">模型</label>
      <input class="input" id="pv-model" placeholder="llama3.1 / gpt-4o-mini …">
      <label class="field">API Key（本地 Ollama 可留空）</label>
      <input class="input" id="pv-key" type="password" placeholder="sk-…">
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" id="pv-save">保存</button>
        <button class="btn" id="pv-test-new">测试连接</button>
      </div>
    </div>

    <div class="section-title">🎨 界面</div>
    <div class="card">
      <div class="setting-row">
        <div><div class="label">主题</div><div class="desc">白天 / 黑夜模式，选择后立即生效</div></div>
        <div class="gen-seg" id="theme-seg">
          <button class="btn sm ${currentTheme() === "light" ? "primary" : ""}" data-theme-val="light">☀️ 白天</button>
          <button class="btn sm ${currentTheme() === "dark" ? "primary" : ""}" data-theme-val="dark">🌙 夜间</button>
        </div>
      </div>
    </div>

    <div class="section-title">📖 使用指南</div>
    <div class="card">
      <details id="guide-details">
        <summary style="cursor:pointer;font-weight:600">第一次用 DeepSpeak？点开看设计思路与使用流程（约 1 分钟）</summary>
        <div style="margin-top:10px;font-size:14px;line-height:1.9">
          <b>设计理念</b>：少而精，练透为止。不追求刷量，每一句都按「听清 → 写对 → 说出」三步练透，再靠间隔复习变成长期记忆。
          <br><br>
          <b>① 导入材料</b>：材料页 → 导入内容（音频/视频文件、YouTube 链接、字幕、纯文本），或「✨ AI 生成」让 AI 按场景生成对话。导入后自动转写、按句切分。
          <br>
          <b>② 整段精听（尚雯婕法）</b>：材料详情 → 整段精听。通听（不看文字反复听）→ 逐句听写 → 红笔校对 → 跟读 → 脱稿背诵（可用话筒整段背诵对照）。系统按间隔安排回炉复习。
          <br>
          <b>③ 逐句强化</b>：材料详情 → 逐句强化。盲听 → 听写 → 对照理解 → 跟读 → 主动回忆，一句练完 Bingo 进入下一句。
          <br>
          <b>④ 复习与今日</b>：今日页显示到期复习；复习页集中处理。生词与高价值表达点 ⭐ 收藏到生词本，随时回顾。
          <br>
          <b>小技巧</b>：任意页面双击单词/短语可查释义（词库 → 在线词典 → AI）；听写检查发现原文有错，点「✏️ 原文有误？纠正」。
          <br>
          <b>能力说明</b>：桌面版内置语音识别与合成（whisper + Kokoro，全离线）；网页/安卓版没有这两项（跟读可打字，听写可用浏览器语音输入或打字），其余功能一致。
        </div>
      </details>
    </div>

    <div class="section-title">🔒 隐私</div>
    <div class="card">
      <div class="setting-row">
        <div><div class="label">AI 内容发送</div><div class="desc">跟读/回忆评估时是否把句子发给你的 AI Provider</div></div>
        <select id="privacy-consent">
          <option value="ask" ${privacy.consent === "ask" ? "selected" : ""}>每次询问</option>
          <option value="allow" ${privacy.consent === "allow" ? "selected" : ""}>始终允许</option>
          <option value="never" ${privacy.consent === "never" ? "selected" : ""}>禁止发送</option>
        </select>
      </div>
      <div class="setting-row">
        <div><div class="label">发送范围</div><div class="desc">发送给 Provider 的内容范围</div></div>
        <select id="privacy-scope">
          <option value="sentence" ${privacy.scope === "sentence" ? "selected" : ""}>仅当前句子（推荐）</option>
          <option value="paragraph" ${privacy.scope === "paragraph" ? "selected" : ""}>当前段落</option>
          <option value="material" ${privacy.scope === "material" ? "selected" : ""}>整个材料</option>
        </select>
      </div>
      <div class="hint" style="color:var(--muted);font-size:12px;margin-top:8px">本应用没有服务器、不收集任何数据。所有材料、进度默认只保存在本机。</div>
    </div>

    <div class="section-title">💜 关于</div>
    <div class="card">
      <div class="setting-row">
        <div><div class="label">DeepSpeak — AI 英语深度学习工具</div>
          <div class="desc">本地优先的英语听说训练：整段精听、逐句听写、跟读、主动回忆、间隔复习。全部数据保存在本机。</div>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">制作人</div>
          <div class="desc">由 <b>marsggbo</b> 独立开发制作。欢迎反馈与建议 ❤️</div>
        </div>
      </div>
    </div>
  `;

  // providers 列表
  const plist = $("#provider-list");
  const renderProviders = () => {
    plist.innerHTML = (providers.providers || []).map(p => `
      <div class="provider-card">
        <div style="display:flex;align-items:center;gap:10px">
          <b>${esc(p.name)}</b><span class="chip gray">${esc(p.provider_type)}</span>
          <span class="chip gray">${esc(p.model || "—")}</span>
          ${p.enabled ? `<span class="badge MASTERED">已启用</span>` : `<span class="badge REVIEW_DUE">未启用</span>`}
          <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
            <button class="btn sm" data-test="${p.id}">测试</button>
            <button class="btn sm" data-enable="${p.id}" data-state="${p.enabled ? 1 : 0}">${p.enabled ? "停用" : "启用"}</button>
            <button class="btn sm danger" data-del="${p.id}">删除</button>
          </span>
        </div>
        <div class="hint" style="font-size:12px;color:var(--muted);margin-top:4px">
          ${p.base_url || ""} · ${p.has_key ? "已保存 API Key（钥匙串）" : "无 API Key"}
        </div>
        <div class="hint" id="test-out-${p.id}" style="font-size:12px;margin-top:4px"></div>
      </div>`).join("") || `<div class="hint" style="color:var(--muted)">还没有 Provider</div>`;
    $$("[data-test]", plist).forEach(b => b.addEventListener("click", async () => {
      const out = $("#test-out-" + b.dataset.test);
      out.innerHTML = `<span class="spin"></span> 测试中…`;
      try {
        const r = await api("/api/ai/test", { method: "POST", body: { provider_id: parseInt(b.dataset.test, 10) } });
        out.innerHTML = `✅ 连接成功：${esc(r.reply)}`;
      } catch (e) { out.innerHTML = `❌ ${esc(e.message)}`; }
    }));
    $$("[data-enable]", plist).forEach(b => b.addEventListener("click", async () => {
      await api(`/api/ai/providers/${b.dataset.enable}`, { method: "PUT", body: { enabled: b.dataset.state === "1" ? 0 : 1 } });
      viewSettings();
    }));
    $$("[data-del]", plist).forEach(b => b.addEventListener("click", async () => {
      if (!confirm("删除该 Provider？")) return;
      await api(`/api/ai/providers/${b.dataset.del}`, { method: "DELETE" });
      viewSettings();
    }));
  };
  renderProviders();

  // 主题切换（设置页）
  $$("#theme-seg button").forEach(b => b.addEventListener("click", () => {
    applyTheme(b.dataset.themeVal);
    $$("#theme-seg button").forEach(x => x.classList.remove("primary"));
    b.classList.add("primary");
  }));

  // 类型切换自动填充
  $("#pv-type").addEventListener("change", (e) => {
    const t = e.target.value;
    const preset = providers.presets[t];
    if (preset && preset.base_url) $("#pv-url").value = preset.base_url;
    if (preset && preset.models && preset.models.length) $("#pv-model").value = preset.models[0];
  });

  const pvSave = async (testOnly) => {
    const body = {
      name: $("#pv-name").value.trim() || "My Provider",
      provider_type: $("#pv-type").value,
      base_url: $("#pv-url").value.trim(),
      model: $("#pv-model").value.trim(),
      api_key: $("#pv-key").value.trim(),
      enabled: 0,
    };
    if (testOnly) body.enabled = 1;
    let id = null;
    try {
      const r = await api("/api/ai/providers", { method: "POST", body });
      id = r.id;
      toast(testOnly ? "已保存并启用" : "已保存", "success");
      viewSettings();
    } catch (e) { toast(e.message, "error"); }
  };
  $("#pv-save").addEventListener("click", () => pvSave(false));
  $("#pv-test-new").addEventListener("click", async () => {
    // 先建再测
    const body = {
      name: $("#pv-name").value.trim() || "My Provider",
      provider_type: $("#pv-type").value,
      base_url: $("#pv-url").value.trim(),
      model: $("#pv-model").value.trim(),
      api_key: $("#pv-key").value.trim(),
      enabled: 1,
    };
    const btn = $("#pv-test-new");
    btn.disabled = true;
    btn.textContent = "测试中…";
    try {
      const r = await api("/api/ai/providers", { method: "POST", body });
      const t = await api("/api/ai/test", { method: "POST", body: { provider_id: r.id } });
      toast("✅ 连接成功：" + t.reply, "success");
      viewSettings();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "测试连接";
      toast("❌ " + e.message, "error");
    }
  });

  // 保存各项设置（PWA 无 TTS 音色时相关控件不渲染，需判空）
  const saveVoiceBtn = $("#save-voice");
  if (saveVoiceBtn) saveVoiceBtn.addEventListener("click", async () => {
    await api("/api/settings", { method: "PUT", body: { tts_voice_a: $("#tts-voice-a").value, tts_voice_b: $("#tts-voice-b").value, tts_rate: $("#tts-rate").value } });
    toast("已保存（内置材料音频将在下次播放时用新音色重新合成）", "success");
  });
  // 音色试听：实时合成一段示例播放
  const previewVoice = (id) => {
    const voice = $(id).value;
    const rate = $("#tts-rate").value || 175;
    const url = `/api/tts?text=${encodeURIComponent("Hi there! Welcome to DeepSpeak. Let's practice listening and speaking.")}&voice=${encodeURIComponent(voice)}&rate=${rate}`;
    const a = new Audio(url);
    a.play().catch(() => toast("试音失败，音频尚未生成完成，请稍后再试", "error"));
  };
  const pa = $("#preview-a"), pb = $("#preview-b");
  if (pa) pa.addEventListener("click", () => previewVoice("#tts-voice-a"));
  if (pb) pb.addEventListener("click", () => previewVoice("#tts-voice-b"));
  $("#save-threshold").addEventListener("click", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        dictation_pass_wer: $("#set-wer").value,
        speaking_pass_score: $("#set-speak").value,
        recall_pass_score: $("#set-recall").value,
        focus_free_nav: $("#set-free-nav").checked ? "1" : "0",
      },
    });
    toast("已保存", "success");
  });
  $("#privacy-consent").addEventListener("change", async (e) => {
    const action = e.target.value === "allow" ? "allow" : e.target.value === "never" ? "never" : "ask";
    await api("/api/ai/consent", { method: "POST", body: { action } });
    toast("隐私设置已保存", "success");
  });
  $("#privacy-scope").addEventListener("change", async (e) => {
    await api("/api/settings", { method: "PUT", body: { ai_scope: e.target.value } });
    toast("已保存", "success");
  });
}

/* ================= AI 生成材料 ================= */
const GEN_SCENES = [
  ["restaurant", "🍽️ 餐厅"],
  ["doctor", "🏥 看医生"],
  ["airport", "✈️ 机场"],
  ["hotel", "🏨 酒店"],
  ["shopping", "🛒 购物"],
  ["office", "💼 职场"],
  ["small_talk", "☕ 日常闲聊"],
  ["travel", "🗺️ 旅行"],
  ["phone", "📞 打电话"],
  ["interview", "🎤 面试"],
];

async function viewGenerate() {
  const v = $("#view");
  let aiOk = false;
  try { const h = await getHealth(); aiOk = !!h.ai_provider; } catch (e) { /* ignore */ }
  v.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/materials" style="font-size:13px">← 材料</a>
        <div class="page-title">✨ AI 生成材料</div>
        <div class="page-sub">AI 按场景写对话 → 本机 TTS 合成真人声音 → 自动变成可训练的材料</div>
      </div>
    </div>
    ${aiOk ? "" : `<div class="panel" style="border-left-color:var(--orange)"><b>⚠️ 尚未配置 AI Provider</b><div class="hint" style="margin-top:4px">生成需要调用大模型。请先到 <a href="#/settings">设置 → AI Provider</a> 配置一个（Ollama / OpenAI 兼容 / Anthropic / Gemini 均可）。</div></div>`}
    <div class="panel">
      <div class="panel-title">1️⃣ 选择场景</div>
      <div class="gen-scenes" id="gen-scenes">
        ${GEN_SCENES.map(([k, label], i) => `<button class="chip gen-chip ${i === 0 ? "active" : ""}" data-scene="${k}">${label}</button>`).join("")}
      </div>
      <div class="label" style="font-size:12px;color:var(--muted);margin-top:12px">或自定义场景</div>
      <input class="input" id="gen-custom" placeholder="例如：两位同事在茶水间聊周末爬山计划…" style="margin-top:6px">
    </div>
    <div class="panel">
      <div class="panel-title">2️⃣ 调整参数（都有默认值，不想调可以直接生成）</div>
      <div class="setting-row">
        <div><div class="label">难度</div><div class="desc">影响词汇与句长</div></div>
        <div class="gen-seg" id="gen-diff">
          ${[["easy", "简单"], ["medium", "适中"], ["hard", "进阶"]].map(([k, label]) => `<button class="btn sm ${k === "medium" ? "primary" : ""}" data-diff="${k}">${label}</button>`).join("")}
        </div>
      </div>
      <div class="setting-row">
        <div><div class="label">对话轮数 <span id="gen-turns-v" style="color:var(--accent2)">6 句</span></div></div>
        <input type="range" id="gen-turns" min="2" max="12" step="2" value="6" style="flex:1;accent-color:var(--accent)">
      </div>
      <div class="setting-row">
        <div><div class="label">目标时长 <span id="gen-len-v" style="color:var(--accent2)">90 秒</span></div></div>
        <input type="range" id="gen-len" min="30" max="300" step="30" value="90" style="flex:1;accent-color:var(--accent)">
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:14px;cursor:pointer">
        <input type="checkbox" id="gen-random" style="accent-color:var(--accent)"> 🎲 随机生成（随机挑一个场景和参数，生成的音频就是今天的学习内容）
      </label>
    </div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn primary big" id="gen-run">✨ 生成并合成语音</button>
    </div>
    <div id="gen-progress" style="margin-top:14px"></div>
  `;
  let scene = "restaurant", diff = "medium", custom = "", random = false;
  const chips = $$("#gen-scenes .gen-chip");
  chips.forEach(c => c.addEventListener("click", () => {
    chips.forEach(x => x.classList.remove("active"));
    c.classList.add("active");
    scene = c.dataset.scene;
  }));
  $$("#gen-diff button").forEach(b => b.addEventListener("click", () => {
    $$("#gen-diff button").forEach(x => x.classList.remove("primary"));
    b.classList.add("primary");
    diff = b.dataset.diff;
  }));
  const turnsEl = $("#gen-turns"), lenEl = $("#gen-len");
  turnsEl.addEventListener("input", () => { $("#gen-turns-v").textContent = turnsEl.value + " 句"; });
  lenEl.addEventListener("input", () => { $("#gen-len-v").textContent = lenEl.value + " 秒"; });
  $("#gen-custom").addEventListener("input", (e) => { custom = e.target.value.trim(); });
  $("#gen-random").addEventListener("change", (e) => {
    random = e.target.checked;
    chips.forEach(c => c.disabled = random);
    if (random) { $("#gen-custom").disabled = true; } else { $("#gen-custom").disabled = false; }
  });

  $("#gen-run").addEventListener("click", async () => {
    const btn = $("#gen-run");
    btn.disabled = true;
    btn.textContent = "⏳ 生成中…（LLM 写对话 + 本机合成语音，约 1 分钟）";
    const box = $("#gen-progress");
    box.innerHTML = `<div class="progress-bar" style="cursor:default"><div class="progress-fill" style="width:4%"></div></div>`;
    try {
      const r = await api("/api/materials/generate", {
        method: "POST",
        body: { scene, custom_prompt: custom, turns: turnsEl.value, difficulty: diff, length_seconds: lenEl.value, random },
      });
      const mid = r.id;
      for (let i = 0; i < 300; i++) {
        await new Promise(r2 => setTimeout(r2, 1000));
        let material;
        try { material = (await api(`/api/materials/${mid}`)).material; } catch (e) { continue; }
        if (material.status === "ready") {
          toast(`AI 材料已生成：${material.unit_total} 句，开始学习吧！`, "success");
          location.hash = "#/material/" + mid;
          return;
        }
        if (material.status === "error") {
          toast(material.description || "生成失败", "error");
          location.hash = "#/material/" + mid;
          return;
        }
        const step = PROCESS_STEP_LABELS[material.process_step] || "生成中";
        const pct = material.process_pct || 0;
        box.innerHTML = `
          <div class="label" style="font-size:13px;color:var(--muted);margin-bottom:6px">正在${step}… ${pct}%</div>
          <div class="progress-bar" style="cursor:default"><div class="progress-fill" style="width:${Math.max(2, pct)}%"></div></div>`;
      }
      toast("生成仍在进行，稍后到材料列表查看", "");
      location.hash = "#/materials";
    } catch (e) {
      box.innerHTML = "";
      toast(e.message, "error");
      btn.disabled = false;
      btn.textContent = "✨ 生成并合成语音";
    }
  });
}

/* ================= 启动 ================= */
applyTheme(currentTheme()); // 同步主题按钮文案（首帧由 index.html 内联脚本应用）
bindThemeButtons();
router();
