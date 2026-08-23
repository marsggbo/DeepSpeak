"""内置学习材料：两个日常场景对话（餐厅外带 / 看医生）。

内置材料 = 精选句子 + 人工校对表达 + 用 macOS TTS 现场生成音频（离线，无需任何 API）。
用户首次打开 App 即可直接训练。
"""
import json
import os

from . import db, extract, paths, review, tts

BUILTIN = [
    {
        "key": "restaurant_takeout",
        "title": "At the Restaurant — 餐厅点餐与外带",
        "description": "在餐厅点餐、要打包带走、结账的完整对话。覆盖 Could I get... / Would you like... / to go 等高频表达。",
        "scene": "restaurant",
        "voice_a": "Samantha",  # 服务员
        "voice_b": "Daniel",    # 顾客
        "lines": [
            ("a", "Welcome to Riverside Cafe. What can I get for you today?"),
            ("b", "Could I get a cheeseburger and fries, please?"),
            ("a", "Sure thing. Would you like anything to drink with that?"),
            ("b", "I'd like a lemonade, please."),
            ("a", "Coming right up. Is that everything?"),
            ("b", "Actually, I was wondering if you could bring me some extra ketchup."),
            ("a", "No problem at all. I'll be right back with that."),
            ("b", "Thanks so much. Oh, and could I get this to go?"),
            ("a", "Of course. Would you like the burger wrapped separately?"),
            ("b", "That would be great. How much is that altogether?"),
            ("a", "That's twelve dollars and fifty cents."),
            ("b", "Here you go. Keep the change."),
        ],
    },
    {
        "key": "doctor_visit",
        "title": "At the Doctor's Office — 看医生",
        "description": "描述症状、回答医生提问、拿到建议的完整对话。覆盖 What brings you in / I've had... for... / Does it hurt 等高频表达。",
        "scene": "doctor",
        "voice_a": "Samantha",  # 医生
        "voice_b": "Daniel",    # 病人
        "lines": [
            ("a", "Good morning. What brings you in today?"),
            ("b", "I've had a sore throat for three days, and it hurts when I swallow."),
            ("a", "I see. Have you had a fever or any chills?"),
            ("b", "I had a slight fever last night, but it went down this morning."),
            ("a", "Let me take a look. Could you open your mouth and say ah?"),
            ("b", "Ahh. Does it look swollen?"),
            ("a", "A little bit. I'd recommend getting plenty of rest and drinking warm fluids."),
            ("b", "Do I need a prescription for anything?"),
            ("a", "Not at the moment. If it doesn't get better in a few days, come back and see me."),
            ("b", "Okay, thank you. How much will the visit cost?"),
            ("a", "That'll be forty dollars. You can pay at the front desk."),
            ("b", "Got it. I hope you have a good rest of your day."),
        ],
    },
    {
        "key": "news_bakery",
        "title": "Slow News — A Local Bakery Reopens",
        "description": "慢速新闻：一家本地面包店在关闭一年后重新开业。约 2.5 分钟，覆盖社区新闻常见表达。",
        "scene": "news",
        "voice_a": "Samantha",  # 播音员（整篇单声）
        "voice_b": "Samantha",
        "lines": [
            ("a", "Good morning, and welcome to today's local news."),
            ("a", "A beloved neighborhood bakery is reopening its doors after a year long closure."),
            ("a", "The owner, Maria Santos, says the bakery first opened in nineteen eighty five."),
            ("a", "It closed last year when the building needed major repairs."),
            ("a", "Neighbors raised more than thirty thousand dollars to help with the cost."),
            ("a", "Maria says she was deeply moved by the community's support."),
            ("a", "The reopening ceremony is scheduled for this Saturday at ten in the morning."),
            ("a", "The first fifty customers will receive a free loaf of fresh bread."),
            ("a", "Maria plans to keep the original recipes, including her grandmother's sourdough."),
            ("a", "She also hopes to hire two part time workers from the neighborhood."),
            ("a", "Local officials praised the effort as an example of community spirit."),
            ("a", "Residents say they are excited to have the bakery back."),
            ("a", "One regular customer told us the bakery has been part of her life for decades."),
            ("a", "She remembers coming here as a child with her grandfather."),
            ("a", "The city has promised to support other small businesses in similar situations."),
            ("a", "For now, Maria is focused on making sure everything is ready for Saturday."),
            ("a", "She says the best part is seeing familiar faces walk through the door again."),
            ("a", "That's all for today's news. Thanks for listening, and we'll see you tomorrow."),
        ],
    },
]

# 每句的人工校对表达（rule 引擎会兜底，这里人工精选保证质量）
CURATED = {
    "Welcome to Riverside Cafe. What can I get for you today?": [
        ("What can I get for you today?", "您今天需要点什么？（服务员开场）", "offer_service", ["What would you like today?", "Can I help you?"])
    ],
    "Could I get a cheeseburger and fries, please?": [
        ("Could I get ... ?", "我能要……吗？（委婉点单）", "request_service", ["Can I get ... ?", "Could I have ... ?"])
    ],
    "Would you like anything to drink with that?": [
        ("Would you like ... ?", "您想要……吗？（礼貌提供）", "offer", ["Do you want ... ?", "How about ... ?"])
    ],
    "I'd like a lemonade, please.": [
        ("I'd like ...", "我想要……（点单）", "want", ["I'll have ...", "Could I have ... ?"])
    ],
    "Coming right up. Is that everything?": [
        ("Coming right up.", "马上就好（服务用语）", "service_promise", ["Right away.", "I'll be right with you."]),
        ("Is that everything?", "就这些了吗？", "confirm_complete", ["Anything else?", "Is that all?"])
    ],
    "Actually, I was wondering if you could bring me some extra ketchup.": [
        ("I was wondering if you could ...", "我想请问您能不能……（非常委婉）", "polite_request", ["Would it be possible to ... ?", "Could you ... ?"])
    ],
    "No problem at all. I'll be right back with that.": [
        ("No problem at all.", "完全没问题", "reassure", ["No worries.", "Not a problem."]),
        ("I'll be right back with that.", "我马上拿给您", "service_promise", ["I'll be right with you.", "Coming right up."])
    ],
    "Thanks so much. Oh, and could I get this to go?": [
        ("Could I get this to go?", "这个能打包带走吗？", "takeaway", ["Can I take this away?", "Could you pack this up for me?", "For takeout, please."])
    ],
    "Of course. Would you like the burger wrapped separately?": [
        ("Would you like ... separately?", "要不要……单独分开？", "offer", ["Do you want ... separately?", "Should I wrap ... separately?"])
    ],
    "That would be great. How much is that altogether?": [
        ("That would be great.", "那太好了", "agree", ["That sounds great.", "That'd be perfect."]),
        ("How much is that altogether?", "一共多少钱？", "ask_price", ["What's the total?", "How much does it come to?"])
    ],
    "That's twelve dollars and fifty cents.": [
        ("That's ... dollars and ... cents.", "一共是……（报价格）", "state_price", ["That comes to ...", "That'll be ..."])
    ],
    "Here you go. Keep the change.": [
        ("Here you go.", "给您", "hand_over", ["Here you are.", "There you go."]),
        ("Keep the change.", "不用找零了", "keep_change", ["Keep it.", "That's fine, keep the change."])
    ],
    "Good morning. What brings you in today?": [
        ("What brings you in today?", "您今天哪里不舒服？（医生开场）", "ask_reason", ["What seems to be the problem?", "How can I help you?"])
    ],
    "I've had a sore throat for three days, and it hurts when I swallow.": [
        ("I've had ... for ...", "我……已经（持续）……了", "describe_duration", ["I've been ... for ...", "I've had ... since ..."]),
        ("It hurts when I swallow.", "我一吞咽就疼", "describe_pain", ["It's painful when I swallow.", "Swallowing hurts."])
    ],
    "I see. Have you had a fever or any chills?": [
        ("Have you had ... ?", "您有没有……（症状）？", "ask_symptom", ["Have you experienced ... ?", "Did you have ... ?"])
    ],
    "I had a slight fever last night, but it went down this morning.": [
        ("I had a slight fever last night.", "我昨晚有点发烧", "describe_symptom", ["I ran a slight fever last night.", "I had a mild fever yesterday."]),
        ("It went down this morning.", "今天早上退了", "describe_change", ["It's gone down this morning.", "It came down this morning."])
    ],
    "Let me take a look. Could you open your mouth and say ah?": [
        ("Let me take a look.", "让我看一下", "instruct", ["Let me check.", "Let me have a look."]),
        ("Could you open your mouth and say ah?", "能张开嘴说“啊”吗？", "polite_request", ["Open your mouth and say ah, please."])
    ],
    "Ahh. Does it look swollen?": [
        ("Does it look ... ?", "看起来……吗？", "ask_appearance", ["Does it seem ... ?", "Is it ... ?"])
    ],
    "A little bit. I'd recommend getting plenty of rest and drinking warm fluids.": [
        ("I'd recommend ...", "我建议您……", "recommend", ["I recommend ...", "I suggest ...", "You should ..."]),
        ("Get plenty of rest.", "多休息", "advice", ["Rest up.", "Make sure you get enough rest."])
    ],
    "Do I need a prescription for anything?": [
        ("Do I need ... ?", "我需要……吗？", "ask_need", ["Do I have to ... ?", "Is it necessary to ... ?"])
    ],
    "Not at the moment. If it doesn't get better in a few days, come back and see me.": [
        ("If it doesn't get better in a few days, ...", "如果几天内没有好转，就……", "conditional_advice", ["If it doesn't improve in a few days, ...", "If things don't change, ..."])
    ],
    "Okay, thank you. How much will the visit cost?": [
        ("How much will the visit cost?", "这次就诊多少钱？", "ask_price", ["How much is the visit?", "What will it cost?"])
    ],
    "That'll be forty dollars. You can pay at the front desk.": [
        ("That'll be ...", "一共是……", "state_price", ["That comes to ...", "That's ..."]),
        ("You can pay at the front desk.", "您可以在前台付款", "instruct", ["Payment is at the front desk."])
    ],
    "Got it. I hope you have a good rest of your day.": [
        ("Got it.", "明白了", "acknowledge", ["I got it.", "Understood."]),
        ("I hope you have a good rest of your day.", "祝您今天剩下的时间过得愉快", "well_wish", ["Have a good one.", "Take care."])
    ],
    "A beloved neighborhood bakery is reopening its doors after a year long closure.": [
        ("A beloved neighborhood ...", "备受喜爱的社区……（新闻开场）", "news_intro", ["A popular local ...", "A well-known ..."]),
        ("reopen its doors", "重新开张", "reopen", ["reopen for business", "open its doors again"])
    ],
    "Neighbors raised more than thirty thousand dollars to help with the cost.": [
        ("raise more than ... dollars", "筹集了超过……美元", "fundraise", ["collect ... dollars", "gather ... in donations"])
    ],
    "Maria says she was deeply moved by the community's support.": [
        ("be deeply moved by ...", "被……深深打动", "moved", ["be touched by ...", "be grateful for ..."])
    ],
    "The reopening ceremony is scheduled for this Saturday at ten in the morning.": [
        ("be scheduled for ...", "定于……（时间）举行", "schedule", ["be planned for ...", "take place on ..."])
    ],
    "The first fifty customers will receive a free loaf of fresh bread.": [
        ("The first ... customers will receive ...", "前……位顾客将获得……", "offer", ["The first ... to arrive get ...", "We'll give the first ..."])
    ],
    "One regular customer told us the bakery has been part of her life for decades.": [
        ("has been part of my life for ...", "已经是我生活的一部分……（年）", "lifelong", ["has been a part of my life since ...", "I've been coming here for ..."])
    ],
    "The city has promised to support other small businesses in similar situations.": [
        ("in a similar situation", "处于类似处境", "situation", ["in the same boat", "facing the same challenges"])
    ],
}

AUDIO_DIR = os.path.join(paths.materials_dir(), "builtin")


def _material_audio_dir(material_key):
    d = os.path.join(AUDIO_DIR, material_key)
    os.makedirs(d, exist_ok=True)
    return d


def seed_builtin_materials():
    """首次启动时把内置材料写入数据库（幂等）。"""
    conn = db.connect()
    for mat in BUILTIN:
        row = conn.execute(
            "SELECT id FROM materials WHERE title=? AND is_builtin=1", (mat["title"],)
        ).fetchone()
        if row:
            continue
        mid = db.execute(
            "INSERT INTO materials(title, description, scene, status, is_builtin, media_type) VALUES(?,?,?,?,1,'audio')",
            (mat["title"], mat["description"], mat["scene"], "ready"),
        )
        db.execute(
            "INSERT INTO material_sources(material_id, source_type, metadata_json) VALUES(?, 'builtin', ?)",
            (mid, json.dumps({"key": mat["key"]})),
        )
        # 写入 transcript
        full = "\n".join(f"{'A' if sp=='a' else 'B'}: {txt}" for sp, txt in mat["lines"])
        db.execute(
            "INSERT INTO transcripts(material_id, format, source, content) VALUES(?, 'plain', 'builtin', ?)",
            (mid, full),
        )
        # 生成训练单元
        for i, (speaker, text) in enumerate(mat["lines"], start=1):
            ana = extract.analyze_unit_text(text, mat["scene"])
            exprs = CURATED.get(text) or [
                (e["expression"], "", e["intent"], e["variants"]) for e in ana["expressions"]
            ]
            exprs_json = [
                {"expression": e[0], "meaning": e[1], "intent": e[2], "variants": e[3]}
                for e in exprs
            ]
            uid = db.execute(
                """INSERT INTO training_units(material_id, seq, text, speaker, scene, difficulty,
                   learning_value, expressions_json, status) VALUES(?,?,?,?,?,?,?,?,'NEW')""",
                (mid, i, text, speaker, ana["scene"], ana["difficulty"],
                 ana["learning_value"], json.dumps(exprs_json, ensure_ascii=False)),
            )
            from .pipeline import store_expressions
            store_expressions(uid, exprs_json, source="curated")
            review.ensure_mastery(uid)
    conn.commit()


def unit_audio_path(unit_id):
    """内置材料的单元音频：按需生成（kokoro 优先），带缓存。"""
    u = db.query_one("SELECT * FROM training_units WHERE id=?", (unit_id,))
    if not u:
        return None
    mat = db.query_one("SELECT * FROM materials WHERE id=?", (u["material_id"],))
    if not mat or not mat["is_builtin"]:
        return None
    src = db.query_one(
        "SELECT metadata_json FROM material_sources WHERE material_id=? AND source_type='builtin'",
        (u["material_id"],),
    )
    meta = json.loads(src["metadata_json"]) if src else {}
    key = meta.get("key", "")
    if not key:
        return None
    d = _material_audio_dir(key)
    path = os.path.join(d, f"u{unit_id:04d}.wav")
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path
    # 角色音色 A/B 分别取用户设置（默认 Samantha/Daniel，kokoro 引擎自动映射）
    voice = (db.get_setting("tts_voice_b", "") or "Daniel") if u["speaker"] == "b" \
        else (db.get_setting("tts_voice_a", "") or "Samantha")
    rate = int(db.get_setting("tts_rate", "175"))
    return tts.synthesize(u["text"], voice=voice, rate=rate, cache_key=f"builtin_{key}_{voice}_{rate}_{unit_id}")
