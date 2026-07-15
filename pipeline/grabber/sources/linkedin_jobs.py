"""LinkedIn jobs via the public guest endpoint — real listings, no auth, no account risk.

NOTE: unofficial-but-tolerated endpoint used by many tools; returns HTML cards.
Occasional 429s are normal — we back off and take what we got.
"""
import time

import requests
from bs4 import BeautifulSoup

from ..models import Posting
from .google_cse import load_searches

API = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"


def fetch() -> list[Posting]:
    cfg = load_searches().get("linkedin_jobs", {}) or {}
    keywords = cfg.get("keywords", []) or []
    if not keywords:
        return []

    postings = []
    for kw in keywords:
        r = requests.get(API, params={
            "keywords": kw,
            "location": cfg.get("location", ""),
            "f_TPR": "r259200",  # past 3 days only — freshness over volume
            "start": 0,
        }, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
        if r.status_code == 429:
            print("linkedin_jobs: rate limited, stopping early")
            break
        r.raise_for_status()

        soup = BeautifulSoup(r.text, "html.parser")
        for card in soup.select("li"):
            a = card.select_one("a.base-card__full-link")
            title = card.select_one("h3")
            if not a or not title:
                continue
            url = a["href"].split("?")[0]
            company = card.select_one("h4")
            posted = card.select_one("time")
            postings.append(Posting(
                source="linkedin:jobs",
                external_id=url,
                title=title.get_text(strip=True)[:300],
                url=url,
                body=f"{kw} — {company.get_text(strip=True) if company else ''}",
                org=company.get_text(strip=True) if company else "",
                posted_at=posted.get("datetime", "") if posted else "",
            ))
        time.sleep(2)
    return postings
