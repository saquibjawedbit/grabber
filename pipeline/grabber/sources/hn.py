"""Hacker News via the free Algolia API: fellowship/grant stories + latest Who Is Hiring comments."""
import requests

from ..models import Posting

SEARCH = "https://hn.algolia.com/api/v1/search_by_date"
ITEM = "https://hn.algolia.com/api/v1/items/{}"
STORY_QUERIES = ["fellowship", "grant program", "residency program", "hackathon"]


def fetch() -> list[Posting]:
    postings = []

    for q in STORY_QUERIES:
        r = requests.get(SEARCH, params={"query": q, "tags": "story", "hitsPerPage": 20}, timeout=30)
        r.raise_for_status()
        for hit in r.json().get("hits", []):
            if not hit.get("title"):
                continue
            postings.append(Posting(
                source="hn",
                external_id=str(hit["objectID"]),
                title=hit["title"],
                url=hit.get("url") or f"https://news.ycombinator.com/item?id={hit['objectID']}",
                body=hit.get("story_text") or "",
                posted_at=hit.get("created_at") or "",
            ))

    # Latest "Ask HN: Who is hiring?" thread — each top-level comment is a posting.
    r = requests.get(SEARCH, params={"tags": "story,author_whoishiring", "hitsPerPage": 5}, timeout=30)
    r.raise_for_status()
    hiring = [h for h in r.json().get("hits", []) if "who is hiring" in (h.get("title") or "").lower()]
    if hiring:
        thread_id = hiring[0]["objectID"]
        r = requests.get(ITEM.format(thread_id), timeout=30)
        r.raise_for_status()
        for c in (r.json().get("children") or [])[:300]:
            text = c.get("text") or ""
            if not text or len(text) < 80:
                continue
            first_line = text.split("<p>")[0][:120]
            postings.append(Posting(
                source="hn",
                external_id=str(c["id"]),
                title=f"Who is hiring: {first_line}",
                url=f"https://news.ycombinator.com/item?id={c['id']}",
                body=text[:4000],
                posted_at=c.get("created_at") or "",
            ))
    return postings
