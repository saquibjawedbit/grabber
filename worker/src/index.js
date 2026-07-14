// Grabber edge worker: Telegram webhook (taps -> labels), deadline nags, dashboard API.

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

const HELP = `What I track for you:
/stats — applications, win rates, corpus size
/pending — alerted but not yet applied, by deadline
/applied — everything you applied to, with status
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

async function handleCommand(text, chatId, env) {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  let reply;
  if (cmd === "/start") reply = `Your chat_id is <code>${chatId}</code> — set it as TELEGRAM_CHAT_ID.\n\n${esc(HELP)}`;
  else if (cmd === "/help") reply = esc(HELP);
  else if (cmd === "/stats") reply = await cmdStats(env);
  else if (cmd === "/pending") reply = await cmdPending(env);
  else if (cmd === "/applied") reply = await cmdApplied(env);
  else reply = `Unknown command.\n\n${esc(HELP)}`;
  await tg(env, "sendMessage", {
    chat_id: chatId, text: reply, parse_mode: "HTML", disable_web_page_preview: true,
  });
}

// ---------- Telegram webhook: every tap is a label (point 4) ----------

async function handleTelegram(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();

  if (update.message?.text?.startsWith("/")) {
    await handleCommand(update.message.text, update.message.chat.id, env);
    return new Response("ok");
  }

  const cb = update.callback_query;
  if (!cb) return new Response("ok");

  const [tag, alertId, action] = (cb.data || "").split(":");
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
  if (url.pathname === "/api/stats") {
    const { results } = await env.DB.prepare("SELECT * FROM calibration").all();
    const corpus = await env.DB.prepare("SELECT COUNT(*) AS n FROM postings").first();
    return Response.json({ calibration: results, corpus: corpus.n });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env);
    if (url.pathname.startsWith("/api/")) return handleApi(url, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env) {
    await runNags(env);
  },
};
