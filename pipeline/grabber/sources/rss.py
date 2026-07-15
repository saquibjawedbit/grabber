"""Generic RSS ingestion. Feeds (and per-feed obscurity weights) live in pipeline/feeds.yaml."""
import pathlib
import re

import feedparser
import yaml

from ..models import Posting

FEEDS_FILE = pathlib.Path(__file__).resolve().parents[2] / "feeds.yaml"
TAG_RE = re.compile(r"<[^>]+>")


def load_feeds() -> list[dict]:
    if not FEEDS_FILE.exists():
        return []
    return yaml.safe_load(FEEDS_FILE.read_text()).get("feeds", []) or []


def slugify(name: str) -> str:
    return re.sub(r"\W+", "-", name.lower()).strip("-")


def feed_weights() -> dict[str, float]:
    """Map 'rss:<slug>' -> weight for recall scoring (feeds.yaml `weight`)."""
    return {
        f"rss:{slugify(f.get('name') or 'feed')}": float(f.get("weight", 1.0))
        for f in load_feeds()
    }


def fetch() -> list[Posting]:
    postings = []
    for feed in load_feeds():
        parsed = feedparser.parse(feed["url"])
        name = feed.get("name") or parsed.feed.get("title", "feed")
        slug = slugify(name)
        for e in parsed.entries[:40]:
            uid = e.get("id") or e.get("link") or e.get("title", "")
            if not uid:
                continue
            body = TAG_RE.sub(" ", e.get("summary", "") or "")[:4000]
            postings.append(Posting(
                source=f"rss:{slug}",
                external_id=uid,
                title=e.get("title", "")[:300],
                url=e.get("link", ""),
                body=body,
                org=name,
                posted_at=e.get("published", "") or e.get("updated", ""),
            ))
    return postings
