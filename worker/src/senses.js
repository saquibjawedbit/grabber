// Phase 4 senses: the things the agent learns without being told.
//
// Privacy stance: the phone bridge posts every notification it sees, but only
// allowlisted apps are ever written down. Everything else is dropped in memory and
// never reaches the database — your chats are not the agent's business.

import { llm } from "./agent.js";

// ---------- Phone notifications ----------

// Money notifications are formulaic. Read them with a regex first and spend a
// model call only on the ones that don't parse.
const AMOUNT_RE = /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;
const DEBIT_RE = /\b(debited|spent|paid|sent|withdrawn|purchase)\b/i;
const CREDIT_RE = /\b(credited|received|refund|deposited|salary)\b/i;
const PARTY_RE = /(?:to|at|from)\s+([A-Za-z0-9&.\s]{3,40}?)(?:\s+on\b|\s+via\b|\.|,|$)/i;

export function parseMoney(text) {
  const m = AMOUNT_RE.exec(text || "");
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(amount)) return null;
  const direction = CREDIT_RE.test(text) ? "credit" : DEBIT_RE.test(text) ? "debit" : null;
  if (!direction) return null;
  const p = PARTY_RE.exec(text);
  return { amount, direction, counterparty: p ? p[1].trim().slice(0, 60) : null };
}

async function allowFor(env, app, title) {
  const hay = `${app} ${title}`.toLowerCase();
  const { results } = await env.DB.prepare("SELECT pattern, kind FROM notify_allow").all();
  return results.find(r => hay.includes(r.pattern)) || null;
}

export async function ingestNotification(env, payload) {
  const app = String(payload.app || payload.package || "").slice(0, 120);
  const title = String(payload.title || "").slice(0, 200);
  const body = String(payload.text || payload.body || "").slice(0, 1000);
  if (!app && !title && !body) return { ok: false, reason: "empty" };

  const allow = await allowFor(env, app, title);
  if (!allow) return { ok: true, stored: false, reason: "app not on the allowlist" };

  const blob = `${title} ${body}`;
  const money = allow.kind === "bank" ? parseMoney(blob) : null;

  const row = await env.DB.prepare(
    `INSERT INTO notifications (app, title, body, kind, amount, direction, counterparty,
                                posted_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
    .bind(app, title, body, allow.kind, money?.amount ?? null, money?.direction ?? null,
          money?.counterparty ?? null, payload.posted_at || null, new Date().toISOString())
    .first();

  return { ok: true, stored: true, id: row.id, kind: allow.kind, parsed: money };
}

// ---------- Google: one refresh token, two senses ----------

async function googleToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("google not connected");
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`google auth ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json()).access_token;
}

export function googleConnected(env) {
  return Boolean(env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

async function getState(env, key) {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first();
  return row?.value || null;
}

async function setState(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, String(value), new Date().toISOString()).run();
}

// ---------- Calendar: meetings become reminders ----------

export async function pollCalendar(env) {
  if (!googleConnected(env)) return { skipped: "google not connected" };
  const token = await googleToken(env);
  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 86400000);
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
    new URLSearchParams({
      timeMin: now.toISOString(), timeMax: horizon.toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "25",
    });
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`calendar ${r.status}`);
  const { items = [] } = await r.json();

  let added = 0;
  for (const e of items) {
    const starts = e.start?.dateTime || e.start?.date;
    if (!starts) continue;
    const res = await env.DB.prepare(
      `INSERT INTO events (id, title, starts_at, ends_at, location, link, attendees, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, starts_at = excluded.starts_at,
         ends_at = excluded.ends_at, location = excluded.location, updated_at = excluded.updated_at
       RETURNING id`)
      .bind(e.id, (e.summary || "(no title)").slice(0, 200), starts,
            e.end?.dateTime || e.end?.date || null, (e.location || "").slice(0, 200),
            e.htmlLink || null,
            (e.attendees || []).map(a => a.email).join(", ").slice(0, 300),
            new Date().toISOString()).all();
    if (res.results.length) added++;
  }
  return { seen: items.length, upserted: added };
}

// A meeting you forget is worse than one you never booked — nag 45 min ahead.
export async function remindEvents(env, tg) {
  const { results } = await env.DB.prepare(`
    SELECT id, title, starts_at, location, link FROM events
    WHERE reminded = 0
      AND datetime(starts_at) > datetime('now')
      AND datetime(starts_at) <= datetime('now', '+45 minutes')
    LIMIT 5`).all();
  for (const e of results) {
    const when = new Date(e.starts_at).toLocaleString("en-IN",
      { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text: `📅 <b>${esc(e.title)}</b> at ${esc(when)}\n${e.location ? esc(e.location) + "\n" : ""}${e.link || ""}`,
    });
    await env.DB.prepare("UPDATE events SET reminded = 1 WHERE id = ?").bind(e.id).run();
  }
  return results.length;
}

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------- Gmail: only the mail that changes what you do today ----------

// Deliberately narrow. A general inbox reader would burn neurons on newsletters
// and bury the two mails a week that actually matter.
const GMAIL_QUERY = "newer_than:2d -category:promotions -category:social " +
  "(recruiter OR hiring OR interview OR \"your application\" OR opportunity OR " +
  "internship OR fellowship OR grant OR shortlisted OR offer)";

export async function pollGmail(env) {
  if (!googleConnected(env)) return { skipped: "google not connected" };
  const token = await googleToken(env);
  const listUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
    new URLSearchParams({ q: GMAIL_QUERY, maxResults: "10" });
  const r = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`gmail ${r.status}`);
  const { messages = [] } = await r.json();

  const fresh = [];
  for (const m of messages) {
    const seen = await env.DB.prepare("SELECT id FROM emails WHERE id = ?").bind(m.id).first();
    if (seen) continue;
    const mr = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata` +
      "&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",
      { headers: { Authorization: `Bearer ${token}` } });
    if (!mr.ok) continue;
    const msg = await mr.json();
    const h = Object.fromEntries((msg.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    const row = {
      id: m.id, thread_id: msg.threadId,
      sender: (h.from || "").slice(0, 200), subject: (h.subject || "(no subject)").slice(0, 250),
      snippet: (msg.snippet || "").slice(0, 500),
      received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    };
    await env.DB.prepare(
      `INSERT OR IGNORE INTO emails (id, thread_id, sender, subject, snippet, received_at, kind)
       VALUES (?,?,?,?,?,?,'unclassified')`)
      .bind(row.id, row.thread_id, row.sender, row.subject, row.snippet, row.received_at).run();
    fresh.push(row);
  }
  return { matched: messages.length, fresh: fresh.length, items: fresh };
}

const MAIL_PROMPT = (profile, m) => `Classify one email for someone's personal agent.

## Them
${profile}

## Email
From: ${m.sender}
Subject: ${m.subject}
${m.snippet}

Return JSON only:
{"kind":"recruiter|opportunity|statement|other",
 "needs_reply": true|false,
 "urgent": true|false,
 "summary":"one line, what it actually wants from them",
 "worth_interrupting": true|false}

worth_interrupting is true ONLY if a real person wants something from them, or a real
deadline is attached. Newsletters, job-board digests and automated "we received your
application" mails are false.`;

export async function surfaceEmail(env, tg, profile, m) {
  const { text } = await llm(env, MAIL_PROMPT(profile, m));
  const jm = text.match(/\{[\s\S]*\}/);
  let v = null;
  try { v = jm ? JSON.parse(jm[0]) : null; } catch { /* fall through */ }
  const kind = v?.kind || "other";
  await env.DB.prepare("UPDATE emails SET kind = ?, surfaced = 1 WHERE id = ?")
    .bind(kind, m.id).run();
  if (!v?.worth_interrupting) return false;
  await tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    text: `📬 <b>${esc(m.subject)}</b>\n<i>${esc(m.sender)}</i>\n\n${esc(v.summary || m.snippet)}` +
          `${v.urgent ? "\n\n⏰ reads as time-sensitive" : ""}` +
          `\n\nhttps://mail.google.com/mail/u/0/#inbox/${m.thread_id}`,
  });
  return true;
}
