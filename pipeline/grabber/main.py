"""Heavy compute, run by GitHub Actions. Everything interactive lives in the Worker.

  python -m grabber.main email             # poll Gmail over IMAP -> D1 (every 20 min)
  python -m grabber.main research <id>     # deep research job, dispatched by the agent

The Worker (chat, The System's quests, senses, money) is I/O-bound and always on.
Only two things need a real machine: polling Gmail over IMAP (a Worker can't speak it),
and research agents that browse for minutes (time). The old nightly IDF/calibration job
went away with the opportunity engine.
"""
import sys

from .db import D1


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    db = D1()
    if cmd == "email":
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
        raise SystemExit(f"unknown command: {cmd!r} (use: email | research <job_id>)")


if __name__ == "__main__":
    main()
