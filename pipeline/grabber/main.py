"""Orchestrator. Two entry points, both driven by GitHub Actions cron:

  python -m grabber.main run       # every few hours: ingest -> recall -> rank -> prep -> notify
  python -m grabber.main nightly   # once a day: IDF recompute + calibration update
"""
import sys
import traceback
from datetime import datetime, timedelta, timezone

from . import config
from .db import D1
from .models import Posting
from .notify import telegram
from .prep import drafts
from .rank import calibrate, idf, rank2, recall
from .sources import SOURCES


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ingest(db: D1) -> int:
    total_new = 0
    for name, fetch in SOURCES.items():
        try:
            postings = fetch()
        except Exception:
            print(f"ingest: source '{name}' failed (continuing):")
            traceback.print_exc()
            continue
        new = 0
        for p in postings:
            res = db.query(
                """INSERT OR IGNORE INTO postings
                   (id, source, external_id, url, title, body, org, deadline, posted_at, ingested_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id""",
                (p.id, p.source, p.external_id, p.url, p.title, p.body,
                 p.org, p.deadline, p.posted_at, now()),
            )
            new += len(res)
        print(f"ingest: {name}: {len(postings)} fetched, {new} new")
        total_new += new
    return total_new


def alerts_sent_today(db: D1) -> int:
    row = db.one(
        "SELECT COUNT(*) AS c FROM alerts WHERE sent_at > ?",
        ((datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),),
    )
    return row["c"] if row else 0


def run(db: D1) -> None:
    ingest(db)

    # First ever run: build the IDF corpus before ranking anything.
    if not db.one("SELECT term FROM idf LIMIT 1"):
        idf.recompute(db)

    since = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    survivors = recall.run(db, since)
    if not survivors:
        return

    profile = rank2.profile_summary(db)
    budget = max(0, config.MAX_ALERTS_PER_DAY - alerts_sent_today(db))
    print(f"run: alert budget remaining today: {budget}")

    for posting in survivors:
        verdict = rank2.rank(db, posting, profile)
        if verdict is None:
            continue

        # Log the prediction whether or not we alert — unalerted rows still
        # train recall thresholds later.
        row = db.one(
            """INSERT INTO alerts (posting_id, category, fit, p_convert, llm_prior, reasons, angle)
               VALUES (?,?,?,?,?,?,?) RETURNING id""",
            (posting["id"], verdict["category"], verdict["fit"], verdict["p_convert"],
             verdict["llm_prior"], verdict.get("reasons"), verdict.get("angle")),
        )
        alert_id = row["id"]

        should_alert = (
            verdict.get("alert")
            and verdict["fit"] >= config.MIN_FIT_TO_ALERT
            and budget > 0
        )
        if not should_alert:
            continue

        try:
            drafts.generate(db, alert_id, posting, verdict.get("angle") or "")
        except Exception:
            print("prep: draft generation failed (alert still goes out):")
            traceback.print_exc()

        msg_id = telegram.send_alert(alert_id, posting, verdict)
        if msg_id:
            db.query(
                "UPDATE alerts SET sent_at = ?, tg_message_id = ? WHERE id = ?",
                (now(), msg_id, alert_id),
            )
            budget -= 1
            print(f"run: alerted #{alert_id} {posting['title'][:60]!r}")


def nightly(db: D1) -> None:
    idf.recompute(db)
    calibrate.recompute(db)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    db = D1()
    if cmd == "run":
        config.require("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID")
        run(db)
    elif cmd == "nightly":
        nightly(db)
    elif cmd == "ingest":
        ingest(db)
    else:
        raise SystemExit(f"unknown command: {cmd} (use run | nightly | ingest)")


if __name__ == "__main__":
    main()
