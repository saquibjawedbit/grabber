// Grabber edge worker: conversational agent, Telegram webhook (taps -> labels),
// deadline nags, dashboard API.

import { embedMemory, rememberExchange, runAgent, TOOLS } from "./agent.js";
import { runWatchers } from "./watch.js";
import { googleConnected, ingestNotification, pollCalendar, pollGmail, remindEvents, surfaceEmail } from "./senses.js";
import { processBankNotifications } from "./life.js";
import { runBriefing, runOvernightResearch, runWeekly } from "./briefing.js";
import { generatePerception, getPerception } from "./perception.js";

const TG = (env, method) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

async function tg(env, method, body) {
  const r = await fetch(TG(env, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- Bot commands: the tracker you can talk to ----------

const HELP = `Just talk to me. Some things worth knowing I can do:

• <b>Dig properly</b> — "what does Zepto ask in SDE interviews? go deep" spawns a research agent on a real machine. It browses, reads, and watches talks for ~10 min, then pings you.
• <b>Watch a channel</b> — "watch @kunalb11 for hiring posts". I only interrupt you if something clears the bar.
• <b>Remember you</b> — tell me anything about yourself; I recall what's relevant when it matters.
• <b>Reminders</b> — "remind me Friday 6pm to follow up with Ankit".
• Send me any text/markdown file (resume, bio, notes) and I'll use it in everything.

Commands:
/watchers — what I'm watching
/research — recent deep dives
/stats — applications, win rates, corpus
/pending — alerted, not yet applied
/applied — everything you applied to
/memories — what I know about you
/help — this message`;

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function cmdStats(env) {
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM postings) AS corpus,
      (SELECT COUNT(*) FROM alerts WHERE sent_at IS NOT NULL) AS alerted,
      (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'applied') AS applied,
      (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'applied'
         AND at > datetime('now', '-30 days')) AS applied_30d,
      (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'won') AS won,
      (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'rejected') AS rejected,
      (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'skipped') AS skipped
  `).first();
  const decided = row.won + row.rejected;
  const waiting = row.applied - decided;

  const { results: cats } = await env.DB.prepare(
    "SELECT * FROM calibration ORDER BY n_applied DESC").all();
  const catLines = cats.map(c => {
    const d = (c.n_won || 0) + (c.n_rejected || 0);
    const rate = c.rate != null ? ` · ${Math.round(c.rate * 100)}% win rate` : " · rate unknown yet";
    return `  ${c.category}: ${c.n_applied || 0} applied${d ? rate : ""}`;
  }).join("\n");

  return `📊 <b>Your numbers</b>

Applied: <b>${row.applied}</b> total (${row.applied_30d} in last 30 days)
Won: <b>${row.won}</b> · Rejected: ${row.rejected} · Awaiting result: ${waiting}
${decided >= 5 ? `Overall win rate: <b>${Math.round((row.won / decided) * 100)}%</b> of ${decided} decided` : `Overall win rate: unknown (${decided}/5 decided applications — still guessing)`}

Alerted: ${row.alerted} · Skipped: ${row.skipped}
Corpus: ${row.corpus} postings ingested
${catLines ? `\nBy category:\n${catLines}` : ""}`;
}

async function cmdPending(env) {
  const { results } = await env.DB.prepare(`
    SELECT a.id, p.title, p.url, p.deadline
    FROM alerts a JOIN postings p ON p.id = a.posting_id
    WHERE a.sent_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM outcomes o
                      WHERE o.alert_id = a.id AND o.action IN ('applied','skipped'))
    ORDER BY CASE WHEN p.deadline IS NULL OR p.deadline = '' THEN 1 ELSE 0 END,
             date(p.deadline) LIMIT 15`).all();
  if (!results.length) return "✨ Nothing pending — every alert has been acted on.";
  const lines = results.map(a => {
    const days = a.deadline ? Math.ceil((new Date(a.deadline) - Date.now()) / 86400000) : null;
    const when = days == null ? "no deadline" : days < 0 ? "⚠️ past deadline" : days === 0 ? "🔥 TODAY" : `${days}d left`;
    return `• <a href="${esc(a.url)}">${esc(a.title.slice(0, 60))}</a> — ${when}`;
  });
  return `⏳ <b>Pending (${results.length})</b> — each unapplied one is a 100% loss:\n\n${lines.join("\n")}`;
}

async function cmdApplied(env) {
  const { results } = await env.DB.prepare(`
    SELECT p.title, p.url,
      MAX(CASE WHEN o.action = 'won' THEN 1 ELSE 0 END) AS won,
      MAX(CASE WHEN o.action = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      MIN(CASE WHEN o.action = 'applied' THEN o.at END) AS applied_at
    FROM outcomes o
    JOIN alerts a ON a.id = o.alert_id
    JOIN postings p ON p.id = a.posting_id
    WHERE o.alert_id IN (SELECT alert_id FROM outcomes WHERE action = 'applied')
    GROUP BY o.alert_id ORDER BY applied_at DESC LIMIT 20`).all();
  if (!results.length) return "No applications logged yet. Tap ✅ Applied on an alert to start the count.";
  const lines = results.map(r => {
    const status = r.won ? "🏆 won" : r.rejected ? "❌ rejected" : "⏳ waiting";
    return `• <a href="${esc(r.url)}">${esc(r.title.slice(0, 60))}</a> — ${status} <i>(${(r.applied_at || "").slice(0, 10)})</i>`;
  });
  return `✅ <b>Applied (${results.length} most recent)</b>\n\n${lines.join("\n")}`;
}

async function cmdMemories(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, category, fact FROM memories ORDER BY category, id DESC LIMIT 60").all();
  const docs = await env.DB.prepare(
    "SELECT key FROM profile WHERE key != 'conversation_summary' ORDER BY key LIMIT 20").all();
  if (!results.length && !docs.results.length) {
    return "Nothing saved yet. Tell me things worth remembering — preferences, skills, constraints — or send me a file.";
  }
  const memLines = results.map(m => `• <i>#${m.id} ${esc(m.category)}</i> — ${esc(m.fact)}`).join("\n");
  const docLine = docs.results.length
    ? `\n\n📄 <b>Profile documents:</b> ${docs.results.map(d => esc(d.key)).join(", ")}` : "";
  return `🧠 <b>What I know about you</b>\n\n${memLines || "(no memories yet)"}${docLine}\n\nSay "forget #id" to remove one.`;
}

async function cmdWatchers(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, target, note, last_checked, last_error, hits FROM watchers WHERE active = 1 ORDER BY id").all();
  if (!results.length) {
    return "👀 Watching nothing yet.\n\nThere's no scraper anymore — I only look where you point me. Try: <i>\"watch @kunalb11 for hiring posts\"</i> or <i>\"watch the Devfolio blog feed\"</i>.";
  }
  const lines = results.map(w => {
    const label = w.kind === "x" ? "@" + w.target : w.target.slice(0, 50);
    const status = w.last_error ? `⚠️ ${esc(w.last_error.slice(0, 40))}`
      : w.last_checked ? `checked ${esc(w.last_checked.slice(5, 16).replace("T", " "))}` : "not checked yet";
    return `• <b>${esc(label)}</b> <i>(${esc(w.kind)})</i> — ${w.hits} seen · ${status}\n  <i>${esc(w.note || "")}</i> <code>#${w.id}</code>`;
  });
  return `👀 <b>Watching ${results.length}</b>\n\n${lines.join("\n")}\n\nSay "stop watching #id" to remove one.`;
}

async function cmdResearch(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, question, status, created_at, finished_at FROM research ORDER BY id DESC LIMIT 8").all();
  if (!results.length) {
    return "🔍 No deep dives yet.\n\nAsk me something that deserves real digging — <i>\"what does Zepto ask in SDE interviews? go deep\"</i> — and I'll put an agent on it for ten minutes.";
  }
  const icon = { done: "✅", running: "◐", queued: "◌", failed: "⚠️" };
  const lines = results.map(r =>
    `${icon[r.status] || "·"} <b>${esc(r.question.slice(0, 70))}</b>\n  <i>${esc(r.status)}</i> <code>#${r.id}</code>`);
  return `🔍 <b>Research</b>\n\n${lines.join("\n")}\n\nSay "show me research #id" for the full report.`;
}

function isOwner(chatId, env) {
  return String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

async function handleCommand(text, chatId, env) {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  let reply;
  if (cmd === "/start") reply = `Your chat_id is <code>${chatId}</code> — set it as TELEGRAM_CHAT_ID.\n\n${esc(HELP)}`;
  else if (!isOwner(chatId, env)) reply = "I'm a personal agent working for one person, and it isn't you. 🙂";
  else if (cmd === "/help") reply = esc(HELP);
  else if (cmd === "/stats") reply = await cmdStats(env);
  else if (cmd === "/pending") reply = await cmdPending(env);
  else if (cmd === "/applied") reply = await cmdApplied(env);
  else if (cmd === "/memories") reply = await cmdMemories(env);
  else if (cmd === "/watchers") reply = await cmdWatchers(env);
  else if (cmd === "/research") reply = await cmdResearch(env);
  else reply = `Unknown command.\n\n${esc(HELP)}`;
  await tg(env, "sendMessage", {
    chat_id: chatId, text: reply, parse_mode: "HTML", disable_web_page_preview: true,
  });
}

// ---------- Voice: talking is faster than typing ----------

const MAX_VOICE_BYTES = 20_000_000;

async function transcribe(env, fileId) {
  const fi = await tg(env, "getFile", { file_id: fileId });
  const path = fi.result?.file_path;
  if (!path) throw new Error("Telegram wouldn't hand over the audio");
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!r.ok) throw new Error(`audio download failed (${r.status})`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_VOICE_BYTES) throw new Error("that clip is too long for me");
  const res = await env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(buf)] });
  return (res?.text || "").trim();
}

async function handleVoice(env, chatId, fileId, placeholderId) {
  let heard;
  try {
    heard = await transcribe(env, fileId);
  } catch (e) {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: placeholderId,
      text: `🎧 I couldn't make that out — ${String(e.message || e).slice(0, 120)}`,
    });
    return;
  }
  if (!heard) {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: placeholderId,
      text: "🎧 That came through silent — try again?",
    });
    return;
  }
  // Show what was heard before answering: a wrong transcript should be obvious,
  // not something the owner has to reverse-engineer from a strange reply.
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: placeholderId,
    text: `🎧 <i>“${esc(heard)}”</i>\n\n🤔 …`, parse_mode: "HTML",
  });
  await converse(env, chatId, heard, placeholderId, `🎧 <i>“${esc(heard)}”</i>\n\n`);
}

// ---------- Conversational agent ----------

async function converse(env, chatId, text, placeholderId, prefix = "") {
  let reply;
  try {
    reply = await runAgent(env, text);
  } catch (e) {
    reply = `⚠️ I hit an error: ${String(e).slice(0, 200)}`;
  }
  const body = {
    chat_id: chatId, text: prefix + reply, parse_mode: "HTML", disable_web_page_preview: true,
  };
  let r = placeholderId
    ? await tg(env, "editMessageText", { ...body, message_id: placeholderId })
    : await tg(env, "sendMessage", body);
  if (!r.ok) {
    // Usually the model emitted HTML-unsafe text — resend plain, and strip the
    // prefix's own markup so the owner never sees raw <i> tags.
    delete body.parse_mode;
    body.text = prefix.replace(/<[^>]+>/g, "") + reply;
    r = placeholderId
      ? await tg(env, "editMessageText", { ...body, message_id: placeholderId })
      : await tg(env, "sendMessage", body);
  }
  if (r.ok && !reply.startsWith("⚠️")) await rememberExchange(env, text, reply);
}

// ---------- File uploads: "knows everything about me" — any text file becomes profile corpus ----------

const TEXT_EXT = /\.(md|txt|markdown|yaml|yml|json|csv|tex|rst)$/i;

async function ingestDocument(env, chatId, doc) {
  const name = doc.file_name || "untitled.txt";
  let reply;
  if ((doc.file_size || 0) > 300_000) {
    reply = "That file is over 300KB — send a trimmed text version and I'll keep it.";
  } else if (!TEXT_EXT.test(name) && !(doc.mime_type || "").startsWith("text/")) {
    reply = `I can only read text for now (.md, .txt, .yaml, .json…). For a PDF resume, export or paste it as text/markdown and send that.`;
  } else {
    const fi = await tg(env, "getFile", { file_id: doc.file_id });
    const path = fi.result?.file_path;
    if (!path) {
      reply = "Telegram wouldn't hand me that file — try sending it again.";
    } else {
      const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
      const content = (await r.text()).slice(0, 200_000);
      const base = name.toLowerCase().replace(/\.[^.]+$/, "");
      // resume.md / bio.md land on the canonical keys the ranker + agent already read.
      const key = ["resume", "bio", "skills"].includes(base)
        ? base : `doc:${base.replace(/[^a-z0-9._-]+/g, "-")}`;
      await env.DB.prepare(`
        INSERT INTO profile (key, content, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`)
        .bind(key, content, new Date().toISOString()).run();
      reply = `📄 Saved as <b>${esc(key)}</b> (${content.length} chars). I'll use it in everything — rankings, drafts, and our chats.`;
    }
  }
  await tg(env, "sendMessage", { chat_id: chatId, text: reply, parse_mode: "HTML" });
}

// ---------- Telegram webhook: every tap is a label (point 4) ----------

async function handleTelegram(request, env, ctx) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();

  const msg = update.message;
  if (msg?.text?.startsWith("/")) {
    await handleCommand(msg.text, msg.chat.id, env);
    return new Response("ok");
  }
  if (msg?.document) {
    if (!isOwner(msg.chat.id, env)) return new Response("ok");
    await ingestDocument(env, msg.chat.id, msg.document);
    return new Response("ok");
  }
  const audio = msg?.voice || msg?.audio || msg?.video_note;
  if (audio) {
    if (!isOwner(msg.chat.id, env)) return new Response("ok");
    const sent = await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "🎧 listening…" });
    ctx.waitUntil(handleVoice(env, msg.chat.id, audio.file_id, sent.result?.message_id));
    return new Response("ok");
  }
  if (msg?.text) {
    if (!isOwner(msg.chat.id, env)) {
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id, text: "I'm a personal agent working for one person, and it isn't you. 🙂",
      });
      return new Response("ok");
    }
    // Ack Telegram fast; think in the background, then edit the placeholder.
    const sent = await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "🤔 …" });
    ctx.waitUntil(converse(env, msg.chat.id, msg.text, sent.result?.message_id));
    return new Response("ok");
  }

  const cb = update.callback_query;
  if (!cb) return new Response("ok");

  const [tag, alertId, action] = (cb.data || "").split(":");
  if (tag === "r" && alertId) {
    await env.DB.prepare("UPDATE reminders SET done = 1 WHERE id = ?").bind(Number(alertId)).run();
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Done ✅" });
    return new Response("ok");
  }
  if (tag !== "a" || !alertId || !action) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    return new Response("ok");
  }

  await env.DB.prepare("INSERT INTO outcomes (alert_id, action, at) VALUES (?,?,?)")
    .bind(Number(alertId), action, new Date().toISOString()).run();

  // Applied -> the next question is the real label: did you win it?
  // Won/rejected/skipped -> close the loop, remove buttons.
  let markup = { inline_keyboard: [] };
  let toast = `Logged: ${action}`;
  if (action === "applied") {
    markup.inline_keyboard = [[
      { text: "🏆 Won", callback_data: `a:${alertId}:won` },
      { text: "❌ Rejected", callback_data: `a:${alertId}:rejected` },
    ]];
    toast = "Logged: applied. Tap again when you hear back.";
  } else if (action === "snoozed") {
    toast = "Snoozed — the deadline nag will still fire.";
    markup = undefined; // keep original buttons
  }

  if (markup !== undefined) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: markup,
    });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: toast });
  return new Response("ok");
}

// ---------- Deadline nags (point 6): found -> deadline -> escalating nag ----------

const NAG_LEVELS = [
  { level: 1, withinDays: 7, label: "a week" },
  { level: 2, withinDays: 3, label: "3 days" },
  { level: 3, withinDays: 1, label: "TOMORROW" },
];

async function runNags(env) {
  const { results } = await env.DB.prepare(`
    SELECT a.id, a.nag_level, p.title, p.url, p.deadline
    FROM alerts a JOIN postings p ON p.id = a.posting_id
    WHERE a.sent_at IS NOT NULL
      AND p.deadline IS NOT NULL AND p.deadline != ''
      AND date(p.deadline) >= date('now')
      AND NOT EXISTS (
        SELECT 1 FROM outcomes o
        WHERE o.alert_id = a.id AND o.action IN ('applied','skipped')
      )`).all();

  for (const a of results) {
    const daysLeft = Math.ceil((new Date(a.deadline) - Date.now()) / 86400000);
    const due = NAG_LEVELS.filter(n => daysLeft <= n.withinDays && n.level > a.nag_level).pop();
    if (!due) continue;
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      parse_mode: "HTML",
      text: `⏰ <b>${due.label} left</b> and you haven't applied:\n${a.title}\n${a.url || ""}\n\nAn opportunity you meant to apply to and didn't is a 100% loss.`,
      reply_markup: { inline_keyboard: [[
        { text: "✅ Applied", callback_data: `a:${a.id}:applied` },
        { text: "🙅 Letting it go", callback_data: `a:${a.id}:skipped` },
      ]]},
    });
    await env.DB.prepare("UPDATE alerts SET nag_level = ? WHERE id = ?").bind(due.level, a.id).run();
  }
}

// ---------- Senses on the cron: calendar, mail ----------

async function runSenses(env) {
  if (!googleConnected(env)) return { google: "not connected" };
  const out = {};
  try {
    out.calendar = await pollCalendar(env);
    out.reminded = await remindEvents(env, tg);
  } catch (e) {
    out.calendar_error = String(e).slice(0, 150);
  }
  try {
    const { items = [], fresh = 0 } = await pollGmail(env);
    out.mail_fresh = fresh;
    if (items.length) {
      // Only the profile matters here, and only once for the whole batch.
      const parts = [];
      for (const key of ["bio", "skills"]) {
        const row = await env.DB.prepare("SELECT content FROM profile WHERE key = ?").bind(key).first();
        if (row) parts.push(row.content.slice(0, 1200));
      }
      const { results: mems } = await env.DB.prepare(
        "SELECT fact FROM memories ORDER BY id LIMIT 30").all();
      const profile = [...parts, ...mems.map(m => `- ${m.fact}`)].join("\n") || "(nothing known yet)";
      out.surfaced = 0;
      for (const m of items.slice(0, 5)) {
        if (await surfaceEmail(env, tg, profile, m)) out.surfaced++;
      }
    }
  } catch (e) {
    out.mail_error = String(e).slice(0, 150);
  }
  return out;
}

// ---------- Reminders: general-agent capability, fired by the hourly cron ----------

async function runReminders(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, text FROM reminders
    WHERE done = 0 AND notified = 0 AND datetime(due_at) <= datetime('now')
    ORDER BY due_at LIMIT 20`).all();
  for (const r of results) {
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `⏰ Reminder: ${r.text}`,
      reply_markup: { inline_keyboard: [[{ text: "✅ Done", callback_data: `r:${r.id}:done` }]] },
    });
    await env.DB.prepare("UPDATE reminders SET notified = 1 WHERE id = ?").bind(r.id).run();
  }
}

// ---------- Dashboard API ----------

async function handleApi(url, env) {
  if (url.searchParams.get("t") !== env.DASH_TOKEN) {
    return Response.json({ error: "bad token" }, { status: 403 });
  }
  if (url.pathname === "/api/alerts") {
    const { results } = await env.DB.prepare(`
      SELECT a.id, a.category, a.fit, a.p_convert, a.reasons, a.angle, a.sent_at,
             p.title, p.url, p.org, p.deadline, p.source,
             d.content_md AS draft,
             (SELECT group_concat(o.action) FROM outcomes o WHERE o.alert_id = a.id) AS outcomes
      FROM alerts a
      JOIN postings p ON p.id = a.posting_id
      LEFT JOIN drafts d ON d.alert_id = a.id
      WHERE a.sent_at IS NOT NULL
      ORDER BY a.sent_at DESC LIMIT 100`).all();
    return Response.json(results);
  }
  if (url.pathname === "/api/brain") {
    // Everything the dashboard shows: memory, reminders, profile, corpus shape.
    const [mem, rem, docs, summary, bySource, totals, recent] = await Promise.all([
      env.DB.prepare("SELECT id, category, fact, created_at FROM memories ORDER BY id DESC LIMIT 200").all(),
      env.DB.prepare("SELECT id, text, due_at, notified FROM reminders WHERE done = 0 ORDER BY due_at LIMIT 50").all(),
      env.DB.prepare("SELECT key, length(content) AS chars, updated_at FROM profile WHERE key != 'conversation_summary' ORDER BY key").all(),
      env.DB.prepare("SELECT content, updated_at FROM profile WHERE key = 'conversation_summary'").first(),
      env.DB.prepare("SELECT source, COUNT(*) AS n FROM postings GROUP BY source ORDER BY n DESC").all(),
      env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM postings) AS corpus,
          (SELECT COUNT(*) FROM memories) AS memories,
          (SELECT COUNT(*) FROM watchers WHERE active = 1) AS watchers,
          (SELECT COUNT(*) FROM research WHERE status = 'done') AS research,
          (SELECT COUNT(*) FROM reminders WHERE done = 0) AS reminders,
          (SELECT COUNT(*) FROM notifications) +
            (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM emails) AS sensed,
          (SELECT COUNT(*) FROM alerts WHERE sent_at IS NOT NULL) AS alerted,
          (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'applied') AS applied,
          (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'won') AS won,
          (SELECT COUNT(*) FROM chat_history) AS chat_rows`).first(),
      env.DB.prepare(`
        SELECT title, source, url, deadline, ingested_at FROM postings
        ORDER BY ingested_at DESC LIMIT 12`).all(),
    ]);
    // Measured rarity (point 3) and the learned pieces are the most interesting
    // things this system holds — they belong on screen, not only in the ranker.
    const [rarity, calib, people, txs, health, merchants, briefing] = await Promise.all([
      env.DB.prepare(`SELECT term, df, ROUND(idf, 2) AS idf FROM idf
                      WHERE term NOT LIKE 'phrase:%' AND df >= 2
                      ORDER BY idf DESC LIMIT 24`).all(),
      env.DB.prepare("SELECT * FROM calibration ORDER BY n_applied DESC").all(),
      env.DB.prepare(`SELECT p.name, p.relation, p.how_met, p.status, p.next_step, p.notes,
                             p.last_contact, p.created_at,
                             CAST(julianday('now') - julianday(COALESCE(p.last_contact, p.created_at)) AS INTEGER) AS days_quiet,
                             (SELECT COUNT(*) FROM interactions i WHERE i.person_id = p.id) AS touches
                      FROM people p ORDER BY days_quiet ASC LIMIT 40`).all(),
      env.DB.prepare(`SELECT amount, direction, counterparty, category, at, source
                      FROM transactions ORDER BY at DESC LIMIT 25`).all(),
      env.DB.prepare(`SELECT metric, value, unit, at FROM health
                      WHERE datetime(at) >= datetime('now', '-180 days') ORDER BY at`).all(),
      env.DB.prepare("SELECT pattern, category FROM merchant_category ORDER BY category, pattern").all(),
      env.DB.prepare("SELECT value, updated_at FROM state WHERE key = 'briefing_text'").first(),
    ]);
    const perception = await getPerception(env);
    const [accounts, holdings, spend, weight, cold, txCount] = await Promise.all([
      env.DB.prepare("SELECT name, kind, balance FROM accounts ORDER BY balance DESC").all(),
      env.DB.prepare("SELECT name, kind, category, value FROM holdings ORDER BY value DESC").all(),
      env.DB.prepare(`SELECT category, ROUND(SUM(amount)) AS total FROM transactions
                      WHERE direction = 'debit' AND datetime(at) >= datetime('now', '-30 days')
                      GROUP BY category ORDER BY total DESC`).all(),
      env.DB.prepare(`SELECT value, at FROM health WHERE metric = 'weight' AND value IS NOT NULL
                      AND datetime(at) >= datetime('now', '-120 days') ORDER BY at`).all(),
      env.DB.prepare(`SELECT name, relation, next_step, last_contact,
                             CAST(julianday('now') - julianday(COALESCE(last_contact, created_at)) AS INTEGER) AS days_quiet
                      FROM people WHERE status != 'closed'
                        AND julianday('now') - julianday(COALESCE(last_contact, created_at)) >= 10
                      ORDER BY days_quiet DESC LIMIT 8`).all(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first(),
    ]);
    const [notifications, events, mails, allow] = await Promise.all([
      env.DB.prepare(`SELECT app, title, body, kind, amount, direction, counterparty, received_at
                      FROM notifications ORDER BY id DESC LIMIT 20`).all(),
      env.DB.prepare(`SELECT title, starts_at, location FROM events
                      WHERE datetime(starts_at) >= datetime('now') ORDER BY starts_at LIMIT 10`).all(),
      env.DB.prepare(`SELECT sender, subject, kind, received_at FROM emails
                      ORDER BY received_at DESC LIMIT 10`).all(),
      env.DB.prepare("SELECT pattern, kind FROM notify_allow ORDER BY kind, pattern").all(),
    ]);
    const [watchers, research] = await Promise.all([
      env.DB.prepare("SELECT id, kind, target, note, last_checked, last_error, hits, active FROM watchers ORDER BY id").all(),
      env.DB.prepare(`SELECT id, question, depth, status, sources, steps, created_at, finished_at,
                             error, substr(report_md, 1, 4000) AS report_md
                      FROM research ORDER BY id DESC LIMIT 20`).all(),
    ]);
    return Response.json({
      memories: mem.results,
      reminders: rem.results,
      documents: docs.results,
      summary: summary ? { text: summary.content, updated_at: summary.updated_at } : null,
      by_source: bySource.results,
      totals,
      recent: recent.results,
      watchers: watchers.results,
      research: research.results.map(r => ({ ...r, sources: r.sources ? JSON.parse(r.sources) : [] })),
      life: {
        accounts: accounts.results,
        holdings: holdings.results,
        spend_30d: spend.results,
        weight: weight.results,
        cold_threads: cold.results,
        tx_count: txCount.n,
        transactions: txs.results,
        people: people.results,
        health: health.results,
      },
      rarity: rarity.results,
      calibration: calib.results,
      merchants: merchants.results,
      briefing: briefing ? { text: briefing.value, at: briefing.updated_at } : null,
      perception,
      senses: {
        google_connected: googleConnected(env),
        notify_wired: Boolean(env.NOTIFY_SECRET),
        notifications: notifications.results,
        events: events.results,
        emails: mails.results,
        allowlist: allow.results,
      },
    });
  }
  if (url.pathname === "/api/embed-backfill") {
    // One-shot: give memories saved before v3 their vectors.
    const { results } = await env.DB.prepare(
      "SELECT id, fact FROM memories WHERE embedding IS NULL LIMIT 50").all();
    let ok = 0;
    for (const m of results) if (await embedMemory(env, m.id, m.fact)) ok++;
    return Response.json({ pending: results.length, embedded: ok });
  }
  if (url.pathname === "/api/google-test") {
    // Dry check after connecting: what Gmail + Calendar see, without alerting.
    if (!googleConnected(env)) return Response.json({ connected: false });
    const out = { connected: true };
    try { out.gmail = await pollGmail(env); } catch (e) { out.gmail_error = String(e).slice(0, 200); }
    try { out.calendar = await pollCalendar(env); } catch (e) { out.calendar_error = String(e).slice(0, 200); }
    return Response.json(out);
  }
  if (url.pathname === "/api/perception") {
    // ?refresh=1 regenerates (one LLM call); otherwise return the cached read.
    if (url.searchParams.get("refresh") === "1") {
      return Response.json(await generatePerception(env));
    }
    return Response.json(await getPerception(env) || { empty: true });
  }
  if (url.pathname === "/api/tool") {
    // Debug: run one agent tool directly. /api/tool?t=TOKEN&name=web_search&args={"query":"..."}
    const tool = TOOLS[url.searchParams.get("name")];
    if (!tool) return Response.json({ error: "unknown tool" }, { status: 404 });
    let args = {};
    try { args = JSON.parse(url.searchParams.get("args") || "{}"); } catch { /* empty */ }
    try {
      return Response.json(await tool.run(env, args));
    } catch (e) {
      return Response.json({ error: String(e) });
    }
  }
  if (url.pathname === "/api/cron") {
    // Manual trigger for testing — same work as the hourly cron.
    await runReminders(env);
    await runNags(env);
    const money = await processBankNotifications(env);
    const senses = url.searchParams.get("senses") === "1" ? await runSenses(env) : "skipped";
    const watch = url.searchParams.get("watch") === "1" ? await runWatchers(env, tg) : "skipped";
    const q = k => url.searchParams.get(k) === "1";
    const brief = q("brief") ? await runBriefing(env, tg, { force: q("force") }) : "skipped";
    const weekly = q("weekly") ? await runWeekly(env, tg, { force: q("force") }) : "skipped";
    return Response.json({ ok: true, money, senses, watch, brief, weekly });
  }
  if (url.pathname === "/api/stats") {
    const { results } = await env.DB.prepare("SELECT * FROM calibration").all();
    const corpus = await env.DB.prepare("SELECT COUNT(*) AS n FROM postings").first();
    return Response.json({ calibration: results, corpus: corpus.n });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ai-debug" && url.searchParams.get("t") === env.DASH_TOKEN) {
      try {
        const res = await env.AI.run("@cf/openai/gpt-oss-120b",
          { input: "Reply with exactly: BINDING OK", reasoning: { effort: "low" } });
        return Response.json({ raw: res });
      } catch (e) {
        return Response.json({ error: String(e) });
      }
    }
    if (url.pathname === "/ingest/notification" && request.method === "POST") {
      // The phone bridge posts here. Its own secret, so a leaked dashboard token
      // can't write into the agent's senses.
      if (request.headers.get("X-Intelly-Secret") !== env.NOTIFY_SECRET || !env.NOTIFY_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "expected json" }, { status: 400 });
      }
      try {
        return Response.json(await ingestNotification(env, payload));
      } catch (e) {
        return Response.json({ error: String(e).slice(0, 150) }, { status: 500 });
      }
    }
    if (url.pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return handleApi(url, env);
    // The dashboard is one HTML file that changes every deploy — never let a browser
    // or edge cache serve a stale copy, or a UI fix looks broken until a hard reload.
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-cache, must-revalidate");
    return new Response(res.body, { status: res.status, headers });
  },
  async scheduled(_event, env) {
    await runReminders(env);
    await runNags(env); // idempotent: nag_level gates each escalation to once
    // One sense failing must never stop the others.
    for (const [name, fn] of [
      ["senses", runSenses],
      ["money", processBankNotifications],   // bank alerts Phase 4 filed -> transactions
      ["watchers", e => runWatchers(e, tg)],
      // Initiative last: it reports on everything above, so it runs after them.
      ["briefing", e => runBriefing(e, tg)],
      ["weekly", e => runWeekly(e, tg)],
      ["overnight", e => runOvernightResearch(e, (en, args) => TOOLS.spawn_research.run(en, args))],
    ]) {
      try {
        const out = await fn(env);
        if (out && !out.skipped) console.log(`${name}:`, JSON.stringify(out).slice(0, 200));
      } catch (e) {
        console.log(`${name} failed:`, String(e).slice(0, 200));
      }
    }
  },
};
