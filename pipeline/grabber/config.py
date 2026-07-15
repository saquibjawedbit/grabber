import os

# --- Cloudflare D1 ---
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
D1_DB_ID = os.environ.get("D1_DB_ID", "")

# --- Telegram ---
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# --- LLM (Cloudflare Workers AI primary — free 10k neurons/day, reuses the D1
# token so no extra key; NVIDIA / Gemini / Groq as fallbacks) ---
CF_AI_MODEL = os.environ.get("CF_AI_MODEL", "@cf/openai/gpt-oss-120b")
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "")
NVIDIA_MODEL = os.environ.get("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
LLM_CALL_GAP_S = float(os.environ.get("LLM_CALL_GAP_S", "5"))  # stay under free-tier RPM

# --- Google Programmable Search (X + LinkedIn posts finding engine) ---
GOOGLE_CSE_KEY = os.environ.get("GOOGLE_CSE_KEY", "")
GOOGLE_CSE_ID = os.environ.get("GOOGLE_CSE_ID", "")

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
    "x": 1.5,          # a post on someone's X IS the obscure channel (point 2)
    "tg": 1.5,         # relay channels, same tier
    "linkedin": 1.2,   # linkedin:posts — announcements, not listings
    "hn": 1.2,
    "web": 1.0,        # CSE hits outside x/linkedin
    "rss": 1.0,        # per-feed override in feeds.yaml
    "devfolio": 0.9,
    "unstop": 0.9,
    "devpost": 0.7,    # very popular board — penalized harder

    "linkedin:jobs": 0.7,  # it's a job board — everyone saw it
}


def require(*names: str) -> None:
    missing = [n for n in names if not globals().get(n)]
    if missing:
        raise SystemExit(f"Missing required env vars: {', '.join(missing)}")
