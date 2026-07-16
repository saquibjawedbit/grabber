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

# --- Worker (dashboard + the search proxy research borrows, since CI IPs are blocked) ---
DASH_URL = os.environ.get("DASH_URL", "").rstrip("/")
DASH_TOKEN = os.environ.get("DASH_TOKEN", "")

# --- Research runner ---
RESEARCH_MAX_STEPS = int(os.environ.get("RESEARCH_MAX_STEPS", "22"))
RESEARCH_MAX_FETCH = int(os.environ.get("RESEARCH_MAX_FETCH", "18"))

# --- Gmail over IMAP (App Password — no OAuth, no verification, no 7-day expiry) ---
GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "")
# Google shows app passwords with spaces ("abcd efgh ijkl mnop"); IMAP wants them removed.
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")

# Google Programmable Search — optional; research falls back to DuckDuckGo without it.
GOOGLE_CSE_KEY = os.environ.get("GOOGLE_CSE_KEY", "")
GOOGLE_CSE_ID = os.environ.get("GOOGLE_CSE_ID", "")


def require(*names: str) -> None:
    missing = [n for n in names if not globals().get(n)]
    if missing:
        raise SystemExit(f"Missing required env vars: {', '.join(missing)}")
