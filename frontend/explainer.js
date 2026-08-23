/* explainer.js —— 全局点词/选句释义插件
 *
 * 双击任意文本区域：
 *   - 选中单个单词 → 免费离线查词（内置词库 1768 词；未命中且配置了 LLM 时 AI 兜底）
 *   - 选中短语/句子 → 句子翻译（需配置 AI Provider，未配置时提示）
 * 独立模块：事件委托全局生效，不侵入任何页面渲染。
 */
(function () {
  "use strict";
  if (window.__explainerLoaded) return;
  window.__explainerLoaded = true;

  let pop = null;
  let lastKey = "";
  let lastAt = 0;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function closePop() {
    if (pop) { pop.remove(); pop = null; }
  }

  function showPop(x, y, html) {
    closePop();
    pop = document.createElement("div");
    pop.className = "explainer-pop";
    pop.innerHTML = html;
    document.body.appendChild(pop);
    const r = pop.getBoundingClientRect();
    let left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
    let top = y + 16;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 16);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.addEventListener("click", (e) => { if (e.target.closest(".explainer-close")) closePop(); });
  }

  async function explain(text, x, y) {
    const isWord = text.split(/\s+/).filter(Boolean).length === 1;
    showPop(x, y, `<div class="explainer-src">${isWord ? "查词中" : "翻译中"}…</div><button class="explainer-close">✕</button>`);
    if (typeof api !== "function") {
      closePop();
      return;
    }
    let r;
    try {
      r = await api("/api/explain", { method: "POST", body: { text, kind: isWord ? "word" : "sentence" } });
    } catch (e) {
      closePop();
      if (e && e.message) toast(e.message, "error");
      return;
    }
    if (!r || !r.kind) { closePop(); return; }
    if (r.kind === "word") {
      if (r.found) {
        let html = `<div class="explainer-word">${esc(r.word)}</div>`;
        if (r.pos) html += `<div class="explainer-pos">${esc(r.pos)}</div>`;
        html += `<div class="explainer-meaning">${esc(r.meaning)}</div>`;
        if (r.example_en) html += `<div class="explainer-example">${esc(r.example_en)}<br><span class="explainer-sub">${esc(r.example_zh || "")}</span></div>`;
        if (r.source === "llm") html += `<div class="explainer-src">来源：AI 解释</div>`;
        showPop(x, y, html + `<button class="explainer-close">✕</button>`);
      } else {
        showPop(x, y, `<div class="explainer-word">${esc(r.word || text)}</div>
          <div class="explainer-meaning">词库暂无释义。配置 AI Provider（设置 → AI Providers）后可获取 AI 解释。</div>
          <button class="explainer-close">✕</button>`);
      }
    } else {
      showPop(x, y, `<div class="explainer-src">句子翻译（AI）</div>
        <div class="explainer-meaning">${esc(r.translation_zh)}</div>
        <button class="explainer-close">✕</button>`);
    }
  }

  // 双击未产生文本选区时的兜底：按点击坐标反推单词
  // （部分 WebView/自动化环境的合成双击不会触发原生选词）
  function wordAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    if (!nodes.length && el.childNodes.length === 1 && el.firstChild.nodeType === 3) {
      nodes.push(el.firstChild);
    }
    for (const tn of nodes) {
      const s = tn.data;
      if (!s.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(tn);
      const rc = range.getBoundingClientRect();
      if (!rc.width || !rc.height) continue;
      if (y < rc.top - 6 || y > rc.bottom + 6) continue; // 不在该行
      if (x < rc.left - 6 || x > rc.right + 6) continue; // 不在该文本范围
      // 字符级定位
      for (let i = 0; i < s.length; i++) {
        if (!/[A-Za-z]/.test(s[i])) continue;
        const r = document.createRange();
        r.setStart(tn, i);
        r.setEnd(tn, i + 1);
        const cr = r.getBoundingClientRect();
        if (!cr.width && !cr.height) continue;
        if (x >= cr.left - 4 && x <= cr.right + 4 && y >= cr.top - 4 && y <= cr.bottom + 4) {
          const head = s.slice(0, i + 1).match(/[A-Za-z']+$/);
          const start = head ? i + 1 - head[0].length : i;
          const tail = s.slice(start).match(/^[A-Za-z']+/);
          const word = tail ? tail[0] : "";
          if (word.length > 0 && word.length <= 40) return word;
        }
      }
      // 字符级未命中（落在单词间隙/空格等）：按 x 比例估算所在单词
      const ratio = (x - rc.left) / rc.width;
      const idx = Math.max(0, Math.min(s.length - 1, Math.floor(ratio * s.length)));
      const head2 = s.slice(0, idx + 1).match(/[A-Za-z']+$/);
      if (head2) return head2[0];
    }
    return null;
  }

  // 双击判定：click 计数检测（click 事件必定派发；部分 WebView/自动化环境
  // 不派发原生 dblclick 事件或合成双击不产生文本选区）
  let lastClickAt = 0;
  let lastXY = null;
  const DBL_MS = 500;
  const DBL_DIST = 10;

  function handleDbl(e) {
    if (e.target.closest("input, textarea, select, button, a, .explainer-pop")) return;
    // 提前标记：无论取词是否成功，都让页面可点击行放弃本次双击的跳转
    window.__explainerDblAt = Date.now();
    const sel = window.getSelection();
    let text = "";
    let anchorClass = "";
    try {
      if (sel && !sel.isCollapsed) {
        text = sel.toString().replace(/\s+/g, " ").trim();
        anchorClass = sel.anchorNode && sel.anchorNode.parentElement ? sel.anchorNode.parentElement.className : "";
      } else {
        text = wordAtPoint(e.clientX, e.clientY) || "";
      }
    } catch (err) { /* 取词失败则忽略本次双击 */ }
    if (!text) {
      // 坐标取词失败的最后兜底：目标元素整体就是一个英文单词时直接使用
      const t = e.target && e.target.textContent ? e.target.textContent.trim() : "";
      if (t && t.length <= 40 && /^[A-Za-z']+$/.test(t)) text = t;
    }
    if (!text || text.length > 500) return;
    const now = Date.now();
    const key = text + "@" + anchorClass;
    if (key === lastKey && now - lastAt < 1200) return; // 防同一文本重复弹
    lastKey = key;
    lastAt = now;
    let x = e.clientX;
    let y = e.clientY;
    try {
      if (sel && !sel.isCollapsed) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top;
      }
    } catch (err) { /* 选区已失效 */ }
    explain(text, x, y);
  }

  document.addEventListener("click", (e) => {
    if (pop && !pop.contains(e.target)) closePop();
    if (e.target.closest("input, textarea, select, button, a, .explainer-pop")) return;
    const now = Date.now();
    const dist = lastXY ? Math.hypot(e.clientX - lastXY.x, e.clientY - lastXY.y) : 999;
    lastXY = { x: e.clientX, y: e.clientY };
    if (now - lastClickAt < DBL_MS && dist < DBL_DIST) {
      lastClickAt = 0; // 已消费，防止原生 dblclick 再触发一次
      handleDbl(e);
    } else {
      lastClickAt = now;
    }
  });

  // 真实浏览器双击事件（click 计数检测已覆盖，此处防其未触发时兜底）
  document.addEventListener("dblclick", (e) => {
    lastClickAt = 0;
    handleDbl(e);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
})();
