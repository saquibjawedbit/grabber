"""Pluggable source registry. Each source module exposes fetch() -> list[Posting].

Every source is best-effort: unofficial endpoints break, relay channels go quiet,
nitter instances die. main.py wraps each in try/except — one dead source never
kills a run.
"""
from . import devfolio, devpost, google_cse, hn, linkedin_jobs, nitter, rss, telegram_relay, unstop

SOURCES = {
    "google_cse": google_cse.fetch,      # X + LinkedIn posts via Google's index
    "nitter": nitter.fetch,              # watched X accounts via RSS
    "linkedin_jobs": linkedin_jobs.fetch,
    "devfolio": devfolio.fetch,
    "devpost": devpost.fetch,
    "unstop": unstop.fetch,
    "hn": hn.fetch,
    "rss": rss.fetch,
    "telegram_relay": telegram_relay.fetch,
}
