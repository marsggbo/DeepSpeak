#!/usr/bin/env python3
"""预下载浏览器端 Whisper 模型到 models-js/（打包进 APK，离线可用，不再联网下载）。

模型 = Xenova/whisper-tiny.en + Xenova/whisper-base.en。
只取 transformers.js @2.17.2 实际加载的文件：
  - 全部小文件（config/tokenizer/vocab/merges/…）
  - onnx/ 下仅 *_quantized.onnx（量化版，前端默认 quantized=true 加载的就是它）

用法： python3 scripts/fetch_js_models.py            # 从 huggingface.co 下载
      python3 scripts/fetch_js_models.py --host hf-mirror.com   # 镜像源
      python3 scripts/fetch_js_models.py --check     # 只检查完整性（文件是否已齐）
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "models-js")
REPOS = [
    "Xenova/whisper-tiny.en",   # APK 默认识别模型（~40MB 量化）
    "Xenova/whisper-base.en",   # 设置里可切换的高精度档（~74MB 量化）
]
ONNX_KEEP = {
    "encoder_model_quantized.onnx",
    "decoder_model_quantized.onnx",
    "decoder_with_past_model_quantized.onnx",
    "decoder_model_merged_quantized.onnx",  # 文本生成（解码循环）实际加载的合并解码器
}


def api_url(repo, host):
    return f"https://{host}/api/models/{repo}/tree/main?recursive=true"


def file_url(repo, path, host):
    return f"https://{host}/{repo}/resolve/main/{urllib.parse.quote(path)}"


def list_tree(repo, host):
    req = urllib.request.Request(api_url(repo, host), headers={"User-Agent": "deepspeak-pack"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def wanted(path):
    if not path.startswith("onnx/"):
        return True  # 配置/词表小文件全要
    return os.path.basename(path) in ONNX_KEEP


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return False  # 已存在
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "deepspeak-pack"})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="huggingface.co")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    total_new, total_size = 0, 0
    missing = []
    for repo in REPOS:
        try:
            files = list_tree(repo, args.host)
        except Exception as e:
            print(f"[warn] {repo} 列表拉取失败（{args.host}）: {e}")
            continue
        for f in files:
            path = f["path"]
            if f.get("type") == "directory":
                continue
            if not wanted(path):
                continue
            dest = os.path.join(OUT, repo, path)
            if args.check:
                if not (os.path.exists(dest) and os.path.getsize(dest) == f.get("size", -1)):
                    missing.append((repo, path))
                continue
            try:
                ok = download(file_url(repo, path, args.host), dest)
            except Exception as e:
                print(f"[fail] {repo}/{path}: {e}")
                continue
            if ok:
                sz = f.get("size", 0)
                total_size += sz
                print(f"  + {path} ({sz / 1e6:.1f}MB)")
        print(f"[ok] {repo} 完成")

    if args.check:
        if missing:
            print(f"缺失 {len(missing)} 个文件：")
            for repo, path in missing:
                print("  ", repo, path)
            sys.exit(1)
        print("完整：所有模型文件已就位（offline 打包可用）")
        return
    print(f"下载完成：新增 {total_size / 1e6:.1f}MB → {OUT}")


if __name__ == "__main__":
    main()