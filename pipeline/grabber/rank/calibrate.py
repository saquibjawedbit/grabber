"""Point 4: every alert is a prediction, every tap is a label. After enough labels,
measured hit rates dominate the LLM's guess. Guess for a month, then know."""
from datetime import datetime, timezone

from ..db import D1

BLEND_PSEUDO_N = 10  # weight on measured rate = n / (n + 10)
MIN_N_FOR_RATE = 5


def recompute(db: D1) -> None:
    rows = db.query(
        """SELECT a.category,
                  SUM(o.action = 'applied')  AS n_applied,
                  SUM(o.action = 'won')      AS n_won,
                  SUM(o.action = 'rejected') AS n_rejected
           FROM alerts a JOIN outcomes o ON o.alert_id = a.id
           GROUP BY a.category"""
    )
    ts = datetime.now(timezone.utc).isoformat()
    for r in rows:
        if not r["category"]:
            continue
        decided = (r["n_won"] or 0) + (r["n_rejected"] or 0)
        rate = (r["n_won"] / decided) if decided >= MIN_N_FOR_RATE else None
        db.query(
            """INSERT OR REPLACE INTO calibration
               (category, n_applied, n_won, n_rejected, rate, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (r["category"], r["n_applied"] or 0, r["n_won"] or 0, r["n_rejected"] or 0, rate, ts),
        )
    print(f"calibrate: updated {len(rows)} categories")


def blend(db: D1, category: str, llm_prior: float) -> float:
    row = db.one("SELECT * FROM calibration WHERE category = ?", (category,))
    if not row or row["rate"] is None:
        return llm_prior
    n = (row["n_won"] or 0) + (row["n_rejected"] or 0)
    w = n / (n + BLEND_PSEUDO_N)
    return round(w * row["rate"] + (1 - w) * llm_prior, 3)


def rates_text(db: D1) -> str:
    rows = db.query("SELECT * FROM calibration WHERE rate IS NOT NULL")
    if not rows:
        return "(no measured data yet — rely on your prior)"
    return "\n".join(
        f"- {r['category']}: {r['rate']:.0%} win rate over {(r['n_won'] or 0) + (r['n_rejected'] or 0)} decided applications"
        for r in rows
    )
