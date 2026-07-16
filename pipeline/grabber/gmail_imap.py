"""Gmail over IMAP with an App Password — no OAuth, no consent screen, no verification,
no 7-day token expiry. Runs in GitHub Actions because a Cloudflare Worker can't speak
IMAP. Writes matching mail to D1 as 'unclassified'; the Worker's cron then classifies
each one and surfaces only what's worth interrupting the owner for.

An app password grants full IMAP access, so this module is deliberately read-only: it
opens the mailbox readonly and never issues STORE, MOVE, EXPUNGE or DELETE. It cannot
mark your mail as read or change anything.
"""
import email
import imaplib
import re
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime

from . import config
from .db import D1

# Same intent as before: only mail that could change what the owner does today.
# No double-quotes in here — it's sent as an IMAP quoted string and inner quotes
# would break it. Gmail's own search operators work via the X-GM-RAW extension.
GMAIL_SEARCH = ("newer_than:2d -in:chats -category:promotions -category:social "
                "(recruiter OR hiring OR interview OR application OR opportunity OR "
                "internship OR fellowship OR grant OR shortlisted OR offer)")

THRID_RE = re.compile(rb"X-GM-THRID (\d+)")


def _dec(raw: str) -> str:
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return raw or ""


def _snippet(msg) -> str:
    chunks = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                chunks.append(part.get_payload(decode=True) or b"")
        if not chunks:  # HTML-only mail
            for part in msg.walk():
                if part.get_content_type() == "text/html":
                    chunks.append(part.get_payload(decode=True) or b"")
    else:
        chunks.append(msg.get_payload(decode=True) or b"")
    text = b" ".join(chunks).decode("utf-8", "ignore")
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def fetch(db: D1) -> None:
    if not config.GMAIL_ADDRESS or not config.GMAIL_APP_PASSWORD:
        print("gmail: GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set — skipping")
        return

    M = imaplib.IMAP4_SSL("imap.gmail.com")
    try:
        M.login(config.GMAIL_ADDRESS, config.GMAIL_APP_PASSWORD)
        M.select("INBOX", readonly=True)  # readonly: the mailbox cannot be altered
        typ, data = M.search(None, "X-GM-RAW", f'"{GMAIL_SEARCH}"')
        if typ != "OK":
            print(f"gmail: search returned {typ}")
            return
        ids = data[0].split()
        new = 0
        for num in ids[-25:]:  # newest matches only
            typ, msgdata = M.fetch(num, "(X-GM-THRID BODY.PEEK[])")
            if typ != "OK" or not msgdata or not isinstance(msgdata[0], tuple):
                continue
            meta, raw = msgdata[0][0] or b"", msgdata[0][1]
            msg = email.message_from_bytes(raw)
            msg_id = (msg.get("Message-ID") or "").strip("<> \t")
            if not msg_id:
                continue
            thr = THRID_RE.search(meta)
            thread_hex = format(int(thr.group(1)), "x") if thr else ""  # matches Gmail web-URL id
            try:
                received = parsedate_to_datetime(msg.get("Date")).astimezone().isoformat()
            except Exception:
                received = ""
            res = db.query(
                "INSERT OR IGNORE INTO emails (id, thread_id, sender, subject, snippet, received_at, kind) "
                "VALUES (?,?,?,?,?,?,'unclassified') RETURNING id",
                (msg_id[:200], thread_hex, _dec(msg.get("From"))[:200],
                 (_dec(msg.get("Subject")) or "(no subject)")[:250], _snippet(msg)[:500], received),
            )
            new += len(res)
        print(f"gmail: {len(ids)} matched search, {new} new -> D1")
    finally:
        try:
            M.logout()
        except Exception:
            pass
