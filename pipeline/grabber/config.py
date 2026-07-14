import os

# --- Cloudflare D1 ---
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
D1_DB_ID = os.environ.get("D1_DB_ID", "")

# --- Telegram ---
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# --- LLM (Gemini free tier primary, Groq free tier fallback) ---
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
LLM_CALL_GAP_S = float(os.environ.get("LLM_CALL_GAP_S", "5"))  # stay under free-tier RPM

# --- Telegram relay ingestion (optional, poor-man's Twitter) ---
TELETHON_API_ID = os.environ.get("TELETHON_API_ID", "")
TELETHON_API_HASH = os.environ.get("TELETHON_API_HASH", "")
TELETHON_SESSION = os.environ.get("TELETHON_SESSION", "")
TG_RELAY_CHANNELS = [c.strip() for c in os.environ.get("TG_RELAY_CHANNELS", "").split(",") if c.strip()]

# --- Dashboard (Cloudflare Worker URL) ---
DASH_URL = os.environ.get("DASH_URL", "").rstrip("/")

# --- Ranking knobs ---
RECALL_TOP_K = int(os.environ.get("RECALL_TOP_K", "50"))     # stage-1 survivors per run
MAX_ALERTS_PER_DAY = int(os.environ.get("MAX_ALERTS_PER_DAY", "2"))  # silence is the product
MIN_FIT_TO_ALERT = int(os.environ.get("MIN_FIT_TO_ALERT", "70"))

# Obscurity prior (point 2): popularity is a penalty. Multiplies recall score.
# Learned calibration eventually dominates; this is only the day-one prior.
SOURCE_WEIGHTS = {
    "tg": 1.5,        # relay channels — closest thing to "announced on someone's Twitter"
    "hn": 1.2,
    "rss": 1.0,       # per-feed override in feeds.yaml
    "devfolio": 0.9,
    "unstop": 0.9,
}


def require(*names: str) -> None:
    missing = [n for n in names if not globals().get(n)]
    if missing:
        raise SystemExit(f"Missing required env vars: {', '.join(missing)}")
