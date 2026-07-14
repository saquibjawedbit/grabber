"""Pluggable source registry. Each source module exposes fetch() -> list[Posting].

Every source is best-effort: unofficial endpoints break, relay channels go quiet.
main.py wraps each in try/except — one dead source never kills a run.
"""
from . import devfolio, hn, rss, telegram_relay, unstop

SOURCES = {
    "devfolio": devfolio.fetch,
    "unstop": unstop.fetch,
    "hn": hn.fetch,
    "rss": rss.fetch,
    "telegram_relay": telegram_relay.fetch,
}
