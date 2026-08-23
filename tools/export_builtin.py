#!/usr/bin/env python3
"""导出内置材料为前端静态数据（PWA 无后端模式用）。

输出：
- frontend/engine-data.js  内置材料/单元/表达/初始状态（JSON 常量）
- frontend/assets/data/wordbank.json  离线释义词表
- frontend/assets/audio/*.wav  内置单元音频 + 整段音频

用法：python3 tools/export_builtin.py
"""
import argparse
import json
import os
import shutil
import sqlite3
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
DB = os.path.join(BASE, "data", "app.db")
OUT_DIR = os.path.join(BASE, "frontend")
AUDIO_SRC = os.path.join(BASE, "materials", "tts")
AUDIO_DST = os.path.join(BASE, "frontend", "assets", "audio")
DATA_DST = os.path.join(BASE, "frontend", "assets", "data")


def main():
    ap = argparse.ArgumentParser(description="导出内置材料为前端静态数据（PWA 无后端模式用）")
    ap.add_argument("--force", action="store_true",
                    help="覆盖已存在的音频文件（旧引擎产物需重新合成时用）")
    args = ap.parse_args()
    if not os.path.exists(DB):
        print("DB 不存在，请先运行服务器生成内置数据:", DB)
        return 1
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    mats = []
    for r in conn.execute("SELECT * FROM materials WHERE is_builtin=1 ORDER BY id"):
        mats.append({
            "id": r["id"], "title": r["title"], "description": r["description"],
            "media_type": r["media_type"], "language": r["language"],
            "scene": r["scene"], "difficulty": r["difficulty"],
            "duration_ms": r["duration_ms"], "status": r["status"],
            "tags": r["tags"] or "",
            "source_type": "builtin",
        })

    units = {}
    exprs = {}
    for m in mats:
        mid = m["id"]
        units[mid] = [
            {
                "id": u["id"], "seq": u["seq"], "text": u["text"], "speaker": u["speaker"],
                "start_ms": u["start_ms"], "end_ms": u["end_ms"], "scene": u["scene"],
                "difficulty": u["difficulty"], "learning_value": u["learning_value"],
                "status": "NEW",
            }
            for u in conn.execute(
                "SELECT * FROM training_units WHERE material_id=? ORDER BY seq", (mid,))
        ]
        exprs[mid] = {}
        for e in conn.execute(
                "SELECT * FROM expressions WHERE unit_id IN "
                "(SELECT id FROM training_units WHERE material_id=?)", (mid,)):
            exprs[mid].setdefault(e["unit_id"], []).append({
                "expression": e["expression"], "meaning": e["meaning"],
                "intent": e["intent"], "scene": e["scene"],
                "variants": json.loads(e["variants_json"] or "[]"),
            })

    data = {
        "materials": mats,
        "units": units,
        "expressions": exprs,
        "focus": {m["id"]: {
            "status": "new", "listen_count": 0, "dict_done": 0, "shadow_done": 0,
            "offscript_done": 0, "stage": 0, "next_review_at": None, "reviews_done": 0,
        } for m in mats},
    }
    js_path = os.path.join(OUT_DIR, "engine-data.js")
    with open(js_path, "w") as f:
        f.write("/* 内置材料静态数据（由 tools/export_builtin.py 生成，勿手改） */\n")
        f.write("const BUILTIN_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(f"✅ engine-data.js ({os.path.getsize(js_path)//1024}KB, {len(mats)} 材料, "
          f"{sum(len(v) for v in units.values())} 单元, {sum(len(v) for v in exprs.values())} 表达)")

    # 词表
    os.makedirs(DATA_DST, exist_ok=True)
    src_wb = os.path.join(BASE, "backend", "data", "wordbank.json")
    if os.path.exists(src_wb):
        shutil.copy(src_wb, os.path.join(DATA_DST, "wordbank.json"))
        print("✅ wordbank.json 已复制")

    # 音频：内置单元 + 整段。
    # 目标文件名是前端静态引用的固定格式（builtin_{key}_{uid}.wav / full_{mid}.wav），
    # 源文件统一走后端生成逻辑（builtin.unit_audio_path / focus.material_full_audio_path），
    # 确保与运行时一致：按设置音色用 kokoro 合成、缓存 key 含音色指纹。
    from backend import builtin, focus
    os.makedirs(AUDIO_DST, exist_ok=True)
    copied = skipped = 0

    def _copy(p, dst):
        nonlocal copied, skipped
        if not p or not os.path.exists(p) or os.path.getsize(p) < 100:
            skipped += 1
            return
        shutil.copy(p, dst)
        copied += 1

    for m in mats:
        src = conn.execute(
            "SELECT metadata_json FROM material_sources WHERE material_id=? ORDER BY id LIMIT 1",
            (m["id"],)).fetchone()
        key = json.loads(src["metadata_json"]).get("key") if src and src["metadata_json"] else None
        if not key:
            continue
        for u in conn.execute(
                "SELECT id FROM training_units WHERE material_id=? ORDER BY seq", (m["id"],)):
            dst = os.path.join(AUDIO_DST, f"builtin_{key}_{u['id']}.wav")
            if os.path.exists(dst) and os.path.getsize(dst) > 100 and not args.force:
                copied += 1
                continue
            _copy(builtin.unit_audio_path(u["id"]), dst)

    # 内置材料的整段音频（缺失时现场拼接）
    for m in mats:
        dst = os.path.join(AUDIO_DST, f"full_{m['id']}.wav")
        if os.path.exists(dst) and os.path.getsize(dst) > 100 and not args.force:
            copied += 1
            continue
        try:
            full_src = focus.material_full_audio_path(m["id"])
        except Exception as e:
            print(f"  ⚠️ 材料 {m['id']} 整段音频生成失败: {e}")
            full_src = None
        _copy(full_src, dst)
    print(f"✅ 音频: 复制 {copied} 个, 跳过 {skipped} 个 → {AUDIO_DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
