// Phase 6: initiative. The agent stops waiting to be opened.
//
// Point 7 governs everything here: silence is the product. A scheduled message is
// still an interruption, so a briefing only goes out when it carries something that
// changes what the owner would do today. Nothing worth saying -> nothing sent.
//
// Every number in a briefing comes from SQL. The model only writes the sentence
// around facts it is handed; it is never asked what the numbers are.

import { llm } from "./llm.js";

const BRIEF_HOUR_DEFAULT = 8;    // IST
const WEEKLY_HOUR = 19;          // IST Sunday
const RESEARCH_HOUR = 3;         // IST, while they sleep
const SPEND_JUMP_PCT = 25;
const APPLY_DROUGHT_DAYS = 10;

// ---------- IST clock (the owner's day, not UTC's) ----------

export function ist(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", hour12: false,
  }).formatToParts(now).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return { hour: Number(p.hour), weekday: p.weekday, date };
}

async function getState(env, key) {
  const r = await env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first();
  return r?.value || null;
}

async function setState(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, String(value), new Date().toISOString()).run();
}

// Hand the model times already in the owner's clock. Asking it to convert is how
// "6pm Friday" became a Thursday once — conversions belong in code.
const istTime = iso => iso
  ? new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(iso)) + " IST"
  : null;

// ---------- Facts (SQL only — the model gets these, never guesses them) ----------

async function collectFacts(env) {
  const [deadlines, pending, events, reminders, research, cold, spend, prevSpend,
         lastApplied, weight] = await Promise.all([
    env.DB.prepare(`
      SELECT p.title, p.url, p.deadline, a.fit,
             CAST(julianday(p.deadline) - julianday('now') AS INTEGER) AS days_left
      FROM alerts a JOIN postings p ON p.id = a.posting_id
      WHERE a.sent_at IS NOT NULL AND p.deadline IS NOT NULL AND p.deadline != ''
        AND date(p.deadline) >= date('now') AND date(p.deadline) <= date('now', '+7 days')
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.alert_id = a.id
                        AND o.action IN ('applied','skipped'))
      ORDER BY p.deadline LIMIT 5`).all(),
    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM alerts a
      WHERE a.sent_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.alert_id = a.id
                        AND o.action IN ('applied','skipped'))`).first(),
    env.DB.prepare(`
      SELECT title, starts_at, location FROM events
      WHERE date(starts_at) = date('now', '+330 minutes') ORDER BY starts_at LIMIT 6`).all(),
    env.DB.prepare(`
      SELECT text, due_at FROM reminders
      WHERE done = 0 AND date(due_at, '+330 minutes') = date('now', '+330 minutes')
      ORDER BY due_at LIMIT 6`).all(),
    env.DB.prepare(`
      SELECT id, question, substr(report_md, 1, 700) AS report FROM research
      WHERE status = 'done' AND datetime(finished_at) >= datetime('now', '-20 hours')
      ORDER BY id DESC LIMIT 2`).all(),
    env.DB.prepare(`
      SELECT name, relation, next_step,
             CAST(julianday('now') - julianday(COALESCE(last_contact, created_at)) AS INTEGER) AS days_quiet
      FROM people WHERE status != 'closed'
        AND julianday('now') - julianday(COALESCE(last_contact, created_at)) >= 14
      ORDER BY days_quiet DESC LIMIT 3`).all(),
    env.DB.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS v FROM transactions
      WHERE direction = 'debit' AND datetime(at) >= datetime('now', '-7 days')`).first(),
    env.DB.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS v FROM transactions
      WHERE direction = 'debit' AND datetime(at) >= datetime('now', '-14 days')
        AND datetime(at) < datetime('now', '-7 days')`).first(),
    env.DB.prepare(`
      SELECT MAX(at) AS at FROM outcomes WHERE action = 'applied'`).first(),
    env.DB.prepare(`
      SELECT value, at FROM health WHERE metric = 'weight' AND value IS NOT NULL
      ORDER BY at DESC LIMIT 1`).first(),
  ]);

  // Anomalies are measured, never inferred.
  const anomalies = [];
  if (prevSpend.v > 0 && spend.v > 0) {
    const pct = Math.round(((spend.v - prevSpend.v) / prevSpend.v) * 100);
    if (Math.abs(pct) >= SPEND_JUMP_PCT) {
      const { results: top } = await env.DB.prepare(`
        SELECT category, ROUND(SUM(amount)) AS total FROM transactions
        WHERE direction = 'debit' AND datetime(at) >= datetime('now', '-7 days')
        GROUP BY category ORDER BY total DESC LIMIT 1`).all();
      anomalies.push({
        kind: "spend", change_pct: pct,
        this_week: Math.round(spend.v), last_week: Math.round(prevSpend.v),
        biggest_category: top[0]?.category || null,
      });
    }
  }
  if (lastApplied?.at) {
    const days = Math.floor((Date.now() - Date.parse(lastApplied.at)) / 86400000);
    if (days >= APPLY_DROUGHT_DAYS) anomalies.push({ kind: "apply_drought", days });
  }

  return {
    deadlines: deadlines.results,
    pending_alerts_never_acted_on: pending.n,
    events: events.results.map(e => ({ ...e, when: istTime(e.starts_at), starts_at: undefined })),
    reminders: reminders.results.map(r => ({ text: r.text, when: istTime(r.due_at) })),
    research: research.results,
    cold: cold.results,
    anomalies,
    weight: weight || null,
  };
}

// A briefing that says "nothing to report" is a notification that cost attention and
// gave nothing back. If there's no reason to speak, don't.
function worthSending(f) {
  return f.deadlines.length > 0 || f.events.length > 0 || f.reminders.length > 0 ||
         f.research.length > 0 || f.anomalies.length > 0 || f.cold.length > 0;
}

const BRIEF_PROMPT = (profile, facts) => `You are Intelly, writing your owner's morning briefing.
One Telegram message. This is the only time today you interrupt them unasked, so earn it.

## Them
${profile}

## Today's facts — the ONLY facts you have. Never add a number that isn't here.
${JSON.stringify(facts, null, 1)}

## How to write it
- Open with the single thing that matters most today. If a deadline is close and they
  haven't applied, that is always it.
- Then the rest as short lines. Skip any section that's empty — don't write "no meetings".
- If research finished overnight, give its headline finding in one line, not a summary.
- Anomalies: state the number plainly and what it means. No lecturing.
- Cold threads: name the person and the next step, once. No nagging tone.
- Plain text with simple <b> and <i> only. No markdown headers. Under 140 words.
- No greeting boilerplate, no "let me know if you need anything".`;

export async function runBriefing(env, tg, { force = false } = {}) {
  const t = ist();
  const wanted = Number(await getState(env, "briefing_hour") || BRIEF_HOUR_DEFAULT);
  const enabled = (await getState(env, "briefing_enabled")) !== "0";
  if (!force) {
    if (!enabled) return { skipped: "disabled" };
    if (t.hour !== wanted) return { skipped: `hour ${t.hour} != ${wanted}` };
    if (await getState(env, "briefing_last") === t.date) return { skipped: "already sent today" };
  }

  const facts = await collectFacts(env);
  // force skips the clock, never the silence rule. Point 7 isn't a scheduling
  // detail — an empty briefing is pure noise however it was triggered.
  if (!worthSending(facts)) {
    await setState(env, "briefing_last", t.date);   // don't retry all day
    return { skipped: "nothing worth interrupting for" };
  }

  const profile = await ownerLine(env);
  const { text, salvaged } = await llm(env, BRIEF_PROMPT(profile, facts));
  if (!text.trim() || salvaged) return { error: "briefing came back empty" };

  const body = text.slice(0, 3500);
  const r = await tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, text: `☀️ <b>Today</b>\n\n${body}`,
    parse_mode: "HTML", disable_web_page_preview: true,
  });
  if (!r.ok) {
    await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: `☀️ Today\n\n${body.replace(/<[^>]+>/g, "")}` });
  }
  await setState(env, "briefing_last", t.date);
  await setState(env, "briefing_text", body);
  return { sent: true, facts_used: Object.keys(facts).filter(k => facts[k]?.length) };
}

async function ownerLine(env) {
  const bio = await env.DB.prepare("SELECT content FROM profile WHERE key = 'bio'").first();
  const { results: goals } = await env.DB.prepare(
    "SELECT fact FROM memories WHERE category IN ('goal','preference') ORDER BY id LIMIT 12").all();
  return [bio?.content?.slice(0, 500) || "", ...goals.map(g => `- ${g.fact}`)]
    .filter(Boolean).join("\n") || "(you know little about them yet)";
}

// ---------- Weekly review ----------

const WEEKLY_PROMPT = (profile, facts) => `You are Intelly, writing your owner's weekly review.
Be honest, not encouraging. The point is what actually moved and what quietly didn't.

## Them
${profile}

## This week, measured — the ONLY facts you have
${JSON.stringify(facts, null, 1)}

## How to write it
- Lead with the number that matters: applications sent. If it's zero, say so plainly —
  discovery was never the bottleneck, applying is.
- What moved: wins, replies, research done.
- What got dropped: alerts never acted on, threads gone cold, deadlines missed.
- One concrete recommendation for next week. Specific, not "keep going".
- Plain text, simple <b>/<i> only, under 160 words. No cheerleading.`;

export async function runWeekly(env, tg, { force = false } = {}) {
  const t = ist();
  if (!force) {
    if (t.weekday !== "Sun" || t.hour !== WEEKLY_HOUR) return { skipped: "not sunday evening" };
    if (await getState(env, "weekly_last") === t.date) return { skipped: "already sent" };
  }
  const [applied, won, rejected, alerted, unacted, research, spend, cold] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT alert_id) AS n FROM outcomes
                    WHERE action='applied' AND at >= datetime('now','-7 days')`).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT alert_id) AS n FROM outcomes
                    WHERE action='won' AND at >= datetime('now','-7 days')`).first(),
    env.DB.prepare(`SELECT COUNT(DISTINCT alert_id) AS n FROM outcomes
                    WHERE action='rejected' AND at >= datetime('now','-7 days')`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM alerts
                    WHERE sent_at >= datetime('now','-7 days')`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM alerts a WHERE a.sent_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.alert_id=a.id
                                    AND o.action IN ('applied','skipped'))`).first(),
    env.DB.prepare(`SELECT question FROM research WHERE status='done'
                    AND finished_at >= datetime('now','-7 days') LIMIT 5`).all(),
    env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions
                    WHERE direction='debit' AND at >= datetime('now','-7 days')`).first(),
    env.DB.prepare(`SELECT name, next_step,
                      CAST(julianday('now') - julianday(COALESCE(last_contact, created_at)) AS INTEGER) AS days_quiet
                    FROM people WHERE status != 'closed'
                      AND julianday('now') - julianday(COALESCE(last_contact, created_at)) >= 14
                    ORDER BY days_quiet DESC LIMIT 5`).all(),
  ]);
  const facts = {
    applied_this_week: applied.n, won: won.n, rejected: rejected.n,
    alerts_sent: alerted.n, alerts_never_acted_on: unacted.n,
    research_done: research.results.map(r => r.question),
    spent_this_week: Math.round(spend.v),
    threads_going_cold: cold.results,
  };
  const { text, salvaged } = await llm(env, WEEKLY_PROMPT(await ownerLine(env), facts));
  if (!text.trim() || salvaged) return { error: "weekly came back empty" };
  await tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, text: `📊 <b>Your week</b>\n\n${text.slice(0, 3500)}`,
    parse_mode: "HTML", disable_web_page_preview: true,
  });
  await setState(env, "weekly_last", t.date);
  return { sent: true, facts };
}

// ---------- Overnight research: it picks its own question ----------

const PICK_PROMPT = (profile, recent, watching) => `You are Intelly. Your owner is asleep. You
have one research agent and a few hours. Pick the single question most worth answering for
them by morning.

## Them
${profile}

## Already researched (do NOT repeat these)
${recent.length ? recent.map(r => `- ${r}`).join("\n") : "(nothing yet)"}

## Channels they watch
${watching.length ? watching.map(w => `- ${w}`).join("\n") : "(none)"}

Good questions are concrete and actionable by them: how a specific company hires, whether a
specific programme is worth applying to, what a specific person's background suggests, what a
named ecosystem is paying. Bad questions are vague self-help ("how to network better").

If you genuinely don't know enough about them to pick something worth an agent's time, reply
with exactly: SKIP

Otherwise reply with ONLY the question, one line, no preamble.`;

export async function runOvernightResearch(env, spawn) {
  const t = ist();
  if (t.hour !== RESEARCH_HOUR) return { skipped: "not the small hours" };
  if (await getState(env, "overnight_last") === t.date) return { skipped: "already ran" };
  if (!env.GH_TOKEN || !env.GH_REPO) return { skipped: "research isn't wired up (no GH_TOKEN)" };

  const { results: mems } = await env.DB.prepare(
    "SELECT fact FROM memories WHERE category IN ('goal','skill','project','identity')").all();
  // Without goals, a self-directed question is a guess dressed as initiative.
  if (mems.length < 3) {
    await setState(env, "overnight_last", t.date);
    return { skipped: "not enough known about the owner to pick a good question" };
  }
  const { results: recent } = await env.DB.prepare(
    "SELECT question FROM research ORDER BY id DESC LIMIT 10").all();
  const { results: watchers } = await env.DB.prepare(
    "SELECT kind, target FROM watchers WHERE active = 1").all();

  const { text } = await llm(env, PICK_PROMPT(
    await ownerLine(env),
    recent.map(r => r.question),
    watchers.map(w => `${w.kind}:${w.target}`)));
  const q = text.trim().split("\n").filter(Boolean).pop() || "";
  if (!q || /^SKIP$/i.test(q) || q.length < 15) {
    await setState(env, "overnight_last", t.date);
    return { skipped: "nothing worth researching tonight" };
  }
  await setState(env, "overnight_last", t.date);
  const res = await spawn(env, { question: q.slice(0, 400), depth: "normal" });
  return { picked: q, ...res };
}
