// 双引擎音频契约（JS 侧）：与 backend/audio_contract.py 完全同构。
// 桌面端 server.py 与移动/网页端 engine.js 用它算出同一份逐句播放区间，
// 防止“一句播完不收、接着往后播”的分叉。改这里必须同步改 Python。
// 纯函数、无 DOM 依赖：tests/audio_contract_check.py 会对两端做回归对比。
(function () {
  "use strict";

  // resolve_unit_range 的 JS 版：end 缺失/非法 → 下一句起点；仍没有 → 按词数估算。
  function resolveUnitRange(start, end, text, nextStart) {
    start = Math.trunc(start) || 0;
    end = Math.trunc(end) || 0;
    if (!(end > start)) {
      if (nextStart && nextStart > start) {
        end = Math.trunc(nextStart);
      } else {
        const words = String(text || "").split(/\s+/).filter(Boolean).length;
        end = start + Math.max(1500, words * 420);
      }
    }
    return { start_ms: start, end_ms: end };
  }

  const api = { resolveUnitRange };
  if (typeof window !== "undefined") window.dsAudioContract = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();