"""Opportunity-relay Telegram channels — the zero-cost stand-in for Twitter announcements.

Requires a Telethon *user* session (bots can't read arbitrary channels):
  TELETHON_API_ID / TELETHON_API_HASH from my.telegram.org,
  TELETHON_SESSION from pipeline/scripts/make_session.py (run once locally).
Silently skipped when unset.
"""
from .. import config
from ..models import Posting


def fetch() -> list[Posting]:
    if not (config.TELETHON_SESSION and config.TELETHON_API_ID and config.TG_RELAY_CHANNELS):
        return []
    from telethon.sessions import StringSession
    from telethon.sync import TelegramClient

    postings = []
    with TelegramClient(
        StringSession(config.TELETHON_SESSION),
        int(config.TELETHON_API_ID),
        config.TELETHON_API_HASH,
    ) as client:
        for channel in config.TG_RELAY_CHANNELS:
            for msg in client.iter_messages(channel, limit=30):
                if not msg.text or len(msg.text) < 60:
                    continue
                postings.append(Posting(
                    source=f"tg:{channel.lstrip('@')}",
                    external_id=str(msg.id),
                    title=msg.text.splitlines()[0][:200],
                    url=f"https://t.me/{channel.lstrip('@')}/{msg.id}",
                    body=msg.text[:4000],
                    posted_at=msg.date.isoformat() if msg.date else "",
                ))
    return postings
