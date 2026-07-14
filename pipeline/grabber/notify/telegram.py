"""Alert delivery. Inline buttons make every outcome a one-tap label —
the Worker webhook records the tap into the outcomes table."""
import html

import requests

from .. import config

API = "https://api.telegram.org/bot{}/{}"


def send_alert(alert_id: int, posting: dict, verdict: dict) -> int | None:
    e = html.escape
    deadline = posting.get("deadline") or verdict.get("deadline") or "?"
    lines = [
        f"🎯 <b>{e(posting['title'][:150])}</b>",
        f"{e(verdict['category'])} · deadline {e(str(deadline)[:10])} · via {e(posting['source'])}",
        f"fit {verdict['fit']}/100 · P(win) {round(verdict['p_convert'] * 100)}%",
        "",
        e(verdict.get("reasons") or ""),
        f"<i>angle: {e(verdict.get('angle') or '')}</i>",
        "",
        e(posting.get("url") or ""),
    ]
    if config.DASH_URL:
        lines.append(f'📝 <a href="{config.DASH_URL}/#a{alert_id}">draft ready</a>')

    r = requests.post(
        API.format(config.TELEGRAM_BOT_TOKEN, "sendMessage"),
        json={
            "chat_id": config.TELEGRAM_CHAT_ID,
            "text": "\n".join(lines),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
            "reply_markup": {"inline_keyboard": [[
                {"text": "✅ Applied", "callback_data": f"a:{alert_id}:applied"},
                {"text": "🙅 Skip", "callback_data": f"a:{alert_id}:skipped"},
                {"text": "💤 Snooze", "callback_data": f"a:{alert_id}:snoozed"},
            ]]},
        },
        timeout=30,
    )
    if not r.ok:
        print(f"telegram: send failed {r.status_code} {r.text[:200]}")
        return None
    return r.json().get("result", {}).get("message_id")
