"""Stage 1 (point 5): cheap recall, not a decision. Cuts new postings to the
top-K survivors that the LLM will actually read."""
from .. import config
from ..db import D1
from . import idf as idf_mod


def source_weight(source: str, rss_weights: dict[str, float]) -> float:
    if source in rss_weights:                     # per-feed override from feeds.yaml
        return rss_weights[source]
    if source in config.SOURCE_WEIGHTS:           # exact match (e.g. "linkedin:jobs")
        return config.SOURCE_WEIGHTS[source]
    return config.SOURCE_WEIGHTS.get(source.split(":")[0], 1.0)


def run(db: D1, since_iso: str) -> list[dict]:
    rows = db.query(
        """SELECT p.* FROM postings p
           LEFT JOIN alerts a ON a.posting_id = p.id
           WHERE p.ingested_at > ? AND a.id IS NULL""",
        (since_iso,),
    )
    if not rows:
        return []

    skills = idf_mod.load_skills(db)
    phrase_idf = {
        r["term"][len("phrase:"):]: r["idf"]
        for r in db.query("SELECT term, idf FROM idf WHERE term LIKE 'phrase:%'")
    }

    from ..sources.rss import feed_weights
    rss_weights = feed_weights()

    scored = []
    for r in rows:
        text = f"{r['title']} {r.get('body') or ''}"
        edge, matched = idf_mod.edge_score(text, skills, phrase_idf)
        score = edge * source_weight(r["source"], rss_weights)
        if score > 0:
            scored.append({**r, "recall_score": score, "matched": matched})

    scored.sort(key=lambda x: -x["recall_score"])
    survivors = scored[: config.RECALL_TOP_K]
    print(f"recall: {len(rows)} new postings -> {len(survivors)} survivors")
    return survivors
