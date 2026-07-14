"""Stage 2 (point 5): the LLM actually reads each recall survivor and reasons about fit.
Its P(convert) prior is blended with measured hit rates (point 4) via calibrate.py."""
import json

from .. import config
from ..db import D1
from . import calibrate, llm

PROMPT = """You are ranking an opportunity for one specific person. Be brutally selective:
a false alert costs trust; silence is the product. Most postings should get alert=false.

## The person
{profile}

## Measured conversion rates so far (won / decided applications, by category)
{rates}

## The posting
Source: {source} (obscurity weight {weight} — obscure channels are worth MORE, points from big boards less)
Title: {title}
Org: {org}
Deadline: {deadline}
URL: {url}
Body:
{body}

## Your job
Return JSON:
{{
  "category": "hackathon|fellowship|grant|job|contract|other",
  "fit": 0-100,                  // how well this person's actual edge matches what wins here
  "p_convert": 0.0-1.0,          // your prior P(they win/get it IF they apply)
  "alert": true|false,           // only true if you'd interrupt them for this
  "deadline": "YYYY-MM-DD or null",  // extract from body if stated, else null
  "reasons": "one or two sentences, specific to their edge, no fluff",
  "angle": "one line: the strongest angle for their application"
}}"""


def rank(db: D1, posting: dict, profile_summary: str) -> dict | None:
    rates = calibrate.rates_text(db)
    prompt = PROMPT.format(
        profile=profile_summary,
        rates=rates,
        source=posting["source"],
        weight=posting.get("recall_score", 0) and f"{posting['recall_score']:.2f}" or "n/a",
        title=posting["title"],
        org=posting.get("org") or "unknown",
        deadline=posting.get("deadline") or "unknown",
        url=posting.get("url") or "",
        body=(posting.get("body") or "")[:6000],
    )
    try:
        out = llm.complete_json(prompt)
    except Exception as e:
        print(f"rank2: LLM failed on {posting['id']}: {e}")
        return None

    out["fit"] = int(out.get("fit") or 0)
    out["llm_prior"] = float(out.get("p_convert") or 0)
    out["p_convert"] = calibrate.blend(db, out.get("category") or "other", out["llm_prior"])

    if out.get("deadline") and not posting.get("deadline"):
        db.query("UPDATE postings SET deadline = ? WHERE id = ?", (out["deadline"], posting["id"]))
    return out


def profile_summary(db: D1) -> str:
    parts = []
    for key in ("bio", "skills", "resume"):
        row = db.one("SELECT content FROM profile WHERE key = ?", (key,))
        if row:
            parts.append(f"### {key}\n{row['content'][:3000]}")
    if not parts:
        raise SystemExit("Profile is empty — run pipeline/scripts/seed_profile.py first")
    return "\n\n".join(parts)
