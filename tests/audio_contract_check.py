#!/usr/bin/env python3
"""双引擎音频契约回归测试：桌面(Python) 与 移动/网页(JS) 必须算出完全相同的逐句播放区间。

用法：
    python3 tests/audio_contract_check.py

失败说明哪一端漂移了。两端实现：
  - 桌面：backend/audio_contract.py  resolve_unit_range
  - JS：  frontend/audio-contract.js  resolveUnitRange
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend.audio_contract import resolve_unit_range  # noqa: E402

# (start_ms, end_ms, text, next_start_ms) —— 覆盖：合法区间/end 缺失/end<=start/
# 下一句可用/下一句不可用/词数兜底/长句/空文本
CASES = [
    (0, 0, "Hello world", 0),
    (1000, 0, "The quick brown fox jumps", 0),
    (1000, 0, "The quick brown fox jumps", 2000),
    (8000, 5000, "a b c", 0),
    (0, 4000, "abc def", 0),
    (3000, 9000, "hi there", 0),
    (5000, 0, "one two three four five six", 9000),
    (2500, 0, "just words", 2500),
    (2500, 2500, "just words", 0),
    (0, 0, "", 0),
    (1200, 0, "word", 999),
    (1200, 0, "word", 1201),
    (0, 0, "a" * 50, 0),
]

PY_EXPECTED = [list(resolve_unit_range(*c)) for c in CASES]

JS_SCRIPT = """
const c = require("./frontend/audio-contract.js");
const cases = %s;
const out = cases.map(([s, e, t, n]) => {
  const r = c.resolveUnitRange(s, e, t, n);
  return [r.start_ms, r.end_ms];
});
console.log(JSON.stringify(out));
""" % json.dumps(CASES)

def main():
    try:
        res = subprocess.run(
            ["node", "-e", JS_SCRIPT],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError:
        print("FAIL: node 不在 PATH，跳过 JS 侧对比", file=sys.stderr)
        return 1
    if res.returncode != 0:
        print("FAIL: JS 侧执行出错\n" + res.stderr, file=sys.stderr)
        return 1
    js_actual = json.loads(res.stdout.strip())

    bad = 0
    for i, (case, py, js) in enumerate(zip(CASES, PY_EXPECTED, js_actual)):
        if list(py) != list(js):
            bad += 1
            print(f"  ✗ case {i}: {case}  python={py}  js={js}")
    total = len(CASES)
    if bad:
        print(f"FAIL: {bad}/{total} 用例两端不一致（后端 server.py 与 mobile engine.js 会分叉）")
        return 1
    print(f"OK: {total} 个用例 Python/JS 两端完全一致（audio_contract.py ↔ audio-contract.js）")
    return 0

if __name__ == "__main__":
    sys.exit(main())