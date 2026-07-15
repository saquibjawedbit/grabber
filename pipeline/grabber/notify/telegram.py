"""Telegram delivery for jobs running on a real machine (research reports).
Watcher alerts are sent by the Worker — this is only for Actions-side jobs."""
import html

import requests

from .. import config

API = "https://api.telegram.org/bot{}/{}"


def esc(s) -> str:
    return html.escape(str(s or ""))


def send(text: str, buttons: list[list[dict]] | None = None) -> int | None:
    body = {
        "chat_id": config.TELEGRAM_CHAT_ID,
        "text": text[:4000],
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if buttons:
        body["reply_markup"] = {"inline_keyboard": buttons}
    r = requests.post(API.format(config.TELEGRAM_BOT_TOKEN, "sendMessage"), json=body, timeout=30)
    if not r.ok:
        # Model-authored text can break HTML parsing — retry as plain text.
        body.pop("parse_mode", None)
        r = requests.post(API.format(config.TELEGRAM_BOT_TOKEN, "sendMessage"), json=body, timeout=30)
    if not r.ok:
        print(f"telegram: send failed {r.status_code} {r.text[:200]}")
        return None
    return r.json().get("result", {}).get("message_id")
