// 分句/时间戳回归测试：跨窗口词流缝合 + 词级切句 + 无词级时间戳兜底。
// 运行：node tests/split_units_check.js
// 回归闸门：engine.js / import-engine.js 任何分句改动必须先过本测试（含桌面 textproc 语义对齐）。
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "..", "frontend", "import-engine.js"), "utf8");
const sb = { window: {}, navigator: {}, console, Blob: class {}, URL: class {}, setTimeout, clearTimeout };
vm.createContext(sb);
vm.runInContext(code, sb);
const d = sb.window.dsImport;

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log("  PASS " + msg); }
  else { fail++; console.log("  FAIL " + msg + "\n    got: " + a + "\n    exp: " + e); }
}
function ok(cond, msg) {
  if (cond) { pass++; console.log("  PASS " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

const W = (w, s, e) => ({ w, s, e });

// ---------- 场景 1：跨窗口残句缝合（用户反馈的核心：以逗号断句） ----------
{
  console.log("场景1 跨窗口残句合并（不按逗号断句）");
  // 窗口1 以半句结尾（挂着逗号），窗口2 继续说完
  const segs = [
    { text: "However, in the long run, it is worth it,", start: 0, end: 12,
      words: [W("However,", 0, 1.2), W("in", 1.2, 1.5), W("the", 1.5, 2.0), W("long", 2.0, 2.6), W("run,", 2.6, 3.4), W("it", 3.4, 3.6), W("is", 3.6, 3.8), W("worth", 3.8, 5.0), W("it,", 5.0, 6.0)] },
    { text: "because you get better every day.", start: 12, end: 24,
      words: [W("because", 12, 13.5), W("you", 13.5, 13.8), W("get", 13.8, 14.6), W("better", 14.6, 16.0), W("every", 16.0, 16.8), W("day.", 16.8, 18.0)] },
  ];
  const units = d.buildUnits(segs);
  eq(units.length, 1, "跨窗口衔接为 1 句（不再按逗号断成两句）");
  ok(units[0].text === "However, in the long run, it is worth it, because you get better every day."
     || units[0].text === "However, in the long run, it's worth it, because you get better every day.", "文本完整拼接: " + units[0].text);
  eq(units[0].start_ms, 0, "起始时间=首词起点");
  eq(units[0].end_ms, 18000, "结束时间=末词（句号）终点");
}

// ---------- 2：窗口刚好切在句中（无逗号）也合回一句 ----------
{
  const segs = [
    { text: "And this is the whole", start: 0, end: 10, words: [W("And", 0, 0.8), W("this", 0.8, 1.5), W("is", 1.5, 1.8), W("the", 1.8, 2.4), W("whole", 2.4, 3.2)] },
    { text: "point of the method.", start: 10, end: 20, words: [W("point", 10, 11.0), W("of", 11, 11.4), W("the", 11.4, 12.0), W("method.", 12.0, 13.6)] },
  ];
  const units = d.buildUnits(segs);
  eq(units.length, 1, "句中硬切拼回一句");
  eq(units[0].text, "And this is the whole point of the method.", "文本正确");
  eq(units[0].start_ms, 0, "起点 = 首词 0ms");
  eq(units[0].end_ms, 13600, "终点 = 句号词 13.6s");
}

// ---------- 3. 一块里多句 → 按 .!? 切 ----------
{
  const segs = [{
    text: "Hello. How are you? Ready!",
    start: 0, end: 9,
    words: [W("Hello.", 0, 1), W("How", 1, 1.6), W("are", 1.6, 2.0), W("you?", 2.0, 2.9), W("Ready!", 2.9, 3.8)],
  }];
  const units = d.buildUnits(segs);
  eq(units.map(u => u.text).join("|"), "Hello.|How are you?|Ready!", "三种句末标点各成一句");
  eq(units[0].end_ms, 1000, "第一句收在 句号词");
  eq(units.map(u => u.start_ms), [0, 1000, 2900], "每句起点=首词时间");
}

// ---------- 4. 缩写不误切 ----------
{
  const segs = [{
    text: "Dr. Smith said the U.S. is fine.",
    start: 0, end: 8,
    words: [W("Dr.", 0, 0.4), W("Smith", 0.4, 1.2), W("said", 1.2, 1.6), W("the", 1.6, 1.8), W("U.S.", 1.8, 2.6), W("is", 2.6, 2.8), W("fine.", 2.8, 3.6)],
  }];
  const units = d.buildUnits(segs);
  eq(units.length, 1, "Dr./U.S. 不切断");
  eq(units[0].text, "Dr. Smith said the U.S. is fine.", "文本保留缩写");
}

// ---------- 5. 句号单独成词 ----------
{
  const segs = [{
    text: "We went home . Next day is Monday",
    start: 0, end: 8,
    words: [W("We", 0, 0.5), W("went", 0.5, 1.2), W("home", 1.2, 1.8), W(".", 1.8, 1.9), W("Next", 1.9, 2.6), W("day", 2.6, 3.0), W("is", 3.0, 3.2), W("Monday", 3.2, 4.0)],
  }];
  const units = d.buildUnits(segs);
  eq(units.length, 2, "独立 . 标点也收句");
  eq(units[0].text, "We went home.", "标点归一");
  eq(units[0].end_ms, 1900, "收在独立句点 1.9s");
}

// ---------- 6. 兜底路径（无词级时间戳）：残句跨窗口合并 + 词数比例 ----------
{
  const segs = [
    { text: "One thing about this method", start: 0, end: 10 },
    { text: "is that it takes time.", start: 10, end: 20 },
  ];
  const units = d.buildUnits(segs);
  eq(units.length, 1, "兜底：跨窗口残句也合并为一句");
  eq(units[0].text, "One thing about this method is that it takes time.", "兜底文本");
  eq(units[0].start_ms, 0, "兜底起点");
  eq(units[0].end_ms, 20000, "兜底终点=合并块末");
}

// ---------- 7. 兜底多句按词数分配且不越界重叠 ----------
{
  const segs = [
    { text: "First sentence ends here. Second one,", start: 0, end: 8 },
    { text: "please jump now.", start: 8, end: 20 },
  ];
  const units = d.buildUnits(segs);
  eq(units.length, 2, "兜底：两句（含跨窗口第二句）");
  eq(units[0].text, "First sentence ends here.", "前句");
  eq(units[1].text, "Second one, please jump now.", "后句合并（逗号保留在句中）");
  ok(units[0].end_ms <= units[1].start_ms + 1, "时间不交叉");
  eq(units[1].end_ms, 20000, "第二句收到块末");
}

// ---------- 8. 首尾噪声词/引号清理 ----------
{
  const segs = [{
    text: "Well, that is great.",
    start: 0, end: 6,
    words: [W("Well,", 0, 1), W("that", 1, 1.8), W("is", 1.8, 2.0), W("great.", 2.0, 2.6)],
  }];
  const units = d.buildUnits(segs);
  eq(units[0].text, "that is great.", "起始噪声词去掉");
  eq(units[0].start_ms, 0, "时间区间仍覆盖整句（含噪声词）");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);