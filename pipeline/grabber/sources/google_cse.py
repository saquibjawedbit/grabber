"""X + LinkedIn posts via Google Programmable Search — the zero-cost, zero-ban-risk path.

Google indexes x.com and linkedin.com/posts; we search its index instead of scraping
either platform. Free tier: 100 queries/day (we use ~24). Skipped when keys unset.
Setup: programmablesearchengine.google.com (search the entire web) -> GOOGLE_CSE_ID,
Custom Search JSON API key -> GOOGLE_CSE_KEY.
"""
import pathlib

import requests
import yaml

from .. import config
from ..models import Posting

API = "https://www.googleapis.com/customsearch/v1"
SEARCHES_FILE = pathlib.Path(__file__).resolve().parents[2] / "searches.yaml"


def load_searches() -> dict:
    if not SEARCHES_FILE.exists():
        return {}
    return yaml.safe_load(SEARCHES_FILE.read_text()) or {}


def classify(link: str) -> str:
    if "x.com/" in link or "twitter.com/" in link:
        return "x:search"
    if "linkedin.com/" in link:
        return "linkedin:posts"
    return "web:search"


def fetch() -> list[Posting]:
    if not (config.GOOGLE_CSE_KEY and config.GOOGLE_CSE_ID):
        return []
    postings = []
    for search in load_searches().get("cse", []) or []:
        r = requests.get(API, params={
            "key": config.GOOGLE_CSE_KEY,
            "cx": config.GOOGLE_CSE_ID,
            "q": search["query"],
            "dateRestrict": f"d{search.get('days', 3)}",
            "num": 10,
        }, timeout=30)
        if r.status_code == 429:
            print("google_cse: daily quota exhausted, stopping")
            break
        r.raise_for_status()
        for item in r.json().get("items", []) or []:
            link = item.get("link", "")
            if not link or not item.get("title"):
                continue
            postings.append(Posting(
                source=classify(link),
                external_id=link,
                title=item["title"][:300],
                url=link,
                body=item.get("snippet", ""),
            ))
    return postings
