"""Telegram delivery for jobs running on a real machine (research reports).
Watcher alerts are sent by the Worker — this is only for Actions-side jobs."""
import html

import requests

from .. import config

API = "https://api.telegram.org/bot{}/{}"

# Telegram's own ceilings: 4096 chars per message, 1024 per media caption,
# 50MB per uploaded file. We stay just under each.
TEXT_LIMIT = 4000
CAPTION_LIMIT = 1000
UPLOAD_LIMIT = 50_000_000


def esc(s) -> str:
    return html.escape(str(s or ""))


def _post(method: str, body: dict, files: dict | None = None) -> int | None:
    """One send, with a plain-text retry. Model-authored text breaks HTML parsing
    often enough that every path needs the fallback, not just sendMessage."""
    url = API.format(config.TELEGRAM_BOT_TOKEN, method)
    # Multipart can't carry nested JSON — reply_markup has to be pre-encoded.
    def fire(b):
        if files:
            import json
            flat = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in b.items()}
            return requests.post(url, data=flat, files=files, timeout=120)
        return requests.post(url, json=b, timeout=30)

    r = fire(body)
    if not r.ok and body.get("parse_mode"):
        body = {k: v for k, v in body.items() if k != "parse_mode"}
        for f in (files or {}).values():
            # File handles were consumed by the first attempt.
            if hasattr(f[1], "seek"):
                f[1].seek(0)
        r = fire(body)
    if not r.ok:
        print(f"telegram: {method} failed {r.status_code} {r.text[:200]}")
        return None
    result = r.json().get("result")
    if isinstance(result, list):  # sendMediaGroup returns an array
        return result[0].get("message_id") if result else None
    return (result or {}).get("message_id")


def send(text: str, buttons: list[list[dict]] | None = None) -> int | None:
    body = {
        "chat_id": config.TELEGRAM_CHAT_ID,
        "text": text[:TEXT_LIMIT],
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if buttons:
        body["reply_markup"] = {"inline_keyboard": buttons}
    return _post("sendMessage", body)


def _media(method: str, field: str, media, caption: str | None,
           buttons: list[list[dict]] | None, filename: str | None) -> int | None:
    """Media is either bytes to upload, or a str — a URL or a Telegram file_id,
    both of which Telegram fetches itself, so they ride in the JSON body."""
    body = {"chat_id": config.TELEGRAM_CHAT_ID}
    if caption:
        body["caption"] = caption[:CAPTION_LIMIT]
        body["parse_mode"] = "HTML"
    if buttons:
        body["reply_markup"] = {"inline_keyboard": buttons}

    if isinstance(media, str):
        body[field] = media
        return _post(method, body, None)

    if len(media) > UPLOAD_LIMIT:
        print(f"telegram: {method} skipped — {len(media)} bytes over Telegram's 50MB limit")
        return None
    return _post(method, body, {field: (filename or field, media)})


def send_photo(photo, caption: str | None = None,
               buttons: list[list[dict]] | None = None) -> int | None:
    """photo: raw image bytes, an https URL, or a Telegram file_id."""
    return _media("sendPhoto", "photo", photo, caption, buttons, "image.png")


def send_document(document, caption: str | None = None, filename: str = "file.txt",
                  buttons: list[list[dict]] | None = None) -> int | None:
    """document: raw bytes, an https URL, or a Telegram file_id. Use this for
    anything that would blow past TEXT_LIMIT — a full report beats a truncated one."""
    if isinstance(document, str) and not document.startswith("http"):
        # A str that isn't a URL is ambiguous: file_id or the text itself. Text is
        # what callers actually have, so treat it as content and upload it.
        document = document.encode()
    return _media("sendDocument", "document", document, caption, buttons, filename)


def send_media_group(items: list[dict], caption: str | None = None) -> int | None:
    """items: [{"type": "photo"|"document", "media": bytes|url|file_id, "name": str}].
    Telegram albums cap at 10, and only the first item's caption is shown."""
    items = items[:10]
    media, files = [], {}
    for i, it in enumerate(items):
        entry = {"type": it.get("type", "photo")}
        if isinstance(it["media"], str):
            entry["media"] = it["media"]
        else:
            tag = f"f{i}"
            entry["media"] = f"attach://{tag}"
            files[tag] = (it.get("name") or tag, it["media"])
        if i == 0 and caption:
            entry["caption"] = caption[:CAPTION_LIMIT]
            entry["parse_mode"] = "HTML"
        media.append(entry)
    body = {"chat_id": config.TELEGRAM_CHAT_ID, "media": media}
    return _post("sendMediaGroup", body, files or None)
