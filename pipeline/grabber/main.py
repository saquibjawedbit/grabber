"""Heavy compute, run by GitHub Actions. Everything interactive lives in the Worker.

  python -m grabber.main nightly           # IDF recompute + calibration (~3am IST)
  python -m grabber.main research <id>     # deep research job, dispatched by the agent

The Worker handles watchers, ranking, drafts, alerts and chat — it's I/O-bound and
always on. Only two things need a real machine: recomputing IDF over the whole
corpus (CPU), and research agents that browse for minutes (time).
"""
import sys

from .db import D1
from .rank import calibrate, idf


def nightly(db: D1) -> None:
    idf.recompute(db)
    calibrate.recompute(db)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "nightly"
    db = D1()
    if cmd == "nightly":
        nightly(db)
    elif cmd == "email":
        from . import gmail_imap
        gmail_imap.fetch(db)
    elif cmd == "research":
        if len(sys.argv) < 3:
            raise SystemExit("usage: python -m grabber.main research <job_id>")
        from datetime import datetime, timezone

        from .research import runner
        job_id = int(sys.argv[2])
        try:
            runner.run(db, job_id)
        except Exception as e:
            # Never leave a job stuck in 'running' — the agent polls this state.
            db.query(
                "UPDATE research SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
                (f"{type(e).__name__}: {e}"[:300], datetime.now(timezone.utc).isoformat(), job_id),
            )
            raise
    else:
        raise SystemExit(f"unknown command: {cmd} (use nightly | research)")


if __name__ == "__main__":
    main()
