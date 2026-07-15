# Wiring up the senses

Two connections, both optional, both free. The agent works without them — it just
stays blind between your messages.

---

## 1. Phone notifications (Android)

This is what makes money track itself: your bank's notification becomes a transaction
without you typing anything.

**Only allowlisted apps are ever stored.** The forwarder posts everything it sees;
the worker checks the app name against `notify_allow` and drops anything that doesn't
match — it never reaches the database. WhatsApp, Signal, your photos app: dropped,
unread, always. Ask the bot "what apps are you allowed to see?" any time, and
"stop storing X" to remove one.

### Setup (5 minutes)

1. Install **MacroDroid** (free) from the Play Store. *(Tasker or Automate work the
   same way if you already own one.)*
2. New Macro → **Trigger**: `Device Events → Notification → Notification Received`.
   Leave the app list empty to catch all apps — the worker does the filtering.
3. **Action**: `Applications → HTTP Request`
   - Method: `POST`
   - URL: `https://grabber.saquibjawed.workers.dev/ingest/notification`
   - Content type: `application/json`
   - Header: `X-Intelly-Secret` = *(the secret Claude gives you — never commit it)*
   - Body:
     ```json
     {"app": "[app_name]", "title": "[notification_title]", "text": "[notification_text]"}
     ```
     Those bracketed names are MacroDroid magic-text variables; insert them from the
     `{x}` button rather than typing them.
4. Save, enable the macro, and grant notification access when prompted.

Test it by asking the bot: *"what have you seen from my bank today?"*

### iPhone

iOS does not let any app read your notifications, so this bridge is Android-only —
no workaround exists. On iPhone, money tracking falls back to Gmail statement mail
plus telling the bot directly ("spent 480 on lunch"). Everything else in this file
works the same.

---

## 2. Gmail + Calendar (read-only)

Meetings become reminders 45 minutes ahead. Recruiter mail gets surfaced — and only
recruiter mail: the query deliberately ignores promotions, social, and newsletters,
so a job-board digest will never interrupt you.

**Scopes are read-only.** It cannot send mail, delete anything, or change your
calendar. Revoke any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### Setup (~10 minutes, one time)

In [console.cloud.google.com](https://console.cloud.google.com):

1. Create a new project (any name).
2. **APIs & Services → Library** → enable **Gmail API** and **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → *External* → fill the required fields
   → under **Audience → Test users**, add your own Gmail address.
   *(Staying in "testing" is correct — this app has exactly one user. You'll be
   re-prompted every 6 months, which is a feature.)*
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the
   client ID and secret.

Then locally:

```bash
python3 pipeline/scripts/google_auth.py
```

It opens your browser, you click Allow once, and it prints three values. Hand them to
Claude (or set them yourself):

```bash
cd worker
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN
```

The dashboard's **Senses** card flips to `on` once they're live.

---

## What it costs

Nothing. Notification parsing is regex, not a model call — bank alerts are formulaic
enough that a model would be waste. Only mail that matches the narrow query gets read
by the model, which is a handful a week.
