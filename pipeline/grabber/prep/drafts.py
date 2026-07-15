"""Point 1: the alert arrives with the work already done.
Essay drafted from past applications, resume re-cut, form checklist."""
from datetime import datetime, timezone

from ..db import D1
from ..rank import llm

PROMPT = """Prepare application material for this opportunity, in this person's own voice.
Reuse phrasing and proof points from their past essays where they fit — do not invent
achievements that aren't in the material below.

## Opportunity
{title} — {org}
{url}
{body}

## Winning angle (already decided)
{angle}

## Their resume
{resume}

## Their past application essays
{essays}

## What they've told their agent (respect these preferences and constraints)
{memories}

Produce markdown with exactly these sections:
# Essay draft
(300-500 words, tailored to this opportunity, their voice, ready to edit not to write)
# Resume re-cut
(ordered bullet list: which existing resume items to lead with and how to rephrase each for THIS posting)
# Form checklist
(what this application will likely ask for: links, references, transcripts — so nothing surprises them mid-form)"""


def generate(db: D1, alert_id: int, posting: dict, angle: str) -> None:
    resume = db.one("SELECT content FROM profile WHERE key = 'resume'")
    essays = db.query("SELECT key, content FROM profile WHERE key LIKE 'essay:%'")
    essays_text = "\n\n".join(f"[{e['key']}]\n{e['content'][:2000]}" for e in essays) or "(none yet)"
    mems = db.query("SELECT fact FROM memories ORDER BY id LIMIT 40")
    memories_text = "\n".join(f"- {m['fact']}" for m in mems) or "(none yet)"

    md = llm.complete(PROMPT.format(
        title=posting["title"],
        org=posting.get("org") or "",
        url=posting.get("url") or "",
        body=(posting.get("body") or "")[:5000],
        angle=angle,
        resume=(resume["content"][:4000] if resume else "(no resume seeded)"),
        essays=essays_text,
        memories=memories_text,
    ))
    db.query(
        "INSERT OR REPLACE INTO drafts (alert_id, content_md, created_at) VALUES (?,?,?)",
        (alert_id, md, datetime.now(timezone.utc).isoformat()),
    )
