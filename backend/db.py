"""SQLite 数据层：连接管理、schema、种子数据。

设计原则：Local-first，所有数据默认保存在本地 SQLite。
API Key 不写入本库（见 ai.py，使用系统 Keychain）。
"""
import json
import os
import sqlite3
import threading

from . import paths

DATA_DIR = paths.data_dir()
DB_PATH = os.path.join(DATA_DIR, "app.db")

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT 'Local User',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  media_type TEXT DEFAULT 'audio',
  language TEXT DEFAULT 'en',
  scene TEXT DEFAULT '',
  difficulty REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',          -- draft | processing | ready | error
  is_builtin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS material_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,            -- builtin | local_file | url | youtube | podcast | web_article | clipboard | manual_text
  url TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  metadata_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  format TEXT DEFAULT 'plain',          -- plain | srt | vtt | asr_segments
  source TEXT DEFAULT 'manual',         -- subtitle | asr | manual | builtin
  content TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT DEFAULT '',
  start_ms INTEGER DEFAULT 0,
  end_ms INTEGER DEFAULT 0,
  scene TEXT DEFAULT '',
  difficulty REAL DEFAULT 0,
  learning_value REAL DEFAULT 0,
  expressions_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'NEW',
  is_flagged INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_units_material ON training_units(material_id);
CREATE INDEX IF NOT EXISTS idx_units_status ON training_units(status);

CREATE TABLE IF NOT EXISTS expressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES training_units(id) ON DELETE CASCADE,
  expression TEXT NOT NULL,
  meaning TEXT DEFAULT '',
  intent TEXT DEFAULT '',
  scene TEXT DEFAULT '',
  variants_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'rule'
);

CREATE TABLE IF NOT EXISTS expression_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expression_id INTEGER NOT NULL REFERENCES expressions(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  label TEXT DEFAULT '',
  emoji TEXT DEFAULT '',
  keywords_json TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS learning_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES training_units(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  result_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  user_input TEXT,
  reference TEXT,
  wer REAL,
  cer REAL,
  passed INTEGER DEFAULT 0,
  detail_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS speaking_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- shadowing | active_recall
  audio_path TEXT DEFAULT '',
  asr_text TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  match_score REAL DEFAULT 0,
  evaluation_json TEXT DEFAULT '{}',
  passed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mastery_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER UNIQUE NOT NULL REFERENCES training_units(id) ON DELETE CASCADE,
  listening REAL DEFAULT 0,
  dictation REAL DEFAULT 0,
  recall REAL DEFAULT 0,
  speaking REAL DEFAULT 0,
  overall REAL DEFAULT 0,
  interval_days REAL DEFAULT 1,
  stage INTEGER DEFAULT 0,
  next_review_at TEXT,
  reviews_done INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS review_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES training_units(id) ON DELETE CASCADE,
  review_type TEXT DEFAULT 'review',
  result TEXT DEFAULT '',
  interval_days REAL,
  reviewed_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_review_unit ON review_history(unit_id);

-- 整段精听进度（尚雯婕法：以整段材料为单位）
CREATE TABLE IF NOT EXISTS material_focus (
  material_id INTEGER PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'new',            -- new | listening | dictation | shadowing | offscript | review_due | mastered
  listen_count INTEGER DEFAULT 0,       -- 通听次数（自评驱动）
  dict_done INTEGER DEFAULT 0,          -- 逐句听写 + 红笔校对完成
  shadow_done INTEGER DEFAULT 0,        -- 跟读模仿完成
  offscript_done INTEGER DEFAULT 0,     -- 脱稿复述完成
  stage INTEGER DEFAULT 0,              -- 段落复习间隔档位
  next_review_at TEXT,                  -- 下次段落复习时间
  reviews_done INTEGER DEFAULT 0,       -- 已完成的间隔复习次数
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS focus_review_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  result TEXT DEFAULT '',
  interval_days REAL,
  reviewed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,          -- openai | anthropic | gemini | openai_compatible | ollama
  base_url TEXT DEFAULT '',
  model TEXT DEFAULT '',
  api_key_ref TEXT DEFAULT '',
  enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  unit_id INTEGER REFERENCES training_units(id) ON DELETE SET NULL,
  expression TEXT NOT NULL,
  meaning TEXT DEFAULT '',
  note TEXT DEFAULT '',
  source TEXT DEFAULT 'user',          -- user | rule | curated
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_words_dedup ON words(material_id, lower(expression));

CREATE TABLE IF NOT EXISTS focus_dictations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  overall_wer REAL DEFAULT 0,
  correct_words INTEGER DEFAULT 0,
  total_words INTEGER DEFAULT 0,
  sentence_count INTEGER DEFAULT 0,
  detail_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkins (
  date TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);
"""

DEFAULT_SETTINGS = {
    "asr_model": "base.en",        # faster-whisper 模型名
    "tts_voice_a": "Samantha",     # 内置材料 角色 A
    "tts_voice_b": "Daniel",       # 内置材料 角色 B
    "tts_rate": "175",             # say 语速 wpm
    "dictation_pass_wer": "0.12",  # 听写通过阈值
    "speaking_pass_score": "60",   # 口语匹配通过阈值
    "recall_pass_score": "60",     # 主动回忆通过阈值（无 LLM）
    "ai_consent": "ask",           # ask | allow | never —— 是否允许把句子发给用户配置的 AI
    "ai_scope": "sentence",        # sentence | paragraph | material
}

DEFAULT_SCENES = [
    ("restaurant", "餐厅", "🍽️", ["restaurant", "order", "table", "menu", "waiter", "waitress", "bill", "check", "tip", "to go", "takeout", "menu", "appetizer", "dessert", "drink", "chef", "reservation", "fries", "burger", "change"]),
    ("doctor", "看医生", "🩺", ["doctor", "appointment", "symptom", "pain", "fever", "sore", "cough", "headache", "stomach", "hurt", "swallow", "prescription", "clinic", "nurse", "patient", "throat", "chill", "flu", "sick"]),
    ("pharmacy", "药店", "💊", ["pharmacy", "drug", "pill", "medicine", "pharmacist", "dosage", "tablet", "cough syrup", "bandage"]),
    ("shopping", "购物", "🛍️", ["price", "size", "fitting", "refund", "return", "receipt", "exchange", "discount", "sale", "cost", "cashier", "barcode", "browse", "fitting room"]),
    ("groceries", "买菜", "🥬", ["grocery", "supermarket", "produce", "vegetable", "fruit", "checkout", "bag", "aisle", "fresh", "weigh", "scales"]),
    ("small_talk", "闲聊", "💬", ["nice to meet", "how are you", "weekend", "weather", "hobby", "by the way", "anyway", "so", "tell me about", "what do you do"]),
    ("phone", "打电话", "📞", ["call", "phone", "hold on", "hang up", "ring", "message", "leave a message", "reach", "extension", "dial"]),
    ("directions", "问路", "🧭", ["turn left", "turn right", "straight", "block", "corner", "cross", "map", "direction", "station", "exit", "intersection", "landmark"]),
    ("cooking", "做饭", "🍳", ["cook", "pan", "stove", "ingredient", "recipe", "bake", "boil", "fry", "chop", "salt", "oven", "simmer"]),
    ("haircut", "理发", "💇", ["haircut", "barber", "hair", "trim", "style", "fade", "shave", "scissors", "bangs", "layers"]),
    ("hotel", "酒店", "🏨", ["hotel", "check in", "check out", "room", "reservation", "lobby", "key card", "wifi", "breakfast", "housekeeping", "late checkout"]),
    ("travel", "旅行", "✈️", ["flight", "airport", "boarding", "passport", "luggage", "gate", "ticket", "customs", "visa", "delay", "terminal"]),
    ("office", "工作", "💼", ["meeting", "report", "deadline", "email", "project", "manager", "schedule", "presentation", "client", "colleague"]),
    ("home", "居家", "🏠", ["rent", "landlord", "utility", "repair", "plumber", "neighbor", "leak", "electrician", "fix", "broken"]),
    ("weather", "天气", "🌤️", ["weather", "rain", "sunny", "cloudy", "forecast", "temperature", "snow", "windy", "umbrella"]),
    ("other", "其他", "📌", []),
]


def connect():
    """每个请求/线程一个连接。"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = connect()
    conn.executescript(SCHEMA)
    _migrate(conn)
    # 种子：场景
    cur = conn.execute("SELECT COUNT(*) AS c FROM scenes")
    if cur.fetchone()["c"] == 0:
        for name, label, emoji, kws in DEFAULT_SCENES:
            conn.execute(
                "INSERT INTO scenes(name,label,emoji,keywords_json) VALUES(?,?,?,?)",
                (name, label, emoji, json.dumps(kws, ensure_ascii=False)),
            )
    # 种子：设置
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)", (k, v))
    # 种子：本地用户
    cur = conn.execute("SELECT COUNT(*) AS c FROM users")
    if cur.fetchone()["c"] == 0:
        conn.execute("INSERT INTO users(id,name) VALUES(1,'Local User')")
    conn.commit()


def _migrate(conn):
    """小版本迁移：加列等（CREATE TABLE IF NOT EXISTS 已覆盖新表）。"""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(materials)").fetchall()]
    if "tags" not in cols:
        conn.execute("ALTER TABLE materials ADD COLUMN tags TEXT DEFAULT ''")
    if "process_step" not in cols:
        conn.execute("ALTER TABLE materials ADD COLUMN process_step TEXT DEFAULT ''")
    if "process_pct" not in cols:
        conn.execute("ALTER TABLE materials ADD COLUMN process_pct INTEGER DEFAULT 0")
        conn.commit()


def get_setting(key, default=None):
    conn = connect()
    row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    return row["value"]


def set_setting(key, value):
    conn = connect()
    conn.execute(
        "INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )
    conn.commit()


def query(sql, args=()):
    return connect().execute(sql, args).fetchall()


def query_one(sql, args=()):
    return connect().execute(sql, args).fetchone()


def execute(sql, args=()):
    conn = connect()
    try:
        cur = conn.execute(sql, args)
        conn.commit()
        return cur.lastrowid
    except Exception:
        conn.rollback()  # 失败语句不留悬挂写事务，否则后续写会报 database is locked
        raise


def row_to_dict(row):
    return dict(row) if row is not None else None


def rows_to_dicts(rows):
    return [dict(r) for r in rows]
