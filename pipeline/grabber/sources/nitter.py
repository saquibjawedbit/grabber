"""Watched X accounts via Nitter RSS. Public instances come and go — we try each
in order and shrug when they're all down (the CSE source still covers X search)."""
import re

import feedparser
import requests

from ..models import Posting
from .google_cse import load_searches

TAG_RE = re.compile(r"<[^>]+>")


def fetch() -> list[Posting]:
    cfg = load_searches().get("x_watch", {}) or {}
    instances = cfg.get("instances", []) or []
    accounts = cfg.get("accounts", []) or []
    if not instances or not accounts:
        return []

    postings = []
    live = list(instances)
    for account in accounts:
        for instance in list(live):
            try:
                r = requests.get(
                    f"https://{instance}/{account}/rss",
                    headers={"User-Agent": "Mozilla/5.0"}, timeout=15,
                )
                if r.status_code != 200 or b"<rss" not in r.content[:500]:
                    raise ValueError(f"http {r.status_code}")
                parsed = feedparser.parse(r.content)
                if not parsed.entries:
                    raise ValueError("empty feed")
            except Exception as e:
                print(f"nitter: {instance} failed for @{account} ({e})")
                if instance != live[-1]:
                    continue
                break
            for entry in parsed.entries[:20]:
                text = TAG_RE.sub(" ", entry.get("summary", "") or entry.get("title", "")).strip()
                if len(text) < 40:
                    continue
                link = entry.get("link", "")
                postings.append(Posting(
                    source=f"x:@{account}",
                    external_id=entry.get("id") or link,
                    title=text[:200],
                    url=link.replace(f"https://{instance}", "https://x.com"),
                    body=text[:2000],
                    posted_at=entry.get("published", ""),
                ))
            break  # this account done, next one
    return postings
