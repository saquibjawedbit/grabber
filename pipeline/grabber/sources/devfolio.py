"""Devfolio hackathons with open applications.

NOTE: unofficial endpoint, reverse-engineered from the site. If it 4xx's, open
devtools on devfolio.co/hackathons and update URL/payload/parsing here.
"""
import requests

from ..models import Posting

API = "https://api.devfolio.co/api/search/hackathons"


def fetch() -> list[Posting]:
    r = requests.post(
        API,
        json={"type": "application_open", "from": 0, "size": 50},
        headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    hits = r.json().get("hits", {}).get("hits", [])
    postings = []
    for h in hits:
        s = h.get("_source", {})
        slug = s.get("slug") or s.get("uuid") or ""
        if not slug or not s.get("name"):
            continue
        postings.append(Posting(
            source="devfolio",
            external_id=slug,
            title=s.get("name", ""),
            url=f"https://{slug}.devfolio.co",
            body=s.get("desc") or s.get("tagline") or "",
            org=s.get("name", ""),
            deadline=(s.get("hackathon_setting", {}) or {}).get("reg_ends_at") or s.get("starts_at") or "",
            posted_at=s.get("created_at") or "",
        ))
    return postings
