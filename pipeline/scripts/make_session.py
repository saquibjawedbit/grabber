"""One-time local login to produce TELETHON_SESSION for the telegram_relay source.

  export TELETHON_API_ID=... TELETHON_API_HASH=...   # from https://my.telegram.org
  python pipeline/scripts/make_session.py            # prompts for phone + code

Paste the printed string into the TELETHON_SESSION GitHub secret.
"""
import os

from telethon.sessions import StringSession
from telethon.sync import TelegramClient

with TelegramClient(
    StringSession(), int(os.environ["TELETHON_API_ID"]), os.environ["TELETHON_API_HASH"]
) as client:
    print("\nTELETHON_SESSION:\n")
    print(client.session.save())
