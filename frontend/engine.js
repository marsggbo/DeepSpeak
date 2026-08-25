/* DeepSpeak 本地引擎（无后端模式）：PWA / GitHub Pages 离线运行时。
   与 backend（focus.py / review.py / diffing.py / textproc.py / wordbank.py）行为逐一对齐：
   focus 状态机、单元状态机、WER/口语判定、间隔调度、生词、打卡统计。
   数据存于浏览器 IndexedDB（首次启动从 BUILTIN_DATA 初始化）。 */
"use strict";

const DeepSpeakEngine = (() => {
  // ================= 常量（与后端对齐） =================
  const FOCUS_INTERVALS = [1, 2, 4, 7, 14, 30, 60];
  const FOCUS_MASTER_MIN_REVIEWS = 2;
  // 动作 → (允许的状态, 目标状态)
  const FOCUS_ACTS = {
    listen_again: [["new", "listening"], "listening"],
    listen_done: [["new", "listening"], "dictation"],  // 对齐后端：new 也允许（首次点主按钮不再静默失败）
    dict_done: [["listening", "dictation"], "shadowing"],
    shadow_done: [["shadowing"], "offscript"],
    offscript_done: [["offscript"], "review_due"],
    restart: [["review_due", "mastered"], "offscript"],
  };
  const FOCUS_BACK_TO = { dictation: "listening", shadowing: "dictation", offscript: "shadowing" };

  const TYPE_SKILL = {
    blind_listening: "listening", review_listening: "listening",
    dictation: "dictation", review_dictation: "dictation",
    shadowing: "speaking", review_speaking: "speaking",
    active_recall: "recall", review_recall: "recall",
  };
  const INTERVALS = [1, 2, 4, 7, 14, 30, 60];
  const SKILL_WEIGHTS = { listening: 0.15, dictation: 0.25, recall: 0.35, speaking: 0.25 };
  const MASTER_MIN_OVERALL = 0.80;
  const MASTER_MIN_SKILL = 0.70;
  const MASTER_MIN_REVIEWS = 2;

  const UNIT_TRANSITIONS = {
    NEW: { LISTENING: 1 },
    LISTENING: { DICTATION: 1 },
    DICTATION: { REVEALED: 1 },
    REVEALED: { UNDERSTOOD: 1 },
    UNDERSTOOD: { SHADOWING: 1, ACTIVE_RECALL: 1 },
    SHADOWING: { ACTIVE_RECALL: 1, UNDERSTOOD: 1 },
    ACTIVE_RECALL: { REVIEW_DUE: 1, SHADOWING: 1, UNDERSTOOD: 1 },
    REVIEW_DUE: { REVIEW_DUE: 1, MASTERED: 1, ACTIVE_RECALL: 1 },
    MASTERED: { MASTERED: 1, REVIEW_DUE: 1 },
  };

  const MINOR_SETS = [
    new Set(["a", "an", "the"]),
    new Set(["is", "are", "was", "were", "am", "be", "been", "do", "does", "did",
      "can", "could", "will", "would", "shall", "should", "may", "might", "must",
      "have", "has", "had"]),
    new Set(["in", "on", "at", "to", "for", "of", "with", "from", "about"]),
  ];

  const CONTRACTIONS = {
    "can't": "cannot", "won't": "will not", "don't": "do not", "doesn't": "does not",
    "didn't": "did not", "isn't": "is not", "aren't": "are not", "wasn't": "was not",
    "weren't": "were not", "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
    "couldn't": "could not", "wouldn't": "would not", "shouldn't": "should not",
    "mustn't": "must not", "i'm": "i am", "i've": "i have", "i'll": "i will", "i'd": "i would",
    "you're": "you are", "you've": "you have", "you'll": "you will", "you'd": "you would",
    "he's": "he is", "she's": "she is", "it's": "it is", "we're": "we are", "we've": "we have",
    "we'll": "we will", "they're": "they are", "they've": "they have", "they'll": "they will",
    "that's": "that is", "there's": "there is", "here's": "here is", "what's": "what is",
    "who's": "who is", "let's": "let us", "gonna": "going to", "wanna": "want to",
    "gotta": "got to", "kinda": "kind of", "sorta": "sort of", "ain't": "is not",
    "would've": "would have", "could've": "could have", "should've": "should have",
    "y'all": "you all", "ma'am": "madam", "o'clock": "o clock",
  };

  const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "so", "to", "of", "in", "on", "at",
    "for", "with", "is", "are", "was", "were", "be", "been", "being", "am",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "do", "does", "did", "have",
    "has", "had", "can", "could", "will", "would", "shall", "should", "may",
    "might", "must", "this", "that", "these", "those", "there", "here", "not",
    "no", "yes", "just", "very", "really", "ok", "okay", "oh", "well", "uh",
    "um", "about", "as", "if", "then", "than", "by", "from", "into", "onto",
    "during", "before", "after", "also", "too", "any", "some", "more", "most",
    "much", "many", "even", "still", "yet", "only", "because", "since", "while",
    "though", "although", "whether", "either", "neither", "both", "each",
    "every", "few", "several", "whose", "whom", "which", "what", "who", "when",
    "where", "why", "how", "done",
  ]);

  // 内置材料 key → 静态音频目录名（与 backend/builtin.py 的 key 一致）
  const MATERIAL_KEYS = { 1: "restaurant_takeout", 2: "doctor_visit", 3: "news_bakery" };

  // ================= 时间工具 =================
  function pad2(n) { return String(n).padStart(2, "0"); }
  function nowStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function daysAfter(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function localDateKey(isoStr) {
    // "YYYY-MM-DD HH:MM:SS" → 本地日期（生成时已是本地时间）
    return isoStr ? isoStr.slice(0, 10) : "";
  }
  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // ================= 文本处理（对齐 textproc.py） =================
  function normalize(text) {
    if (!text) return "";
    let t = String(text).trim().toLowerCase();
    for (const k of Object.keys(CONTRACTIONS)) {
      t = t.replace(new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"), CONTRACTIONS[k]);
    }
    t = t.replace(/[.,!?;:'"()[\]{}\u2018\u2019\u201c\u201d\u2013\u2014\u2026-]+/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }
  function tokens(text) {
    const n = normalize(text);
    return n ? n.split(" ") : [];
  }
  function contentTokens(text) {
    return tokens(text).filter((w) => !STOP_WORDS.has(w) && !/^\d+(\.\d+)?$/.test(w));
  }

  // ================= 比对（对齐 diffing.py） =================
  function lev(a, b) {
    const m = b.length;
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= m; j++) {
        cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
      }
      prev = cur;
    }
    return prev[m];
  }
  function wer(ref, usr) {
    const rt = tokens(ref), ut = tokens(usr);
    if (!rt.length) return ut.length ? 1.0 : 0.0;
    return lev(rt, ut) / rt.length;
  }
  function cer(ref, usr) {
    const r = normalize(ref), u = normalize(usr);
    if (!r) return u ? 1.0 : 0.0;
    return lev(r, u) / r.length;
  }
  function isMinor(refWord, usrWord) {
    if (refWord !== null && refWord !== undefined && usrWord !== null && usrWord !== undefined) {
      return MINOR_SETS.some((s) => s.has(refWord) && s.has(usrWord));
    }
    const w = refWord !== null && refWord !== undefined ? refWord : usrWord;
    return MINOR_SETS.some((s) => s.has(w));
  }
  // LCS 回溯生成 opcodes（相邻 delete+insert 合并为 replace，与 difflib 近似）
  function tokenDiff(refT, usrT) {
    const n = refT.length, m = usrT.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = refT[i] === usrT[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const raw = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && refT[i] === usrT[j]) { raw.push({ op: "equal", t: refT[i] }); i++; j++; }
      else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { raw.push({ op: "delete", t: refT[i] }); i++; }
      else { raw.push({ op: "insert", t: usrT[j] }); j++; }
    }
    // 合并相邻 delete+insert 为 replace（对齐 difflib 的 opcodes）
    const out = [];
    let k = 0;
    while (k < raw.length) {
      if (raw[k].op === "delete" || raw[k].op === "insert") {
        const del = [], ins = [];
        while (k < raw.length && (raw[k].op === "delete" || raw[k].op === "insert")) {
          if (raw[k].op === "delete") del.push(raw[k].t); else ins.push(raw[k].t);
          k++;
        }
        const nPairs = Math.max(del.length, ins.length);
        for (let x = 0; x < nPairs; x++) {
          const rt = del[x] !== undefined ? del[x] : "";
          const ut = ins[x] !== undefined ? ins[x] : "";
          if (rt !== "" && ut !== "") out.push({ t: ut, ref: rt, op: "replace", minor: isMinor(rt, ut) });
          else if (rt !== "") out.push({ t: rt, op: "delete", minor: isMinor(rt, null) });
          else out.push({ t: ut, op: "insert", minor: isMinor(null, ut) });
        }
      } else { out.push({ t: raw[k].t, op: "equal", minor: false }); k++; }
    }
    return out;
  }
  function diffStats(diff) {
    const errors = diff.filter((d) => d.op !== "equal");
    return [errors.length, errors.filter((d) => d.minor).length];
  }
  function judgeDictation(reference, user, passWer) {
    if (passWer === undefined || passWer === null) passWer = 0.12;
    const w = wer(reference, user);
    const c = cer(reference, user);
    const diff = tokenDiff(tokens(reference), tokens(user));
    const [nErr, nMinor] = diffStats(diff);
    let passed = false, verdict = "fail";
    if (w <= passWer) { passed = true; verdict = "pass"; }
    else if (nErr > 0 && nMinor === nErr && w <= 0.35) { passed = true; verdict = "close_enough"; }
    return {
      wer: Math.round(w * 1000) / 1000,
      cer: Math.round(c * 1000) / 1000,
      diff, errors: nErr, minor_errors: nMinor,
      passed, verdict,
    };
  }
  function fuzzyMatch(reference, user) {
    const r = normalize(reference), u = normalize(user);
    if (!r || !u) {
      return { score: 0, exact: false, fuzzy_ratio: 0.0, keyword_coverage: 0.0, content_words: 0 };
    }
    const exact = r === u;
    const rt = tokens(reference), ut = tokens(user);
    // SequenceMatcher ratio：2*M / (n+m)
    const n = rt.length, m = ut.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = rt[i] === ut[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const matches = dp[0][0];
    const ratio = n + m ? (2 * matches) / (n + m) : 1;
    const rc = contentTokens(reference), uc = new Set(contentTokens(user));
    let cov = 0;
    const rcSet = new Set(rc);
    if (rcSet.size) {
      cov = [...rcSet].filter((w) => uc.has(w)).length / rcSet.size;
    }
    const score = Math.round(Math.max(ratio, cov) * 100);
    return {
      score, exact,
      fuzzy_ratio: Math.round(ratio * 1000) / 1000,
      keyword_coverage: Math.round(cov * 1000) / 1000,
      content_words: rc.length,
    };
  }
  function judgeSpeaking(reference, user, passScore) {
    if (passScore === undefined || passScore === null) passScore = 60;
    const fm = fuzzyMatch(reference, user);
    const passed = fm.score >= passScore || (fm.keyword_coverage >= 0.7 && fm.score >= 45);
    const verdict = passed ? "pass" : (fm.score >= 40 ? "partial" : "fail");
    return { ...fm, passed, verdict };
  }
  function judgeRecall(reference, variants, intentWords, user, passScore) {
    if (passScore === undefined || passScore === null) passScore = 60;
    const refs = [reference, ...(variants || [])];
    let best = null;
    for (const r of refs) {
      const fm = fuzzyMatch(r, user);
      if (!best || fm.score > best.score) best = fm;
    }
    let intentHits = 0;
    if (intentWords && intentWords.length) {
      const uc = new Set(contentTokens(user));
      intentHits = intentWords.filter((w) => uc.has(w)).length;
      best.score = Math.min(100, best.score + intentHits * 5);
    }
    const passed = best.score >= passScore;
    return { ...best, passed, verdict: passed ? "pass" : "fail", intent_hits: intentHits };
  }

  // ================= IndexedDB 存储 =================
  let _db = null;
  const DB_NAME = "deepspeak-local", DB_VERSION = 1, STORE = "kv", STATE_KEY = "state_v1";
  function openDB() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }
  function idbGet(key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  function idbSet(key, val) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  // ================= 状态 =================
  let S = null;
  let readyPromise = null;

  function initialState() {
    return {
      materials: (BUILTIN_DATA.materials || []).map((m) => ({ ...m })),
      units: {}, // mid → [unit]
      expressions: BUILTIN_DATA.expressions || {}, // mid → uid → [{expression, meaning, intent, scene, variants}]
      focus: BUILTIN_DATA.focus || {}, // mid → {status, listen_count, ...}
      focus_review_history: [], // {material_id, result, interval_days, reviewed_at}
      words: [], // {id, material_id, unit_id, expression, meaning, note, source, created_at}
      mastery: {}, // uid → {listening, dictation, recall, speaking, overall, interval_days, stage, next_review_at, reviews_done}
      review_history: [], // {unit_id, review_type, result, interval_days, reviewed_at}
      answers: [], // {session_id, kind, user_input, reference, wer, cer, passed, created_at}
      speaking_attempts: [], // {kind, unit_id, score, exact, verdict, passed, created_at}
      focus_dictations: [], // {material_id, overall_wer, correct_words, total_words, sentence_count, detail_json, created_at}
      checkins: [], // ["YYYY-MM-DD"]
      settings: {}, // {key: value}
      providers: [], // [{id, name, provider_type, base_url, model, api_key, enabled, created_at}]
      seq: { word: 0, session: 0 },
    };
  }

  function initUnits() {
    const out = {};
    for (const [mid, units] of Object.entries(BUILTIN_DATA.units || {})) {
      out[mid] = units.map((u) => ({ ...u, material_id: Number(mid), expressions: [] }));
      for (const u of out[mid]) {
        u.expressions = (BUILTIN_DATA.expressions[mid] || {})[u.id] || [];
      }
    }
    return out;
  }

  function saveState() {
    return idbSet(STATE_KEY, S);
  }

  function loadState() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const saved = await idbGet(STATE_KEY);
      if (saved) {
        S = saved;
        // 结构迁移：老数据可能缺字段
        const fresh = initialState();
        for (const k of Object.keys(fresh)) {
          if (S[k] === undefined) S[k] = fresh[k];
        }
        if (!S.seq) S.seq = { word: 0, session: 0 };
        // 迁移：补 material_id（旧导出数据没有该字段）
        for (const [mid, units] of Object.entries(S.units)) {
          for (const u of units) if (u.material_id === undefined) u.material_id = Number(mid);
        }
        await rebuildAudioUrls();
      } else {
        S = initialState();
        S.units = initUnits();
        await saveState();
      }
    })().catch((e) => {
      readyPromise = null;
      throw e;
    });
    return readyPromise;
  }

  function save() { return idbSet(STATE_KEY, S); }

  // ================= 导入材料的音频存储（整段 blob 存 IndexedDB，播放走 objectURL） =================
  // 内置材料音频是静态 wav；用户导入（URL/播客/本地文件）的整段音频作为 blob 存 IndexedDB，
  // 单元用 start_ms/end_ms 在整段里区间播放（与桌面 full.wav + 区间播放一致）。
  const AUDIO_KEY = (mid) => `audio_v1_${mid}`;
  const _audioUrls = {}; // mid → objectURL（内存缓存，刷新后由 rebuildAudioUrls 重建）
  function isImported(mat) {
    return !!mat && mat.source_type && mat.source_type !== "builtin";
  }
  async function storeAudioBlob(mid, blob) {
    await idbSet(AUDIO_KEY(mid), blob);
    if (_audioUrls[mid]) { try { URL.revokeObjectURL(_audioUrls[mid]); } catch (e) {} }
    _audioUrls[mid] = URL.createObjectURL(blob);
    return _audioUrls[mid];
  }
  async function rebuildAudioUrls() {
    for (const mat of S.materials) {
      if (!isImported(mat) || !mat.has_audio || _audioUrls[mat.id]) continue;
      try {
        const blob = await idbGet(AUDIO_KEY(mat.id));
        if (blob) _audioUrls[mat.id] = URL.createObjectURL(blob);
      } catch (e) { /* 音频丢失：材料仍可看文本 */ }
    }
  }
  function importedAudioUrl(mid) { return _audioUrls[mid] || ""; }
  function nextMaterialId() {
    if (!S.seq.material) {
      const maxId = S.materials.reduce((mx, m) => Math.max(mx, m.id || 0), 0);
      S.seq.material = Math.max(1000, maxId);
    }
    return ++S.seq.material;
  }
  function nextUnitId() {
    if (!S.seq.unit) {
      let mx = 0;
      for (const units of Object.values(S.units)) for (const u of units) mx = Math.max(mx, u.id || 0);
      S.seq.unit = Math.max(1000, mx);
    }
    return ++S.seq.unit;
  }

  // 下载 → 浏览器内 Whisper 转写 → 分句建单元（对齐桌面 pipeline._download_remote_audio + _asr_and_build）。
  // 不 await（前端轮询 /materials/{id} 的 process_step/process_pct 展示进度），失败置 error。
  async function _processAudio(mid, url) {
    const mat = getMaterial(mid);
    if (!mat) return;
    const setProg = (step, pct) => { mat.process_step = step; if (pct != null) mat.process_pct = Math.round(pct); };
    try {
      if (!window.dsImport) throw new Error("导入引擎未加载（import-engine.js）");
      mat.status = "processing"; mat.error = ""; setProg("download", 5);
      const proxy = getSetting("cors_proxy", "");
      const blob = await window.dsImport.fetchBlob(url, proxy, (recv, total) => {
        if (total) setProg("download", 5 + (recv / total) * 20);
      });
      setProg("download", 25);
      await _transcribeAndBuild(mid, blob);
    } catch (e) {
      _markError(mid, e);
    }
  }

  // 已有 blob（本地文件 / 已存音频）→ 转写建单元
  async function _transcribeAndBuild(mid, blob) {
    const mat = getMaterial(mid);
    if (!mat) return;
    const setProg = (step, pct) => { mat.process_step = step; if (pct != null) mat.process_pct = Math.round(pct); };
    try {
      if (!window.dsImport) throw new Error("导入引擎未加载（import-engine.js）");
      await storeAudioBlob(mid, blob);
      mat.has_audio = true;
      const model = getSetting("asr_model", "tiny.en");
      const segs = await window.dsImport.transcribe(blob, {
        model,
        onProgress: (phase, frac) => {
          if (phase === "model") setProg("downloading_model", 25 + (frac || 0) * 20);
          else if (phase === "decode") setProg("preparing", 46);
          else if (phase === "transcribe") setProg("transcribing", 50 + (frac || 0) * 45);
        },
      });
      setProg("building", 96);
      const built = window.dsImport.buildUnits(segs);
      if (!built.length) throw new Error("没有识别出可学习的句子");
      S.units[mid] = built.map((u) => ({
        id: nextUnitId(), material_id: mid, seq: u.seq, text: u.text, speaker: u.speaker || "",
        start_ms: u.start_ms || 0, end_ms: u.end_ms || 0, scene: u.scene || "",
        difficulty: u.difficulty || 0, learning_value: u.learning_value || 0,
        status: "NEW", expressions: u.expressions || [],
      }));
      const last = segs[segs.length - 1];
      mat.duration_ms = last ? Math.round((last.end || 0) * 1000) : 0;
      mat.status = "ready"; setProg("done", 100);
      await save();
    } catch (e) {
      _markError(mid, e);
    }
  }

  function _markError(mid, e) {
    const mat = getMaterial(mid);
    if (!mat) return;
    mat.status = "error"; mat.process_step = "error"; mat.process_pct = 0;
    mat.error = String((e && e.message) || e);
    mat.description = `处理失败：${mat.error}。可换一集，或在桌面版导入。`;
    try { save(); } catch (e2) {}
  }

  // 本地文件导入（app.js 直接调用，绕过 api 的 formData 限制）
  async function importLocalFile(file) {
    await loadState();
    const mid = nextMaterialId();
    const name = file && file.name ? file.name.replace(/\.[^.]+$/, "") : "本地音频";
    S.materials.push({
      id: mid, title: name, description: "本地文件导入", media_type: "audio", language: "en",
      scene: "", difficulty: 0, duration_ms: 0, status: "processing", tags: "",
      source_type: "local_file", source_url: "", episodes: [], process_step: "preparing",
      process_pct: 5, has_audio: false, created_at: nowStr(),
    });
    S.units[mid] = [];
    await save();
    _transcribeAndBuild(mid, file); // 后台转写，前端轮询
    return { ok: true, id: mid };
  }

  // 设置默认值（对齐 db.py DEFAULT_SETTINGS；PWA 无后端时也保证阈值/导航等有值）
  const SETTING_DEFAULTS = {
    asr_model: "tiny.en",
    cors_proxy: "",
    tts_voice_a: "Samantha", tts_voice_b: "Daniel", tts_rate: "175",
    dictation_pass_wer: "0.12", speaking_pass_score: "60", recall_pass_score: "60",
    ai_consent: "ask", ai_scope: "sentence", focus_free_nav: "0",
    llm_explain_prompt: "",
  };
  function allSettings() { return { ...SETTING_DEFAULTS, ...S.settings }; }

  // ================= 工具 =================
  function getSetting(key, def) {
    const v = S.settings[key];
    return v === undefined || v === null ? def : v;
  }
  function setSetting(key, val) { S.settings[key] = val; return save(); }
  function nextWordId() { return ++S.seq.word; }
  function nextSessionId() { return ++S.seq.session; }

  function getUnit(uid) {
    for (const units of Object.values(S.units)) {
      const u = units.find((x) => x.id === uid);
      if (u) return u;
    }
    return null;
  }
  function getUnits(mid) { return S.units[mid] || []; }
  function getMaterial(mid) {
    return S.materials.find((m) => m.id === mid) || null;
  }
  function getFocus(mid) {
    return S.focus[mid] || {
      material_id: mid, status: "new", listen_count: 0, dict_done: 0,
      shadow_done: 0, offscript_done: 0, stage: 0, next_review_at: null, reviews_done: 0,
    };
  }
  function ensureFocus(mid) {
    if (!S.focus[mid]) {
      S.focus[mid] = { status: "new", listen_count: 0, dict_done: 0, shadow_done: 0, offscript_done: 0, stage: 0, next_review_at: null, reviews_done: 0 };
    }
    return S.focus[mid];
  }
  function getMastery(uid) {
    return S.mastery[uid] || {
      unit_id: uid, listening: 0.0, dictation: 0.0, recall: 0.0, speaking: 0.0,
      overall: 0.0, interval_days: 1.0, stage: 0, next_review_at: null, reviews_done: 0,
    };
  }
  function ensureMastery(uid) {
    if (!S.mastery[uid]) {
      S.mastery[uid] = {
        unit_id: uid, listening: 0.0, dictation: 0.0, recall: 0.0, speaking: 0.0,
        overall: 0.0, interval_days: 1.0, stage: 0, next_review_at: null, reviews_done: 0,
      };
    }
    return S.mastery[uid];
  }
  function unitStatus(uid) { const u = getUnit(uid); return u ? u.status : null; }
  function setUnitStatus(uid, status) {
    const u = getUnit(uid);
    if (u) { u.status = status; }
  }

  // 场景标签（对齐 extract.scene_label 的常用集合）
  const SCENE_LABELS = {
    restaurant: ["餐厅", "🍽️"], doctor: ["看医生", "🏥"], news: ["新闻", "📰"],
    small_talk: ["闲聊", "💬"], phone: ["打电话", "📞"], shopping: ["购物", "🛒"],
    cooking: ["餐饮", "🍳"], home: ["居家", "🏠"], office: ["办公", "💼"],
    groceries: ["买菜", "🥦"], other: ["其他", "📌"],
  };
  function sceneLabel(scene) {
    const l = SCENE_LABELS[scene] || SCENE_LABELS.other;
    return { label: l[0], emoji: l[1] };
  }

  // 内置材料：音频静态打包（frontend/assets/audio/）；导入材料：整段 blob objectURL
  function unitAudioUrl(mid, uid) {
    const mat = getMaterial(mid);
    if (isImported(mat)) return importedAudioUrl(mid);
    const key = MATERIAL_KEYS[mid] || `m${mid}`;
    return `assets/audio/builtin_${key}_${uid}.wav`;
  }
  function fullAudioUrl(mid) {
    const mat = getMaterial(mid);
    if (isImported(mat)) return importedAudioUrl(mid);
    return `assets/audio/full_${mid}.wav`;
  }

  // 单元音频（与桌面 server.py _unit_audio 走同一契约 backend/audio_contract.py）
  // 文本材料 → 句级 TTS；内置 → 每句独立 wav；导入材料 → 整段 blob + start/end 范围裁剪，
  // 保证逐句播放永远只播本句，而不是越句继续往后放。
  function unitAudioFor(u) {
    const mat = getMaterial(u.material_id);
    if (mat && mat.media_type === "text") return { url: "", kind: "tts", text: u.text };
    if (!isImported(mat)) return { url: unitAudioUrl(u.material_id, u.id), start_ms: 0, end_ms: 0, kind: "file" };
    let nextStart = 0;
    if (!u.end_ms || u.end_ms <= (u.start_ms || 0)) {
      const nxt = (S.units[u.material_id] || [])
        .filter((x) => x.seq > u.seq && (x.start_ms || 0) > 0)
        .sort((a, b) => a.seq - b.seq)[0];
      nextStart = nxt ? nxt.start_ms : 0;
    }
    const { start_ms, end_ms } = window.dsAudioContract.resolveUnitRange(
      u.start_ms || 0, u.end_ms || 0, u.text, nextStart
    );
    return {
      url: unitAudioUrl(u.material_id, u.id),
      start_ms, end_ms, kind: "range", duration_ms: mat.duration_ms || 0,
    };
  }

  // ================= 单元 JSON（对齐 _unit_json / unit_progress） =================
  function unitJson(uid) {
    const u = getUnit(uid);
    if (!u) return null;
    const mat = getMaterial(u.material_id);
    const imported = isImported(mat);
    const exprs = u.expressions || [];
    return {
      id: u.id, material_id: u.material_id, seq: u.seq, text: u.text,
      status: u.status, scene: u.scene, difficulty: u.difficulty || 0,
      learning_value: u.learning_value || 0, speaker: u.speaker || "",
      start_ms: u.start_ms || 0, end_ms: u.end_ms || 0, is_flagged: u.is_flagged || 0,
      mastery: getMastery(uid),
      expressions: exprs.map((e) => ({
        expression: e.expression, meaning: e.meaning || "", intent: e.intent || "",
        label: e.meaning || "", variants: e.variants || [], source: e.source || "rule",
      })),
      explanation: "",
      audio: unitAudioFor(u),
    };
  }

  // ================= 材料 JSON（对齐 _material_json） =================
  function materialJson(mid) {
    const mat = getMaterial(mid);
    if (!mat) return null;
    const imported = isImported(mat);
    const units = getUnits(mid);
    const done = units.filter((u) => ["REVIEW_DUE", "MASTERED"].includes(u.status)).length;
    const mastered = units.filter((u) => u.status === "MASTERED").length;
    const { label, emoji } = sceneLabel(mat.scene || "");
    const f = focusProgress(mid);
    const hasAudio = imported ? !!importedAudioUrl(mid) : true;
    return {
      ...mat,
      is_builtin: !imported,
      scene_label: label, scene_emoji: emoji,
      source: imported
        ? { type: mat.source_type, url: mat.source_url || "", episodes: mat.episodes || [], error: mat.error || "", has_audio: hasAudio }
        : { type: "builtin", url: "", episodes: [], error: "", has_audio: true },
      source_type: mat.source_type || "builtin",
      process_step: mat.process_step || "", process_pct: mat.process_pct || 0,
      audio_url: imported ? importedAudioUrl(mid) : "",
      units: units.map((u) => ({
        id: u.id, seq: u.seq, text: u.text, status: u.status, scene: u.scene,
        difficulty: u.difficulty, learning_value: u.learning_value,
        audio: unitAudioFor(u),
      })),
      unit_total: units.length, unit_done: done, unit_mastered: mastered,
      unit_stats: { total: units.length, done, mastered },
      focus: { ...f, audio_ready: hasAudio },
    };
  }

  // ================= focus 状态机（对齐 focus.py） =================
  function focusProgress(mid) {
    const f = getFocus(mid);
    const steps = {
      listen: !!f.listen_count,
      dictation: !!f.dict_done,
      shadowing: !!f.shadow_done,
      offscript: !!f.offscript_done,
    };
    const due = !!f.next_review_at && f.next_review_at <= nowStr();
    return { ...f, steps, due };
  }

  function focusAct(mid, action) {
    const f = ensureFocus(mid);
    if (action === "back") {
      if (!(f.status in FOCUS_BACK_TO)) {
        return { ok: false, focus: { ...f }, err: `当前状态 ${f.status} 不能回退` };
      }
      f.status = FOCUS_BACK_TO[f.status];
      return { ok: true, focus: { ...f }, err: null };
    }
    const rule = FOCUS_ACTS[action];
    if (!rule) return { ok: false, focus: { ...f }, err: `未知动作: ${action}` };
    const [allowed, target] = rule;
    if (!allowed.includes(f.status)) {
      return { ok: false, focus: { ...f }, err: `当前状态 ${f.status} 不允许 ${action}` };
    }
    if (action === "listen_again") f.listen_count += 1;
    else if (action === "listen_done") f.listen_count = Math.max(f.listen_count, 1);
    else if (action === "dict_done") f.dict_done = 1;
    else if (action === "shadow_done") f.shadow_done = 1;
    else if (action === "offscript_done") {
      f.offscript_done = 1;
      f.next_review_at = daysAfter(FOCUS_INTERVALS[0]);
    }
    f.status = target;
    return { ok: true, focus: { ...f }, err: null };
  }

  function focusApplyReview(mid, passed) {
    const f = ensureFocus(mid);
    if (!["review_due", "mastered"].includes(f.status)) {
      return { ok: false, focus: { ...f }, err: `当前状态 ${f.status} 不在复习队列` };
    }
    if (passed) {
      f.stage = Math.min(f.stage + 1, FOCUS_INTERVALS.length - 1);
      f.reviews_done += 1;
      f.status = (f.status === "mastered" || f.reviews_done >= FOCUS_MASTER_MIN_REVIEWS) ? "mastered" : "review_due";
      f.next_review_at = daysAfter(FOCUS_INTERVALS[f.stage]);
    } else {
      f.status = "offscript";
      f.stage = Math.max(0, f.stage - 1);
      f.next_review_at = null;
    }
    S.focus_review_history.push({
      material_id: mid, result: passed ? "pass" : "fail",
      interval_days: FOCUS_INTERVALS[Math.min(f.stage, FOCUS_INTERVALS.length - 1)],
      reviewed_at: nowStr(),
    });
    return { ok: true, focus: { ...f }, err: null };
  }

  function focusDue() {
    const out = [];
    for (const [mid, f] of Object.entries(S.focus)) {
      if (["review_due", "mastered"].includes(f.status) && f.next_review_at && f.next_review_at <= nowStr()) {
        const mat = getMaterial(Number(mid));
        const { label, emoji } = sceneLabel(mat ? mat.scene : "");
        out.push({
          material_id: Number(mid), title: mat ? mat.title : "",
          scene_label: label, scene_emoji: emoji,
          status: f.status, stage: f.stage, reviews_done: f.reviews_done,
          next_review_at: f.next_review_at,
        });
      }
    }
    out.sort((a, b) => (a.next_review_at < b.next_review_at ? -1 : 1));
    return out;
  }

  // ================= 单元状态机（对齐 review.py / server.py） =================
  function overallFrom(skills) {
    let overall = 0;
    for (const k of Object.keys(SKILL_WEIGHTS)) overall += SKILL_WEIGHTS[k] * skills[k];
    if (skills.recall < 0.6) overall = Math.min(overall, skills.recall + 0.25);
    return Math.round(overall * 1000) / 1000;
  }

  function applySkill(scores, skill, result) {
    const cur = scores[skill] || 0.0;
    if (result === "pass") {
      if (cur < 0.7) scores[skill] = 0.7;
      else if (cur < 0.95) scores[skill] = Math.min(0.95, cur + 0.12);
    } else if (result === "partial") {
      scores[skill] = Math.max(0.45, cur * 0.8);
    } else {
      scores[skill] = cur <= 0.3 ? Math.min(cur, 0.3) : Math.round(cur * 0.45 * 1000) / 1000;
    }
  }

  function recordSessionResult(unitId, sessionType, result, trainedSkills) {
    const m = ensureMastery(unitId);
    let skills = [];
    const skill = TYPE_SKILL[sessionType];
    if (trainedSkills && trainedSkills.length) skills = trainedSkills;
    else if (skill) skills = [skill];
    const scores = { ...m };
    for (const s of skills) applySkill(scores, s, result);
    const overall = overallFrom(scores);

    let stage = m.stage, reviewsDone = m.reviews_done;
    if (sessionType.startsWith("review")) {
      if (result === "pass") { stage = Math.min(stage + 1, INTERVALS.length - 1); reviewsDone += 1; }
      else if (result === "fail") { stage = Math.max(0, stage - 2); reviewsDone = Math.max(0, reviewsDone - 1); }
      else if (result === "partial") { stage = Math.max(0, stage - 1); }
    }
    const interval = INTERVALS[Math.min(stage, INTERVALS.length - 1)];
    Object.assign(m, {
      listening: scores.listening, dictation: scores.dictation, recall: scores.recall,
      speaking: scores.speaking, overall, interval_days: interval, stage,
      reviews_done: reviewsDone, next_review_at: daysAfter(interval), updated_at: nowStr(),
    });
    S.review_history.push({
      unit_id: unitId, review_type: sessionType, result, interval_days: interval, reviewed_at: nowStr(),
    });
    return { ...m };
  }

  function isMastered(m) {
    return m.overall >= MASTER_MIN_OVERALL
      && ["listening", "dictation", "recall", "speaking"].every((k) => m[k] >= MASTER_MIN_SKILL)
      && m.reviews_done >= MASTER_MIN_REVIEWS;
  }

  function unitStatusAfterSession(unitId, sessionType, result) {
    let status = unitStatus(unitId) || "NEW";
    let regressed = false;
    if (result === "fail" && ["review_dictation", "review_recall", "review_speaking"].includes(sessionType)) {
      status = "ACTIVE_RECALL"; regressed = true;
    } else if (result === "fail" && sessionType === "shadowing") {
      status = "SHADOWING";
    } else if (result === "fail" && sessionType === "active_recall") {
      // 回忆失败：留在主动回忆可重试/跳过，不回退跟读（与后端 forced ACTIVE_RECALL 对齐）
      status = "ACTIVE_RECALL"; regressed = false;
    } else if (result === "fail" && sessionType === "dictation") {
      status = "DICTATION";
    }
    return [status, regressed];
  }

  function unitTransition(unitId, to) {
    const cur = unitStatus(unitId);
    if (cur === null) return { ok: false, status: null, err: "单元不存在" };
    if (!UNIT_TRANSITIONS[cur] || !UNIT_TRANSITIONS[cur][to]) {
      return { ok: false, status: cur, err: `不允许的状态迁移: ${cur} → ${to}` };
    }
    setUnitStatus(unitId, to);
    return { ok: true, status: to, err: null };
  }

  function unitAfterSession(unitId, sessionType, result, forcedStatus) {
    recordSessionResult(unitId, sessionType, result);
    if (forcedStatus) {
      setUnitStatus(unitId, forcedStatus);
    } else {
      const [status] = unitStatusAfterSession(unitId, sessionType, result);
      setUnitStatus(unitId, status);
    }
    return unitJson(unitId);
  }

  function unitDictation(unitId, userInput, opts) {
    opts = opts || {};
    const u = getUnit(unitId);
    if (!u) throw new Error("单元不存在");
    const sessionId = opts.session_id || 0;
    const assessOnly = !!opts.assess_only;
    if (!userInput) throw new Error("请输入听写内容");
    userInput = String(userInput).replace(/\s+/g, " ").trim(); // 折叠换行/多余空白
    if (!userInput) throw new Error("请输入听写内容");
    const threshold = parseFloat(getSetting("dictation_pass_wer", "0.12"));
    const result = judgeDictation(u.text, userInput, threshold);
    S.answers.push({
      session_id: sessionId, unit_id: unitId, kind: "dictation", user_input: userInput,
      reference: u.text, wer: result.wer, cer: result.cer,
      passed: result.passed ? 1 : 0, created_at: nowStr(),
    });
    let status = u.status;
    if (assessOnly) {
      return { ...result, status };
    }
    if (result.passed) {
      unitAfterSession(unitId, "dictation", "pass", "REVEALED");
      status = "REVEALED";
    }
    return { ...result, status };
  }

  function unitSpeaking(unitId, kind, text) {
    const u = getUnit(unitId);
    if (!u) throw new Error("单元不存在");
    if (!text) throw new Error("没有内容（录音未识别或未输入）");
    const sessionId = 0;
    const variants = [];
    for (const e of (u.expressions || [])) {
      for (const v of (e.variants || [])) variants.push(v);
    }
    let result, sessionType, trained;
    if (kind === "shadowing") {
      const passScore = parseFloat(getSetting("speaking_pass_score", "60"));
      result = judgeSpeaking(u.text, text, passScore);
      sessionType = "shadowing"; trained = ["speaking"];
    } else {
      const passScore = parseFloat(getSetting("recall_pass_score", "60"));
      result = judgeRecall(u.text, variants, [], text, passScore);
      sessionType = "active_recall"; trained = ["recall"];
    }
    S.speaking_attempts.push({
      kind, unit_id: unitId, score: result.score, exact: result.exact ? 1 : 0,
      verdict: result.verdict, passed: result.passed ? 1 : 0, created_at: nowStr(),
    });
    unitAfterSession(unitId, sessionType, result.verdict, null);
    return { ...result, evaluation: {}, status: unitStatus(unitId) };
  }

  function applyUnitReview(unitId, skills) {
    const m = ensureMastery(unitId);
    const scores = { ...m };
    const passed = Object.values(skills).some((r) => r === "pass");
    const failed = Object.values(skills).some((r) => r === "fail");
    for (const [s, result] of Object.entries(skills)) {
      if (s in SKILL_WEIGHTS) applySkill(scores, s, result);
    }
    let overall = overallFrom(scores);
    if (failed && !passed) overall = Math.min(overall, 0.5);
    else if (failed) overall = Math.min(overall, 0.7);

    let stage = m.stage, reviewsDone = m.reviews_done;
    if (passed && !failed) { stage = Math.min(stage + 1, INTERVALS.length - 1); reviewsDone += 1; }
    else if (failed && passed) { stage = Math.max(0, stage - 1); }
    else if (failed) { stage = Math.max(0, stage - 2); reviewsDone = Math.max(0, reviewsDone - 1); }

    const interval = INTERVALS[Math.min(stage, INTERVALS.length - 1)];
    Object.assign(m, {
      listening: scores.listening, dictation: scores.dictation, recall: scores.recall,
      speaking: scores.speaking, overall, interval_days: interval, stage,
      reviews_done: reviewsDone, next_review_at: daysAfter(interval), updated_at: nowStr(),
    });
    const overallResult = passed && !failed ? "pass" : (failed && !passed ? "fail" : "partial");
    S.review_history.push({
      unit_id: unitId, review_type: "review", result: overallResult, interval_days: interval, reviewed_at: nowStr(),
    });

    let status;
    if (isMastered(m)) status = "MASTERED";
    else if (failed) status = "ACTIVE_RECALL";
    else status = "REVIEW_DUE";
    setUnitStatus(unitId, status);
    return { status, mastery: { ...m }, unit: unitJson(unitId) };
  }

  function dueUnits(limit = 50) {
    const now = nowStr();
    const out = [];
    for (const uid of Object.keys(S.mastery)) {
      const m = S.mastery[uid];
      const u = getUnit(Number(uid));
      if (!u) continue;
      if (!["REVIEW_DUE", "MASTERED", "UNDERSTOOD", "ACTIVE_RECALL", "SHADOWING", "DICTATION", "REVEALED"].includes(u.status)) continue;
      if (!m.next_review_at || m.next_review_at > now) continue;
      out.push({ ...u, mastery: { ...m } });
    }
    out.sort((a, b) => (a.mastery.next_review_at < b.mastery.next_review_at ? -1 : 1));
    return out.slice(0, limit);
  }

  function todayCounts() {
    const now = nowStr();
    const due = dueUnits(100000);
    const statusOk = ["REVIEW_DUE", "MASTERED", "UNDERSTOOD", "ACTIVE_RECALL", "SHADOWING", "REVEALED", "DICTATION"];
    const reviewDue = due.filter((u) => statusOk.includes(u.status)).length;
    let newCount = 0;
    for (const units of Object.values(S.units)) newCount += units.filter((u) => u.status === "NEW").length;
    const speakingDue = due.filter((u) => statusOk.includes(u.status) && u.mastery.recall < 0.7).length;
    return { review_due: reviewDue, new_count: newCount, speaking_due: speakingDue };
  }

  function continueUnit() {
    // 优先未完成材料中的下一个新单元
    for (const mid of Object.keys(S.units).map(Number).sort((a, b) => a - b)) {
      const units = getUnits(mid).sort((a, b) => a.seq - b.seq);
      const nu = units.find((u) => u.status === "NEW");
      if (nu) return nu;
    }
    const due = dueUnits(1);
    if (due.length) return due[0];
    for (const units of Object.values(S.units)) {
      const u = units.find((x) => !["NEW", "MASTERED"].includes(x.status));
      if (u) return u;
    }
    return null;
  }

  function weakScenes(limit = 3) {
    const byScene = {};
    for (const uid of Object.keys(S.mastery)) {
      const u = getUnit(Number(uid));
      if (!u || !u.scene || u.scene === "other" || u.status === "NEW") continue;
      const m = S.mastery[uid];
      if (!byScene[u.scene]) byScene[u.scene] = { sum: 0, n: 0, min: Infinity };
      byScene[u.scene].sum += m.overall;
      byScene[u.scene].n += 1;
      byScene[u.scene].min = Math.min(byScene[u.scene].min, m.overall);
    }
    const rows = [];
    for (const [scene, v] of Object.entries(byScene)) {
      if (v.n < 2) continue;
      rows.push({ scene, avg_overall: Math.round((v.sum / v.n) * 1000) / 1000, count: v.n, min_overall: v.min });
    }
    rows.sort((a, b) => a.avg_overall - b.avg_overall);
    return rows.slice(0, limit).map((r) => {
      const { label, emoji } = sceneLabel(r.scene);
      return { ...r, scene_label: label, scene_emoji: emoji };
    });
  }

  function continueFocus() {
    let best = null;
    for (const [mid, f] of Object.entries(S.focus)) {
      if (!["new", "mastered"].includes(f.status)) {
        best = { material_id: Number(mid), focus: f };
      }
    }
    if (best) return focusCard(best.material_id);
    for (const mat of S.materials) {
      const f = S.focus[mat.id];
      if (!f || f.status === "new") return focusCard(mat.id);
    }
    return null;
  }
  function focusCard(mid) {
    const mat = getMaterial(mid);
    const f = getFocus(mid);
    const { label, emoji } = sceneLabel(mat ? mat.scene : "");
    const steps = {
      listen: !!f.listen_count,
      dictation: !!f.dict_done,
      shadowing: !!f.shadow_done,
      offscript: !!f.offscript_done,
    };
    return {
      material_id: mid, title: mat ? mat.title : "", scene: mat ? mat.scene : "",
      scene_label: label, scene_emoji: emoji,
      status: f.status, listen_count: f.listen_count,
      stage: f.stage, reviews_done: f.reviews_done,
      steps, next_review_at: f.next_review_at,
    };
  }

  // ================= 统计（对齐 server.py /api/stats） =================
  function computeStats() {
    const today = todayStr();
    const cnt = (arr, field) => arr.filter((r) => localDateKey(r[field]) === today).length;
    const dict = cnt(S.answers, "created_at");
    const dictUnitIds = new Set();
    for (const a of S.answers) {
      if (a.unit_id && localDateKey(a.created_at) === today) dictUnitIds.add(a.unit_id);
    }
    const speak = S.speaking_attempts.filter((r) => localDateKey(r.created_at) === today).length;
    const recall = S.speaking_attempts.filter((r) => r.kind === "active_recall" && localDateKey(r.created_at) === today).length;
    const unitReview = S.review_history.filter((r) => localDateKey(r.reviewed_at) === today).length;
    const focus = S.focus_dictations.filter((r) => localDateKey(r.created_at) === today).length;
    const checked = S.checkins.includes(today);
    let streak = 0;
    let d = new Date();
    while (S.checkins.includes(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
    // 近 7 天 / 近 30 天
    const byDay = (arr, field) => {
      const m = {};
      for (const r of arr) {
        const k = localDateKey(r[field]);
        if (k) m[k] = (m[k] || 0) + 1;
      }
      return m;
    };
    const dDict = byDay(S.answers, "created_at");
    const dSpeak = byDay(S.speaking_attempts, "created_at");
    const dRev = byDay(S.review_history, "reviewed_at");
    const dFocus = byDay(S.focus_dictations, "created_at");
    const last7 = [], heat = [];
    for (let i = 6; i >= 0; i--) {
      const ds = daysAgo(i);
      last7.push({ date: ds, dict: dDict[ds] || 0, speak: dSpeak[ds] || 0, review: dRev[ds] || 0, focus: dFocus[ds] || 0 });
    }
    for (let i = 29; i >= 0; i--) {
      const ds = daysAgo(i);
      heat.push({ date: ds, count: (dDict[ds] || 0) + (dSpeak[ds] || 0) + (dRev[ds] || 0) + (dFocus[ds] || 0) });
    }
    return {
      today: { dict, dict_units: dictUnitIds.size, speak, recall, unit_review: unitReview, focus, checked, streak },
      last7, heat,
    };
  }

  function materialProgress(mid) {
    const dicts = S.focus_dictations.filter((r) => r.material_id === mid).map((r) => ({
      id: r.id || 0, overall_wer: r.overall_wer, correct_words: r.correct_words,
      total_words: r.total_words, sentence_count: r.sentence_count, created_at: r.created_at,
    }));
    const revs = S.focus_review_history.filter((r) => r.material_id === mid).map((r) => ({
      result: r.result, interval_days: r.interval_days, reviewed_at: r.reviewed_at,
    }));
    return { dictations: dicts, reviews: revs };
  }

  // ================= 词库（对齐 wordbank.py） =================
  let _wordbank = null;
  function loadWordbank() {
    if (_wordbank) return Promise.resolve(_wordbank);
    return fetch("assets/data/wordbank.json")
      .then((r) => { if (!r.ok) throw new Error("wordbank 加载失败"); return r.json(); })
      .then((data) => { _wordbank = data; return data; })
      .catch(() => { _wordbank = {}; return _wordbank; });
  }
  function wordbankLookup(text) {
    const q = String(text || "").trim().toLowerCase().replace(/^[.,!?;:'"()[\]\- ]+|[.,!?;:'"()[\]\- ]+$/g, "");
    if (!q) return null;
    const candidates = [q];
    if (q.includes(" ")) candidates.push(q.split(" ")[0]);
    for (const c of candidates) {
      if (c in _wordbank) return [c, _wordbank[c]];
    }
    const m = q.match(/[a-z']+/g) || [];
    for (const w of m) {
      if (w in _wordbank) return [w, _wordbank[w]];
    }
    return null;
  }

  // ================= 本地 AI Provider（可选增强；配置仅存本机浏览器） =================
  // 与后端 ai.py 的 PLATFORM_PRESETS 同构：设置页「常用平台」chips 一键填充
  const LOCAL_PLATFORMS = [
    { name: "OpenAI", type: "openai", base_url: "https://api.openai.com/v1", models: ["gpt-4o-mini", "gpt-4o"] },
    { name: "DeepSeek", type: "openai_compatible", base_url: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"] },
    { name: "OpenRouter", type: "openai_compatible", base_url: "https://openrouter.ai/api/v1", models: ["openai/gpt-4o-mini", "deepseek/deepseek-chat"] },
    { name: "Moonshot Kimi", type: "openai_compatible", base_url: "https://api.moonshot.cn/v1", models: ["moonshot-v1-8k", "moonshot-v1-32k"] },
    { name: "智谱 GLM", type: "openai_compatible", base_url: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-flash", "glm-4-air"] },
    { name: "通义千问", type: "openai_compatible", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-turbo", "qwen-plus"] },
    { name: "Groq", type: "openai_compatible", base_url: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
    { name: "Ollama（本地）", type: "ollama", base_url: "http://localhost:11434/v1", models: ["qwen2.5", "llama3.1"] },
  ];
  if (typeof window !== "undefined") window.dsPlatforms = LOCAL_PLATFORMS;

  function providerOk(p) {
    if (!p) return false;
    if (p.provider_type === "ollama") return true;
    if (p.provider_type === "openai_compatible") return !!p.base_url;
    return !!p.api_key;
  }
  function enabledProvider() {
    return (S.providers || []).find((p) => p.enabled && providerOk(p)) || null;
  }
  function nextProviderId() {
    S.seq.provider = (S.seq.provider || 0) + 1;
    return S.seq.provider;
  }
  function parseLLMJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    let m = t.match(/```(?:json)?\s*(\{.*?\})\s*```/s);
    if (m) t = m[1];
    else { m = t.match(/\{.*\}/s); if (m) t = m[0]; }
    try { return JSON.parse(t); } catch (e) {
      try { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); } catch (e2) { return null; }
    }
  }
  // 与后端 ai.py chat() 同构：OpenAI 兼容 / Anthropic / Gemini 三派发；配置仅存本机
  async function llmChatWith(p, messages, opts) {
    if (!p) throw new Error("没有可用的 AI Provider：请到 设置 → AI Provider 配置一个（OpenAI 兼容 / Ollama 等均可）");
    const base = (p.base_url || "").replace(/\/+$/, "");
    const model = p.model || "";
    const key = p.api_key || "";
    const temperature = opts && opts.temperature !== undefined ? opts.temperature : 0.3;
    const max_tokens = (opts && opts.max_tokens) || 1500;
    const jsonMode = !opts || opts.json_mode !== false;
    let url, headers = { "content-type": "application/json" }, body;
    if (p.provider_type === "anthropic") {
      url = base + "/v1/messages";
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      body = { model, max_tokens, messages };
      if (!jsonMode) body.temperature = temperature;
    } else if (p.provider_type === "gemini") {
      url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      body = {
        contents: messages.map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] })),
        generationConfig: { temperature, maxOutputTokens: max_tokens },
      };
    } else {
      url = base + "/chat/completions";
      if (key) headers["authorization"] = "Bearer " + key;
      body = { model, messages, temperature, max_tokens };
      if (jsonMode) body.response_format = { type: "json_object" };
    }
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error("无法连接 " + base + "：" + ((e && e.message) || e));
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
      throw new Error(`AI Provider 返回 ${res.status}：${detail}`);
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error("AI Provider 返回了无法解析的内容"); }
    if (p.provider_type === "anthropic") {
      return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    }
    if (p.provider_type === "gemini") {
      try { return data.candidates[0].content.parts[0].text; }
      catch (e) { throw new Error("Gemini 返回格式异常"); }
    }
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }
  async function llmChat(messages, opts) { return llmChatWith(enabledProvider(), messages, opts); }

  // 学习画像（对齐 server.py _learner_profile；统计页「AI 分析」与 AI 生成参考共用）
  function localLearnerProfile() {
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const dicts = S.answers.filter((a) => a.kind === "dictation");
    const dictPassed = dicts.filter((a) => a.passed).length;
    const dictWers = dicts.map((a) => a.wer).filter((v) => v !== undefined && v !== null);
    const fdicts = S.focus_dictations || [];
    const fwers = fdicts.map((f) => f.overall_wer).filter((v) => v !== undefined && v !== null);
    const weak = [];
    for (const f of fdicts) {
      let items = [];
      try { items = f.detail_json ? (typeof f.detail_json === "string" ? JSON.parse(f.detail_json) : f.detail_json) : []; } catch (e) { /* ignore */ }
      for (const it of items || []) {
        const tot = it.total || 0, cor = it.correct || 0;
        if (tot >= 3 && cor / tot <= 0.6 && it.text) {
          weak.push({ text: String(it.text).slice(0, 120), acc: Math.round((cor / tot) * 100) });
        }
      }
    }
    weak.sort((a, b) => a.acc - b.acc);
    const speaks = S.speaking_attempts || [];
    const speakPassed = speaks.filter((s) => s.passed).length;
    const scores = speaks.map((s) => s.match_score).filter((v) => typeof v === "number");
    const recalls = speaks.filter((s) => s.kind === "active_recall");
    const recallPassed = recalls.filter((s) => s.passed).length;
    let totalUnits = 0, masteredUnits = 0;
    for (const units of Object.values(S.units)) {
      totalUnits += units.length;
      masteredUnits += units.filter((u) => u.status === "MASTERED").length;
    }
    const activeMats = S.materials.filter((m) => {
      const f = getFocus(m.id).status;
      const done = getUnits(m.id).filter((u) => ["REVIEW_DUE", "MASTERED"].includes(u.status)).length;
      return ["listening", "dictation", "shadowing", "offscript", "review_due"].includes(f) || done > 0;
    });
    let streak = 0;
    const d = new Date();
    while (S.checkins.includes(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
    const profile = {
      materials: { total: S.materials.length, units: totalUnits, mastered: masteredUnits, active: activeMats.length },
      dictation: { total: dicts.length, passed: dictPassed, pass_rate: pct(dictPassed, dicts.length), avg_wer: Math.round(avg(dictWers) * 1000) / 1000 },
      focus_dictation: { total: fdicts.length, avg_wer: Math.round(avg(fwers) * 1000) / 1000 },
      weak_sentences: weak.slice(0, 8),
      speaking: { total: speaks.length, passed: speakPassed, pass_rate: pct(speakPassed, speaks.length), avg_score: Math.round(avg(scores)) },
      recall: { total: recalls.length, passed: recallPassed, pass_rate: pct(recallPassed, recalls.length) },
      review: { total: S.review_history.length },
      words: { total: S.words.length },
      checkins: { total: S.checkins.length, streak },
      weak_scenes: weakScenes(),
    };
    const lines = [
      `累计：材料 ${profile.materials.total} 个，句子 ${totalUnits} 句（已掌握 ${masteredUnits}，进行中 ${activeMats.length} 个材料）。`,
      `听写：共 ${dicts.length} 次，通过率 ${pct(dictPassed, dicts.length)}%，平均词错率 ${Math.round(avg(dictWers) * 100)}%；整段听写 ${fdicts.length} 次，平均准确率 ${Math.round((1 - avg(fwers)) * 100)}%。`,
      `口语：共 ${speaks.length} 次，通过率 ${pct(speakPassed, speaks.length)}%，平均匹配分 ${Math.round(avg(scores))}；其中主动回忆 ${recalls.length} 次（通过率 ${pct(recallPassed, recalls.length)}%）。`,
      `复习：共完成 ${S.review_history.length} 次。生词本收藏 ${S.words.length} 个。打卡 ${S.checkins.length} 天，当前连续 ${streak} 天。`,
    ];
    if (weak.length) lines.push("薄弱句（整段听写准确率≤60%）：" + weak.slice(0, 5).map((w) => `「${w.text}」(${w.acc}%)`).join("；"));
    const ws = weakScenes();
    if (ws && ws.length) lines.push("薄弱场景：" + ws.map((w) => `${w.label}（${w.avg_mastery}分）`).join("、"));
    return { profile, summary: lines.join("\n") };
  }

  // ================= 路由分发 =================
  async function api(method, path, body) {
    await loadState();
    const p = path.replace(/^\/api/, "");
    const b = body || {};
    let m;

    // ---- 健康 ----
    if (p === "/health" && method === "GET") {
      // PWA：语音识别走浏览器 Web Speech API（支持则可用）；TTS 用浏览器 speechSynthesis
      const webAsr = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
      return {
        ok: true, version: "local", asr_available: webAsr,
        asr_engine: webAsr ? "web" : null, asr_error: webAsr ? "" : "浏览器不支持 Web Speech API",
        tts_available: "speechSynthesis" in window, tts_engine: "browser",
        ai_provider: !!enabledProvider(), platform: "browser",
      };
    }
    // ---- 点词释义（对齐后端 /api/explain；句子翻译在网页版无 LLM 不可用） ----
    if (p === "/explain" && method === "POST") {
      const text = String(b.text || "").trim();
      if (!text) throw new Error("没有可查询的内容");
      if (b.kind === "word") {
        await loadWordbank();
        const hit = wordbankLookup(text);
        if (hit) {
          const [word, entry] = hit;
          const pos = Array.isArray(entry) ? entry[0] : (entry && entry.pos) || "";
          const meaning = Array.isArray(entry) ? entry[1] : (entry && entry.meaning) || "";
          return { ok: true, found: true, kind: "word", word, pos, meaning, example_en: "", example_zh: "", source: "wordbank" };
        }
        // 词库未命中：免费在线词典（dictionaryapi.dev，无需 key；离线自动跳过）
        try {
          const word = (text.split(/\s+/)[0] || text).toLowerCase().replace(/[^a-z'-]/g, "");
          if (word && !word.includes(" ")) {
            const res = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word), { cache: "no-cache" });
            if (res.ok) {
              const list = await res.json();
              const entry = Array.isArray(list) && list[0];
              const m0 = entry && entry.meanings && entry.meanings[0];
              const d0 = m0 && m0.definitions && m0.definitions[0];
              if (m0 && d0 && d0.definition) {
                const phonetic = (entry.phonetics || []).map(p => p.text).filter(Boolean)[0] || "";
                return { ok: true, found: true, kind: "word", word,
                         pos: m0.partOfSpeech || "", meaning: d0.definition,
                         example_en: d0.example || "", phonetic, source: "online" };
              }
            }
          }
        } catch (e) { /* 离线/失败 → 静默跳过 */ }
        const word = (text.split(/\s+/)[0] || text).toLowerCase();
        return { ok: true, found: false, kind: "word", word, pos: "", meaning: "" };
      }
      // sentence：通俗解释（翻译 + 有趣讲解 + 例子），支持自定义提示词（设置 llm_explain_prompt，{text} 占位）
      const custom = getSetting("llm_explain_prompt", "").trim();
      let out;
      try {
        if (custom) {
          const user = custom.includes("{text}") ? custom.replace(/\{text\}/g, text) : custom + "\n\n句子：" + text;
          out = await llmChat([
            { role: "system", content: "你是一位英语学习助手，用简体中文、轻松有趣的方式回答。" },
            { role: "user", content: user },
          ], { json_mode: false, temperature: 0.4 });
          out = String(out || "").trim();
          if (!out) throw new Error("AI 未返回内容，请重试");
          return { ok: true, found: true, kind: "sentence", translation_zh: "", explanation_zh: out, examples: [], source: "llm" };
        }
        out = await llmChat([
          { role: "system", content: "You are an English learning assistant for a Chinese learner. Answer in simplified Chinese, keep it fun and easy to understand. Return ONLY valid JSON matching the requested schema." },
          { role: "user", content: JSON.stringify({
            task: "用轻松、有趣、通俗的方式给一位中国英语学习者讲解这句英语。",
            sentence: text,
            output_schema: {
              translation_zh: "口语化中文翻译（不出现英文）",
              explanation_zh: "通俗有趣的讲解（80 字内）：这句话什么场景用、结构或地道之处、容易听错/用错的地方",
              examples: [{ en: "同类情景下的自然说法（英文）", zh: "中文" }],
            },
            rule: "Max 2 examples. Use simplified Chinese. explanation must be fun and easy to understand, avoid jargon.",
          }) },
        ], { temperature: 0.4 });
        const data = parseLLMJson(out) || {};
        if (!data.translation_zh && !data.explanation_zh) throw new Error("AI 未返回内容，请重试");
        return { ok: true, found: true, kind: "sentence", translation_zh: data.translation_zh || "", explanation_zh: data.explanation_zh || "", examples: data.examples || [], source: "llm" };
      } catch (e) {
        throw new Error(e && e.message ? e.message : String(e));
      }
    }
    // ---- 今日 ----
    if (p === "/today" && method === "GET") {
      const cont = continueUnit();
      const counts = todayCounts();
      let totalUnits = 0, masteredUnits = 0;
      for (const units of Object.values(S.units)) {
        totalUnits += units.length;
        masteredUnits += units.filter((u) => u.status === "MASTERED").length;
      }
      return {
        ok: true, ...counts,
        continue_unit: cont ? { id: cont.id, text: cont.text, status: cont.status, material_id: cont.material_id, seq: cont.seq, scene: cont.scene } : null,
        weak_scenes: weakScenes(),
        total_units: totalUnits, mastered: masteredUnits,
        focus_due: focusDue().length,
        continue_focus: continueFocus(),
      };
    }
    // ---- 设置 ----
    if (p === "/settings" && method === "GET") return { ok: true, settings: allSettings() };
    if (p === "/settings" && method === "PUT") {
      for (const [k, v] of Object.entries(b)) setSetting(k, v);
      await save();
      return { ok: true };
    }
    // ---- 材料 ----
    if (method === "GET" && (p === "/materials" || p.startsWith("/materials?"))) {
      const sort = new URLSearchParams((p.split("?")[1] || "")).get("sort") || "time_desc";
      const out = S.materials.map((mat) => {
        const units = getUnits(mat.id);
        const done = units.filter((u) => ["REVIEW_DUE", "MASTERED"].includes(u.status)).length;
        const mastered = units.filter((u) => u.status === "MASTERED").length;
        const { label, emoji } = sceneLabel(mat.scene || "");
        return {
          ...mat, scene_label: label, scene_emoji: emoji,
          source_type: mat.source_type || "builtin",
          is_builtin: !isImported(mat),
          unit_total: units.length, unit_done: done, unit_mastered: mastered,
          focus_status: getFocus(mat.id).status,
        };
      });
      // 内置材料固定置顶，其余按 created_at 排序（对齐后端 is_builtin DESC + created_at；old = 导入顺序）
      const key = (m) => String(m.created_at || "");
      out.sort((a, b) => {
        if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
        if (sort === "old") return b.id - a.id;
        return sort === "time_asc" ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a));
      });
      return { ok: true, materials: out };
    }
    // 文本导入（对齐桌面 pipeline.create_from_text：立即分句建单元；播放时按句 Kokoro 合成）
    if (p === "/materials" && method === "POST") {
      const text = String(b.text || "").trim();
      if (!text) throw new Error("文本为空");
      const title = (b.title || "").trim() || "粘贴文本";
      const sourceType = b.source_type || "manual_text";
      const mid = nextMaterialId();
      S.materials.push({
        id: mid, title, description: "通过文本导入", media_type: "text", language: "en",
        scene: "", difficulty: 0, duration_ms: 0, status: "processing", tags: "",
        source_type: sourceType, source_url: "", episodes: [],
        process_step: "building", process_pct: 10, has_audio: false, created_at: nowStr(),
      });
      S.units[mid] = [];
      await save();
      try {
        // 字幕（SRT/VTT）按块取文本行；纯文本走分句（对齐 parse_subtitle + split_sentences）
        const segs = text.includes("-->")
          ? (() => {
              const out = [];
              for (const block of text.replace(/\r/g, "").trim().split(/\n\s*\n/)) {
                const ls = block.split("\n").map((s) => s.trim()).filter(Boolean);
                let i = /^\d+$/.test(ls[0] || "") ? 1 : 0;
                if (ls[i] && ls[i].includes("-->")) i++;
                const t = ls.slice(i).join(" ");
                if (t) out.push({ text: t, start: 0, end: 0 });
              }
              return out;
            })()
          : (window.dsImport ? window.dsImport.splitSentences(text) : text.split(/\n+/))
              .map((t) => ({ text: String(t), start: 0, end: 0 }));
        const built = window.dsImport ? window.dsImport.buildUnits(segs) : [];
        if (!built.length) throw new Error("没有可学习的句子");
        S.units[mid] = built.map((u) => ({
          id: nextUnitId(), material_id: mid, seq: u.seq, text: u.text, speaker: u.speaker || "",
          start_ms: u.start_ms || 0, end_ms: u.end_ms || 0, scene: u.scene || "",
          difficulty: u.difficulty || 0, learning_value: u.learning_value || 0,
          status: "NEW", expressions: u.expressions || [],
        }));
        const mat = getMaterial(mid);
        mat.status = "ready"; mat.process_step = "done"; mat.process_pct = 100;
        await save();
        return { ok: true, id: mid, material: materialJson(mid) };
      } catch (e) {
        _markError(mid, e);
        throw e;
      }
    }
    if (p === "/materials/upload" || p === "/materials/url") {
      if (p === "/materials/url" && method === "POST") {
        const url = String(b.url || "").trim();
        if (!url) throw new Error("URL 为空");
        if (!window.dsImport) throw new Error("导入引擎未加载（import-engine.js）");
        const feed = await window.dsImport.fetchFeed(url, getSetting("cors_proxy", ""));
        if (feed.kind === "podcast") {
          const mid = nextMaterialId();
          S.materials.push({
            id: mid, title: feed.feed.title || "Podcast Feed",
            description: "Podcast RSS 导入（请选择一期节目）", media_type: "audio", language: "en",
            scene: "", difficulty: 0, duration_ms: 0, status: "draft", tags: "",
            source_type: "podcast", source_url: url, episodes: feed.feed.episodes,
            process_step: "", process_pct: 0, has_audio: false, created_at: nowStr(),
          });
          S.units[mid] = [];
          await save();
          return { ok: true, id: mid, material: materialJson(mid) };
        }
        // 音频直链
        const mid = nextMaterialId();
        const name = (decodeURIComponent((url.split("/").pop() || "").split("?")[0]) || "Remote Audio");
        S.materials.push({
          id: mid, title: name, description: "远程音频导入", media_type: "audio", language: "en",
          scene: "", difficulty: 0, duration_ms: 0, status: "processing", tags: "",
          source_type: "url", source_url: url, episodes: [], process_step: "download",
          process_pct: 5, has_audio: false, created_at: nowStr(),
        });
        S.units[mid] = [];
        await save();
        _processAudio(mid, url); // 后台下载+转写，前端轮询进度
        return { ok: true, id: mid, material: materialJson(mid) };
      }
      // 本地文件上传：需 blob，走 dsLocalEngine.importLocalFile（app.js 直接调用），此路由不处理
      throw new Error("本地文件导入请在素材页选择文件（网页/APK 已支持音频文件转写）");
    }
    m = p.match(/^\/materials\/(\d+)\/focus\/prepare$/);
    if (m && method === "POST") return { ok: true, message: "离线模式音频已内置" };
    m = p.match(/^\/materials\/(\d+)\/focus$/);
    if (m && method === "GET") {
      const mid = Number(m[1]);
      const f = focusProgress(mid);
      return { ok: true, focus: { ...f, audio_ready: true } };
    }
    if (m && method === "POST") {
      const mid = Number(m[1]);
      const r = focusAct(mid, b.action || "");
      if (!r.ok) throw new Error(r.err);
      await save();
      return { ok: true, focus: r.focus, status: r.focus.status };
    }
    m = p.match(/^\/materials\/(\d+)\/focus\/dictation-result$/);
    if (m && method === "POST") {
      const mid = Number(m[1]);
      const results = b.results || [];
      let totalC = 0, totalW = 0;
      for (const r of results) { totalC += r.correct || 0; totalW += r.total || 0; }
      const wer = totalW ? Math.round((1 - totalC / totalW) * 1000) / 1000 : 0;
      S.focus_dictations.push({
        id: S.focus_dictations.length + 1, material_id: mid,
        overall_wer: wer, correct_words: totalC, total_words: totalW,
        sentence_count: results.length, detail_json: JSON.stringify(results),
        created_at: nowStr(),
      });
      await save();
      return { ok: true, wer, correct: totalC, total: totalW };
    }
    m = p.match(/^\/materials\/(\d+)\/focus\/expressions$/);
    if (m && method === "POST") {
      const mid = Number(m[1]);
      let saved = 0;
      for (const it of (b.items || [])) {
        const expr = String(it.expression || "").trim();
        if (!expr) continue;
        if (S.words.some((w) => w.material_id === mid && w.expression.toLowerCase() === expr.toLowerCase())) continue;
        S.words.push({
          id: nextWordId(), material_id: mid, unit_id: it.unit_id || null,
          expression: expr, meaning: String(it.meaning || "").trim(),
          note: String(it.note || "").trim(), source: "user", created_at: nowStr(),
        });
        saved += 1;
      }
      await save();
      return { ok: true, saved };
    }
    m = p.match(/^\/materials\/(\d+)\/words$/);
    if (m && method === "GET") {
      const mid = Number(m[1]);
      const out = S.words.filter((w) => w.material_id === mid)
        .sort((a, b) => b.id - a.id)
        .map((w) => {
          const u = w.unit_id ? getUnit(w.unit_id) : null;
          return {
            id: w.id, expression: w.expression, meaning: w.meaning, note: w.note,
            source: w.source, unit_id: w.unit_id, created_at: w.created_at,
            unit_text: u ? u.text : null,
            audio: w.unit_id ? { url: unitAudioUrl(mid, w.unit_id), start_ms: 0, end_ms: 0, kind: "file" } : null,
          };
        });
      return { ok: true, words: out };
    }
    m = p.match(/^\/materials\/(\d+)\/progress$/);
    if (m && method === "GET") return { ok: true, ...materialProgress(Number(m[1])) };
    m = p.match(/^\/materials\/(\d+)\/tags$/);
    if (m && method === "POST") {
      const mid = Number(m[1]);
      const tags = String(b.tags || "").split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
      const mat = getMaterial(mid);
      if (mat) { mat.tags = tags.join(","); await save(); }
      return { ok: true, tags };
    }
    m = p.match(/^\/materials\/(\d+)\/podcast-episode$/);
    if (m && method === "POST") {
      const mid = Number(m[1]);
      const mat = getMaterial(mid);
      if (!mat) throw new Error("材料不存在");
      const url = String(b.url || "").trim();
      if (!url) throw new Error("请选择一集");
      if (mat.status === "processing") return { ok: true, message: "该集正在处理中" };
      // 用单集标题更新素材名，方便识别选了哪一集（对齐 pipeline.pick_podcast_episode）
      const ep = (mat.episodes || []).find((e) => e.url === url);
      if (ep && ep.title) { mat.title = ep.title; mat.description = `Podcast 单集 · ${ep.title}`; }
      mat.status = "processing"; mat.process_step = "download"; mat.process_pct = 5;
      await save();
      _processAudio(mid, url); // 后台下载+转写，前端轮询进度
      return { ok: true, message: "开始下载并转写该集" };
    }
    m = p.match(/^\/materials\/(\d+)$/);
    if (m && method === "GET") {
      const mat = materialJson(Number(m[1]));
      if (!mat) throw new Error("材料不存在");
      return { ok: true, material: mat };
    }
    if (m && method === "DELETE") {
      const mid = Number(m[1]);
      const idx = S.materials.findIndex((x) => x.id === mid);
      if (idx >= 0) S.materials.splice(idx, 1);
      delete S.units[mid];
      delete S.focus[mid];
      S.words = S.words.filter((w) => w.material_id !== mid);
      if (_audioUrls[mid]) { try { URL.revokeObjectURL(_audioUrls[mid]); } catch (e) {} delete _audioUrls[mid]; }
      try { await idbSet(AUDIO_KEY(mid), undefined); } catch (e) {}
      await save();
      return { ok: true };
    }
    // 重新处理（导入音频失败后重试）：优先用已存音频 blob，其次用 source_url 重新下载
    m = p.match(/^\/materials\/(\d+)\/reprocess$/);
    if (m && method === "POST") {
      const mid = Number(m[1]);
      const mat = getMaterial(mid);
      if (!mat) throw new Error("材料不存在");
      S.units[mid] = [];
      mat.status = "processing"; mat.process_step = "preparing"; mat.process_pct = 5; mat.error = "";
      await save();
      const blob = await idbGet(AUDIO_KEY(mid));
      if (blob) _transcribeAndBuild(mid, blob);
      else if (mat.source_url) _processAudio(mid, mat.source_url);
      else { _markError(mid, new Error("该素材没有可重试的音频来源")); throw new Error("该素材没有可重试的音频来源"); }
      return { ok: true, message: "已重新提交，正在转写" };
    }
    // ---- 单元 ----
    m = p.match(/^\/units\/(\d+)$/);
    if (m && method === "GET") {
      const u = unitJson(Number(m[1]));
      if (!u) throw new Error("单元不存在");
      return { ok: true, unit: u };
    }
    m = p.match(/^\/units\/(\d+)\/session$/);
    if (m && method === "POST") {
      const sid = nextSessionId();
      await save();
      return { ok: true, session_id: sid };
    }
    m = p.match(/^\/units\/(\d+)\/listening$/);
    if (m && method === "POST") {
      const uid = Number(m[1]);
      unitAfterSession(uid, "blind_listening", "pass", "DICTATION");
      await save();
      return { ok: true, status: "DICTATION", unit: unitJson(uid) };
    }
    m = p.match(/^\/units\/(\d+)\/dictation$/);
    if (m && method === "POST") {
      const uid = Number(m[1]);
      const result = unitDictation(uid, b.input || "", { session_id: b.session_id || 0, assess_only: !!b.assess_only });
      await save();
      return { ok: true, ...result };
    }
    m = p.match(/^\/units\/(\d+)\/reveal$/);
    if (m && method === "POST") {
      const uid = Number(m[1]);
      const st = unitStatus(uid);
      if (st && ["DICTATION", "SHADOWING", "ACTIVE_RECALL", "LISTENING"].includes(st)) {
        unitTransition(uid, "REVEALED");
      }
      await save();
      return { ok: true, status: "REVEALED", unit: unitJson(uid) };
    }
    m = p.match(/^\/units\/(\d+)\/ack$/);
    if (m && method === "POST") {
      const uid = Number(m[1]);
      if (unitStatus(uid) === "REVEALED") unitTransition(uid, "UNDERSTOOD");
      await save();
      return { ok: true, status: "UNDERSTOOD", unit: unitJson(uid) };
    }
    m = p.match(/^\/units\/(\d+)\/advance$/);
    if (m && method === "POST") {
      const uid = Number(m[1]);
      const r = unitTransition(uid, b.to || "");
      if (!r.ok) throw new Error(r.err);
      await save();
      return { ok: true, status: r.status, unit: unitJson(uid) };
    }
    m = p.match(/^\/units\/(\d+)\/speaking$/);
    if (m && method === "POST") {
      const r = unitSpeaking(Number(m[1]), "shadowing", b.text || "");
      await save();
      return { ok: true, ...r };
    }
    m = p.match(/^\/units\/(\d+)\/recall$/);
    if (m && method === "POST") {
      const r = unitSpeaking(Number(m[1]), "active_recall", b.text || "");
      await save();
      return { ok: true, ...r };
    }
    m = p.match(/^\/units\/(\d+)\/(enhance|recall-hint|alternatives)$/);
    if (m && method === "POST") {
      if (m[2] === "recall-hint") {
        // 主动回忆的中文回译提示（对齐 server.py + ai_mod.llm_translate_sentence）
        const u = getUnit(Number(m[1]));
        if (!u) throw new Error("单元不存在");
        const out = await llmChat([
          { role: "system", content: "You are an English learning assistant for a Chinese learner. Answer in simplified Chinese. Return ONLY valid JSON matching the requested schema." },
          { role: "user", content: JSON.stringify({
            task: "Translate this English sentence into natural, everyday Chinese. The learner will translate it back into English as a recall exercise.",
            sentence: u.text,
            output_schema: { translation_zh: "中文翻译（口语化，忠实原意，不出现任何英文单词）" },
            rule: "Do not include the original English sentence or any English words in translation_zh.",
          }) },
        ]);
        const data = parseLLMJson(out) || {};
        const zh = String(data.translation_zh || "").trim();
        if (!zh) throw new Error("AI 未返回翻译，请重试");
        return { ok: true, translation_zh: zh };
      }
      throw new Error("该 AI 增强功能仅在桌面版可用（网页版可用「🤖 通俗解释」与 AI 分析）");
    }
    m = p.match(/^\/units\/(\d+)$/);
    if (m && method === "PUT") {
      const uid = Number(m[1]);
      const u = getUnit(uid);
      if (u && "flagged" in b) u.is_flagged = b.flagged ? 1 : 0;
      await save();
      return { ok: true, unit: unitJson(uid) };
    }
    // ---- 复习 ----
    if (p === "/review/due" && method === "GET") {
      const due = dueUnits().map((u) => ({
        id: u.id, text: u.text, material_id: u.material_id, seq: u.seq,
        scene: u.scene, status: u.status, mastery: u.mastery,
      }));
      return { ok: true, due };
    }
    m = p.match(/^\/review\/(\d+)\/complete$/);
    if (m && method === "POST") {
      const skills = b.skills || {};
      if (!Object.keys(skills).length) throw new Error("缺少 skills（每项技能的结果）");
      const r = applyUnitReview(Number(m[1]), skills);
      await save();
      return { ok: true, ...r };
    }
    // ---- focus 复习 ----
    if (p === "/focus/due" && method === "GET") return { ok: true, due: focusDue() };
    m = p.match(/^\/focus\/(\d+)\/review$/);
    if (m && method === "POST") {
      const r = focusApplyReview(Number(m[1]), !!b.passed);
      if (!r.ok) throw new Error(r.err);
      await save();
      return { ok: true, focus: r.focus, status: r.focus.status };
    }
    // ---- 生词 ----
    m = p.match(/^\/words\/(\d+)$/);
    if (m && method === "DELETE") {
      S.words = S.words.filter((w) => w.id !== Number(m[1]));
      await save();
      return { ok: true };
    }
    if (m && method === "PATCH") {
      const w = S.words.find((x) => x.id === Number(m[1]));
      if (w) {
        if ("meaning" in b) w.meaning = String(b.meaning);
        if ("note" in b) w.note = String(b.note);
        await save();
      }
      return { ok: true };
    }
    // ---- 词库 ----
    if (p.startsWith("/wordbank") && method === "GET") {
      await loadWordbank();
      const q = b.q !== undefined ? b.q : (new URLSearchParams(path.split("?")[1] || "")).get("q") || "";
      const hit = wordbankLookup(q);
      if (hit) return { ok: true, found: true, word: hit[0], pos: hit[1][0], meaning: hit[1][1] };
      return { ok: true, found: false, word: q, pos: "", meaning: "" };
    }
    // ---- 打卡 / 统计 ----
    if (p === "/checkin" && method === "POST") {
      const t = todayStr();
      if (!S.checkins.includes(t)) S.checkins.push(t);
      let streak = 0;
      const d = new Date();
      while (S.checkins.includes(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)) {
        streak += 1;
        d.setDate(d.getDate() - 1);
      }
      await save();
      return { ok: true, checked: true, streak };
    }
    if (p === "/stats" && method === "GET") {
      return { ok: true, ...computeStats() };
    }
    // ---- AI Provider（本地：配置仅存本机浏览器；LLM 请求直接发往你填的地址） ----
    if (p === "/ai/providers" && method === "GET") {
      const provs = (S.providers || []).map((x) => ({
        id: x.id, name: x.name, provider_type: x.provider_type,
        base_url: x.base_url, model: x.model, enabled: x.enabled,
        has_key: !!x.api_key, available: providerOk(x),
      }));
      return { ok: true, providers: provs, presets: {}, platforms: LOCAL_PLATFORMS };
    }
    if (p === "/ai/providers" && method === "POST") {
      const name = String(b.name || "").trim();
      if (!name) throw new Error("请填写名称");
      const id = nextProviderId();
      (S.providers = S.providers || []).push({
        id, name, provider_type: b.provider_type || "openai_compatible",
        base_url: String(b.base_url || "").trim(), model: String(b.model || "").trim(),
        api_key: String(b.api_key || "").trim(), enabled: b.enabled ? 1 : 0,
        created_at: nowStr(),
      });
      await save();
      return { ok: true, id };
    }
    m = p.match(/^\/ai\/providers\/(\d+)$/);
    if (m && method === "PUT") {
      const pr = (S.providers || []).find((x) => x.id === Number(m[1]));
      if (pr) {
        for (const k of ["name", "provider_type", "base_url", "model"]) {
          if (k in b) pr[k] = String(b[k] || "").trim();
        }
        if ("enabled" in b) pr.enabled = b.enabled ? 1 : 0;
        if (b.api_key) pr.api_key = String(b.api_key).trim();
        await save();
      }
      return { ok: true };
    }
    if (m && method === "DELETE") {
      S.providers = (S.providers || []).filter((x) => x.id !== Number(m[1]));
      await save();
      return { ok: true };
    }
    if (p === "/ai/test" && method === "POST") {
      const pr = (S.providers || []).find((x) => x.id === Number(b.provider_id || 0));
      if (!pr) throw new Error("Provider 不存在");
      const reply = await llmChatWith(pr, [
        { role: "system", content: "Reply with exactly: pong" },
        { role: "user", content: "ping" },
      ], { max_tokens: 10, json_mode: false });
      return { ok: true, reply: String(reply || "").trim().slice(0, 50) || "pong" };
    }
    if (p === "/ai/privacy" && method === "GET") {
      return { ok: true, consent: getSetting("ai_consent", "ask"), scope: getSetting("ai_scope", "sentence"), granted: "" };
    }
    if (p === "/ai/consent" && method === "POST") {
      if (["allow", "ask", "never"].includes(b.action)) setSetting("ai_consent", b.action);
      await save();
      return { ok: true };
    }
    // ---- 学习画像 & AI 分析（对齐 server.py） ----
    if (p === "/learner/profile" && method === "GET") {
      return { ok: true, ...localLearnerProfile() };
    }
    if (p === "/ai/analysis" && method === "POST") {
      const prof = localLearnerProfile();
      const custom = String(b.prompt || "").trim();
      const request = custom || "请根据我的学习画像，指出 3 个最需要改进的地方，并给出具体可执行的建议（中文，300 字以内）。";
      const out = await llmChat([
        { role: "system", content: "你是一位懂英语学习法的 AI 教练，用简体中文、简洁务实地回复，不要用术语。" },
        { role: "user", content: "【我的学习画像】\n" + prof.summary + "\n\n【要求】\n" + request },
      ], { json_mode: false, temperature: 0.5 });
      if (!String(out || "").trim()) throw new Error("AI 未返回内容，请重试");
      return { ok: true, reply: String(out).trim() };
    }
    if (p.startsWith("/speech/")) throw new Error("语音识别仅在桌面版可用（可安装本地 faster-whisper）");
    if (p === "/tts/voices") {
      return { ok: true, voices: window.dsTts ? window.dsTts.listVoices() : [] };
    }
    // 文本单元播放：按句 Kokoro 合成（voice/rate 缺省时用设置，对齐桌面 tts.py 默认）
    if (p === "/tts" && method === "GET") {
      if (!window.dsTts) throw new Error("TTS 引擎未加载（tts-engine.js）");
      const text = String(b.text || "").trim();
      if (!text) throw new Error("text 为空");
      const voice = b.voice || getSetting("tts_voice_a", "af_heart");
      const rate = Number(b.rate) || Number(getSetting("tts_rate", "175")) || 175;
      const r = await window.dsTts.synthesize(text, voice, rate);
      if (!r) throw new Error("合成失败");
      return { ok: true, url: r.url, duration_ms: r.duration_ms };
    }
    if (p === "/scenes") return { ok: true, scenes: [] };

    throw new Error(`接口不存在: ${path}`);
  }

  // 一致性测试钩子（Node 环境 + DS_TEST=1 时暴露内部函数，浏览器无影响）
  if (typeof process !== "undefined" && process.env && process.env.DS_TEST) {
    globalThis.__DS_INTERNALS = {
      normalize, tokens, contentTokens, wer, cer, tokenDiff, judgeDictation,
      fuzzyMatch, judgeSpeaking, judgeRecall, isMinor, sceneLabel,
    };
  }

  // 按句合成（文本材料单元播放 / 设置页试听）：voice/rate 缺省时用设置
  async function ttsSynthesize(text, voice, rate, onProgress) {
    if (!window.dsTts) throw new Error("TTS 引擎未加载（tts-engine.js）");
    const v = voice || getSetting("tts_voice_a", "af_heart");
    const r = Number(rate) || Number(getSetting("tts_rate", "175")) || 175;
    return window.dsTts.synthesize(text, v, r, onProgress);
  }

  return { api, ready: loadState, fullAudioUrl, importLocalFile, ttsSynthesize };
})();

// 浏览器全局挂载（const 不会自动成为 window 属性）
if (typeof window !== "undefined") window.DeepSpeakEngine = DeepSpeakEngine;
