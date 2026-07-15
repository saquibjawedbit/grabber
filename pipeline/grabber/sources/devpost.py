"""Devpost open/upcoming hackathons via its JSON API (the public .rss feed is dead)."""
from datetime import datetime

import requests

from ..models import Posting

API = "https://devpost.com/api/hackathons"


def to_iso(date_text: str) -> str:
    """'Aug 17, 2026' -> '2026-08-17'; anything unparseable -> ''."""
    try:
        return datetime.strptime(date_text.strip(), "%b %d, %Y").date().isoformat()
    except ValueError:
        return ""


def fetch() -> list[Posting]:
    r = requests.get(
        API,
        params={"status[]": ["upcoming", "open"], "per_page": 50},
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=30,
    )
    r.raise_for_status()
    postings = []
    for h in r.json().get("hackathons", []) or []:
        if not h.get("id") or not h.get("title"):
            continue
        themes = ", ".join(t.get("name", "") for t in h.get("themes", []) or [])
        prize = h.get("prize_amount", "")
        postings.append(Posting(
            source="devpost",
            external_id=str(h["id"]),
            title=h.get("title", ""),
            url=h.get("url", ""),
            body=f"{themes}. Prize: {prize}. {h.get('organization_name') or ''}",
            org=h.get("organization_name") or "",
            deadline=to_iso((h.get("submission_period_dates") or "").split("-")[-1]),
            posted_at=h.get("open_state") or "",
        ))
    return postings
