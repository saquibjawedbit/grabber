"""Measured rarity (point 3). IDF over the ingested corpus — no hardcoded RARE dict.

Two granularities:
  - unigram IDF over the whole corpus (generic scoring, top-rare display)
  - phrase DF for each profile skill (skills are often multiword: "computer vision")
Self-calibrates: when everyone starts listing a term, its DF rises and its IDF —
and therefore its contribution to edge — collapses.
"""
import math
import re
from collections import Counter
from datetime import datetime, timezone

from ..db import D1

TOKEN_RE = re.compile(r"[a-z][a-z0-9+#.\-]{1,30}")
STOP = set("""a an and are as at be by for from has have if in into is it its of on or
that the this to was we will with you your our not can more all new who what""".split())


def tokenize(text: str) -> set[str]:
    return {t for t in TOKEN_RE.findall(text.lower()) if t not in STOP}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def recompute(db: D1) -> int:
    rows = db.query("SELECT title, body FROM postings")
    n = len(rows)
    if n < 20:
        print(f"idf: only {n} postings, skipping (need corpus first)")
        return 0

    df = Counter()
    docs = []
    for r in rows:
        toks = tokenize(f"{r['title']} {r.get('body') or ''}")
        docs.append(toks)
        df.update(toks)

    # Unigrams seen in >=2 docs (singletons are mostly noise/typos).
    ts = now()
    db.query("DELETE FROM idf")
    batch = [(t, d, math.log((n + 1) / (d + 1))) for t, d in df.items() if d >= 2]
    # D1 allows max 100 bound params per statement -> 20 rows x 4 params.
    for i in range(0, len(batch), 20):
        chunk = batch[i:i + 20]
        values = ",".join("(?,?,?,?)" for _ in chunk)
        params = []
        for t, d, v in chunk:
            params += [t, d, v, ts]
        db.query(f"INSERT OR REPLACE INTO idf (term, df, idf, updated_at) VALUES {values}", tuple(params))

    # Skill phrases: DF by substring across the corpus, stored under "phrase:" keys.
    skills = load_skills(db)
    corpus_texts = [f"{r['title']} {r.get('body') or ''}".lower() for r in rows]
    for phrase in skills:
        d = sum(1 for text in corpus_texts if phrase in text)
        v = math.log((n + 1) / (d + 1))
        db.query(
            "INSERT OR REPLACE INTO idf (term, df, idf, updated_at) VALUES (?,?,?,?)",
            (f"phrase:{phrase}", d, v, ts),
        )
    print(f"idf: recomputed over {n} postings, {len(batch)} unigrams, {len(skills)} skill phrases")
    return n


def load_skills(db: D1) -> dict[str, float]:
    """skills profile row: yaml mapping of phrase -> proficiency 0..1."""
    import yaml
    row = db.one("SELECT content FROM profile WHERE key = 'skills'")
    if not row:
        return {}
    data = yaml.safe_load(row["content"]) or {}
    return {str(k).lower(): float(v) for k, v in data.items()}
