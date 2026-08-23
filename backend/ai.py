"""AI Provider 层：可选增强，不是核心依赖。

- 支持 OpenAI / Anthropic / Gemini / OpenAI Compatible（含 Ollama）/ 自定义 Base URL。
- API Key 用系统安全存储：macOS Keychain（security 命令）；其他平台回退到 0600 权限文件。
- 所有 LLM 调用前，前端必须按隐私设置确认（见 server.py 的 privacy 检查）。
- 调用统一走 chat()，返回文本；JSON 输出做防御性解析。
"""
import json
import os
import re
import subprocess
import urllib.error
import urllib.request

from . import db, paths

KEYFILE = os.path.join(paths.data_dir(), "keys.json")

PROVIDER_PRESETS = {
    "openai": {"base_url": "https://api.openai.com/v1", "models": ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"]},
    "anthropic": {"base_url": "https://api.anthropic.com", "models": ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]},
    "gemini": {"base_url": "https://generativelanguage.googleapis.com/v1beta", "models": ["gemini-2.0-flash", "gemini-2.5-flash"]},
    "ollama": {"base_url": "http://localhost:11434/v1", "models": ["llama3.1", "qwen2.5"]},
    "openai_compatible": {"base_url": "", "models": []},
}


# ---------- Key 安全存储 ----------

def _keychain_set(service, account, value):
    """macOS Keychain；失败时回退 keys.json (0600)。"""
    try:
        r = subprocess.run(
            ["security", "add-generic-password", "-U", "-a", account, "-s", service, "-w", value],
            capture_output=True, timeout=10,
        )
        if r.returncode == 0:
            return True
    except Exception:
        pass
    os.makedirs(os.path.dirname(KEYFILE), exist_ok=True)
    keys = {}
    if os.path.exists(KEYFILE):
        try:
            with open(KEYFILE) as f:
                keys = json.load(f)
        except Exception:
            keys = {}
    keys[f"{service}:{account}"] = value
    with open(KEYFILE, "w") as f:
        json.dump(keys, f)
    os.chmod(KEYFILE, 0o600)
    return True


def _keychain_get(service, account):
    try:
        r = subprocess.run(
            ["security", "find-generic-password", "-a", account, "-s", service, "-w"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    if os.path.exists(KEYFILE):
        try:
            with open(KEYFILE) as f:
                keys = json.load(f)
            return keys.get(f"{service}:{account}", "")
        except Exception:
            return ""
    return ""


def _keychain_delete(service, account):
    try:
        subprocess.run(
            ["security", "delete-generic-password", "-a", account, "-s", service],
            capture_output=True, timeout=10,
        )
    except Exception:
        pass
    if os.path.exists(KEYFILE):
        try:
            with open(KEYFILE) as f:
                keys = json.load(f)
            keys.pop(f"{service}:{account}", None)
            with open(KEYFILE, "w") as f:
                json.dump(keys, f)
        except Exception:
            pass


def store_api_key(provider_id, key):
    return _keychain_set("deepspeak", f"provider-{provider_id}", key)


def load_api_key(provider_id):
    return _keychain_get("deepspeak", f"provider-{provider_id}")


def delete_api_key(provider_id):
    _keychain_delete("deepspeak", f"provider-{provider_id}")


# ---------- 调用 ----------

def _parse_json(text):
    """从模型输出中防御性解析 JSON。"""
    if not text:
        return None
    t = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, re.S)
    if m:
        t = m.group(1)
    else:
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            t = m.group(0)
    try:
        return json.loads(t)
    except Exception:
        # 尝试修复：去掉尾逗号
        try:
            return json.loads(re.sub(r",\s*([}\]])", r"\1", t))
        except Exception:
            return None


def provider_ok(provider):
    """检查 provider 是否可用（ollama / openai_compatible 允许无 key）。"""
    if provider["provider_type"] == "ollama":
        return True
    if provider["provider_type"] == "openai_compatible" and not provider.get("base_url"):
        return False
    return bool(load_api_key(provider["id"]))


def chat(provider, messages, temperature=0.3, max_tokens=1500, json_mode=True, timeout=60):
    """调用 LLM chat。返回文本。"""
    ptype = provider["provider_type"]
    base = (provider.get("base_url") or "").rstrip("/")
    model = provider.get("model") or ""

    if ptype == "anthropic":
        url = base + "/v1/messages"
        headers = {
            "x-api-key": load_api_key(provider["id"]),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        body = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if json_mode:
            body["temperature"] = temperature
    elif ptype == "gemini":
        url = base + f"/models/{model}:generateContent?key=" + load_api_key(provider["id"])
        headers = {"content-type": "application/json"}
        body = {
            "contents": [
                {"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["content"]}]}
                for m in messages
            ],
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
    else:  # openai / openai_compatible / ollama
        url = base + "/chat/completions"
        headers = {"content-type": "application/json"}
        key = load_api_key(provider["id"])
        if key:
            headers["authorization"] = "Bearer " + key
        body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"AI Provider 返回 {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接 {base}: {e.reason}")

    if ptype == "anthropic":
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    if ptype == "gemini":
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            raise RuntimeError("Gemini 返回格式异常: " + json.dumps(data)[:300])
    return data["choices"][0]["message"]["content"]


def enabled_provider():
    rows = db.query("SELECT * FROM ai_providers WHERE enabled=1")
    for r in rows:
        p = dict(r)
        if provider_ok(p):
            return p
    return None


def get_provider(provider_id):
    row = db.query_one("SELECT * FROM ai_providers WHERE id=?", (provider_id,))
    return dict(row) if row else None


# ---------- LLM 增强功能 ----------

_SYS = (
    "You are an English learning assistant for an adult Chinese learner. "
    "The learner has decent work English but struggles with everyday spoken English "
    "(restaurants, shopping, doctor, small talk). Answer concisely. "
    "Return ONLY valid JSON matching the requested schema. Use simplified Chinese for any Chinese text."
)


def llm_enhance_unit(provider, unit):
    """LLM 增强：表达提取 + 场景 + 难度 + 解释。合并返回。"""
    text = unit["text"]
    prompt = {
        "task": "Analyze this English sentence from a daily-life dialogue.",
        "sentence": text,
        "output_schema": {
            "expressions": [{"expression": "high-value phrase from the sentence",
                             "meaning_zh": "中文含义", "intent_zh": "意图，如：委婉请求",
                             "variants": ["2-3 natural alternative ways to say it"]}],
            "scene": "one of: restaurant, doctor, pharmacy, shopping, groceries, small_talk, phone, directions, cooking, haircut, hotel, travel, office, home, weather, other",
            "difficulty": "1-10",
            "explanation_zh": "一句 60 字以内的中文讲解：这句话在什么场景用、有什么要注意的",
        },
        "rules": "Only extract expressions that are genuinely reusable in daily conversation. Max 3 expressions. difficulty: 1=very easy, 10=very hard.",
    }
    out = chat(provider, [
        {"role": "system", "content": _SYS},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ])
    data = _parse_json(out) or {}
    return data


def llm_evaluate_speaking(provider, kind, reference, user_text, scene_prompt=""):
    """LLM 语义评估（跟读/主动回忆）。"""
    prompt = {
        "task": "Evaluate an English learner's spoken answer.",
        "kind": kind,  # shadowing | recall
        "reference": reference,
        "user_answer": user_text,
        "scene_prompt": scene_prompt,
        "output_schema": {
            "meaning_ok": "bool: did the user convey the intended meaning?",
            "grammar_ok": "bool",
            "naturalness": "one of: native, natural, okay, awkward, unnatural",
            "feedback_zh": "一句简短中文反馈（30字内）",
            "alternative": "a more natural way to say it, if needed (empty string if fine)",
        },
        "rule": "For 'shadowing', user tries to repeat the reference; for 'recall', user expresses the scene prompt in their own words. Be encouraging but honest.",
    }
    out = chat(provider, [
        {"role": "system", "content": _SYS},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ])
    return _parse_json(out) or {}


def llm_translate_sentence(provider, sentence, scene_prompt=""):
    """把英文句子翻成中文，作为主动回忆的「回译」提示（不带任何英文）。"""
    prompt = {
        "task": "Translate this English sentence into natural, everyday Chinese. The learner will translate it back into English as a recall exercise.",
        "sentence": sentence,
        "scene_prompt": scene_prompt,
        "output_schema": {"translation_zh": "中文翻译（口语化，忠实原意，不出现任何英文单词）"},
        "rule": "Do not include the original English sentence or any English words in translation_zh.",
    }
    out = chat(provider, [
        {"role": "system", "content": _SYS},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ])
    data = _parse_json(out) or {}
    return (data.get("translation_zh") or "").strip()


def llm_alternatives(provider, expression):
    prompt = {
        "task": "Give alternative ways to say this English expression in daily life.",
        "expression": expression,
        "output_schema": {"alternatives": [{"text": "alternative", "note_zh": "区别，如：更正式/更口语"}]},
        "rule": "Max 4 alternatives, ordered by usefulness for everyday spoken English.",
    }
    out = chat(provider, [
        {"role": "system", "content": _SYS},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ])
    return _parse_json(out) or {}


def test_provider(provider):
    """连通性测试：让模型回一个词。"""
    out = chat(provider, [
        {"role": "system", "content": "Reply with exactly: pong"},
        {"role": "user", "content": "ping"},
    ], max_tokens=10, json_mode=False)
    return out.strip()[:50]
