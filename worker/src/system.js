// The System — grabber's motive engine.
//
// A strict mentor modeled on the System from Solo Leveling. Its single objective is to
// make the owner achieve their declared GOALS. It does not wait for opportunities to
// appear (that was the old job-board engine, now removed) — it drives the owner forward:
// every morning it issues QUESTS, every night it holds a reckoning, failure costs XP and
// breaks the streak, and progress levels them up.
//
// The prediction→label→calibration machinery of the old opportunity engine maps almost
// 1:1 onto quest→resolution→XP, so this is a re-shaping of that idea, not a bolt-on.

import { llm } from "./llm.js";
import { getPersona, voiceBlock } from "./persona.js";

const ISSUE_HOUR = 7;       // IST — morning quest issuance
const DEBRIEF_HOUR = 21;    // IST — evening reckoning
const DAILY_XP = 10, MILESTONE_XP = 30, URGENT_XP = 15, FAIL_PENALTY = 5;
const MAX_DAILY_QUESTS = 4;

export const QUEST_KINDS = ["daily", "milestone", "urgent"];
const XP_BY_KIND = { daily: DAILY_XP, milestone: MILESTONE_XP, urgent: URGENT_XP };

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------- IST clock (the owner's day, not UTC's) ----------

function ist(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false,
  }).formatToParts(now).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return { hour: Number(p.hour), date };
}

// The end of the owner's today, in UTC ISO — a daily quest is due by tonight.
function endOfTodayUtc() {
  return new Date(`${ist().date}T23:59:00+05:30`).toISOString();
}

// ---------- state helpers (key-value in the `state` table) ----------

async function getState(env, key) {
  const r = await env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first();
  return r?.value ?? null;
}
async function setState(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, String(value), new Date().toISOString()).run();
}

// ---------- Activity log: what the agent did to move the owner's goals ----------

export async function logActivity(env, { kind, summary, detail = null, goal_id = null, quest_id = null }) {
  try {
    await env.DB.prepare(
      "INSERT INTO activity (at, kind, summary, detail, goal_id, quest_id) VALUES (?,?,?,?,?,?)")
      .bind(new Date().toISOString(), kind, String(summary).slice(0, 300),
            detail ? String(detail).slice(0, 1000) : null,
            goal_id ? Number(goal_id) : null, quest_id ? Number(quest_id) : null).run();
  } catch (e) {
    console.log("logActivity failed:", String(e).slice(0, 120));
  }
}

// ---------- XP / level / streak ----------
// Level curve: level N needs (N-1)^2 * 100 XP. L2@100, L3@400, L4@900, L5@1600…

export function levelFor(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1; }
export function xpForLevel(l) { return (l - 1) * (l - 1) * 100; }

export async function getSystemState(env) {
  const xp = Number(await getState(env, "xp") || 0);
  const level = levelFor(xp);
  return {
    xp, level,
    streak: Number(await getState(env, "streak") || 0),
    streak_best: Number(await getState(env, "streak_best") || 0),
    xp_into_level: xp - xpForLevel(level),
    xp_to_next: xpForLevel(level + 1) - xp,
  };
}

async function addXp(env, delta) {
  const prev = Number(await getState(env, "xp") || 0);
  const xp = Math.max(0, prev + delta);
  await setState(env, "xp", xp);
  await setState(env, "level", levelFor(xp));
  return { xp, level: levelFor(xp), leveled_up: levelFor(xp) > levelFor(prev), leveled_down: levelFor(xp) < levelFor(prev) };
}

// ---------- Goals ----------

export async function createGoal(env, { title, why, target, deadline }) {
  title = String(title || "").trim();
  if (!title) return { error: "a goal needs a title" };
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO goals (title, why, target, deadline, status, created_at, updated_at)
     VALUES (?,?,?,?, 'active', ?, ?) RETURNING id`)
    .bind(title.slice(0, 200), String(why || "").slice(0, 500) || null,
          String(target || "").slice(0, 200) || null, deadline || null, now, now).first();
  await logActivity(env, {
    kind: "goal", goal_id: row.id,
    summary: `New goal set: ${title}`,
    detail: [target && `Target: ${target}`, deadline && `By ${deadline}`, why].filter(Boolean).join(" · ") || null,
  });
  return { ok: true, id: row.id, title, note: "The System will start issuing quests toward this." };
}

export async function listGoals(env, { status = "active" } = {}) {
  const where = status === "all" ? "" : "WHERE status = ?";
  const binds = status === "all" ? [] : [status];
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title, g.why, g.target, g.deadline, g.status, g.created_at,
            (SELECT COUNT(*) FROM quests q WHERE q.goal_id = g.id AND q.status = 'done') AS quests_done,
            (SELECT COUNT(*) FROM quests q WHERE q.goal_id = g.id AND q.status = 'failed') AS quests_failed
     FROM goals g ${where} ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.id`)
    .bind(...binds).all();
  return { count: results.length, goals: results };
}

export async function updateGoal(env, id, fields) {
  const g = await env.DB.prepare("SELECT * FROM goals WHERE id = ?").bind(Number(id)).first();
  if (!g) return { error: "no goal with that id" };
  const m = {
    title: fields.title ?? g.title,
    why: fields.why ?? g.why,
    target: fields.target ?? g.target,
    deadline: fields.deadline ?? g.deadline,
    status: ["active", "achieved", "dropped"].includes(fields.status) ? fields.status : g.status,
  };
  await env.DB.prepare(
    "UPDATE goals SET title = ?, why = ?, target = ?, deadline = ?, status = ?, updated_at = ? WHERE id = ?")
    .bind(m.title, m.why, m.target, m.deadline, m.status, new Date().toISOString(), Number(id)).run();
  return { ok: true, id: Number(id), ...m };
}

// ---------- Quests ----------

export async function createQuest(env, { goal_id = null, text, kind = "daily", due_at }) {
  text = String(text || "").trim();
  if (!text) return { error: "a quest needs text" };
  const k = QUEST_KINDS.includes(kind) ? kind : "daily";
  const row = await env.DB.prepare(
    `INSERT INTO quests (goal_id, text, kind, status, xp, due_at, issued_at)
     VALUES (?,?,?, 'issued', ?, ?, ?) RETURNING id`)
    .bind(goal_id ? Number(goal_id) : null, text.slice(0, 300), k, XP_BY_KIND[k],
          due_at || endOfTodayUtc(), new Date().toISOString()).first();
  return { ok: true, id: row.id, text, kind: k, xp: XP_BY_KIND[k] };
}

export async function listQuests(env, { status = "today" } = {}) {
  let sql, binds = [];
  if (status === "today") {
    sql = "SELECT * FROM quests WHERE date(issued_at, '+330 minutes') = date('now', '+330 minutes') ORDER BY id";
  } else if (status === "open") {
    sql = "SELECT * FROM quests WHERE status IN ('issued','doing') ORDER BY due_at";
  } else if (status === "all") {
    sql = "SELECT * FROM quests ORDER BY id DESC LIMIT 30";
  } else {
    sql = "SELECT * FROM quests WHERE status = ? ORDER BY id DESC LIMIT 30"; binds = [status];
  }
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return { count: results.length, quests: results };
}

// done | doing | failed | skipped. Only 'done' earns XP; 'failed' costs it.
export async function resolveQuest(env, id, action) {
  const q = await env.DB.prepare("SELECT * FROM quests WHERE id = ?").bind(Number(id)).first();
  if (!q) return { error: "no quest with that id" };
  if (["done", "failed", "skipped"].includes(q.status)) return { ok: true, already: q.status };
  const status = ["done", "doing", "failed", "skipped"].includes(action) ? action : "doing";
  await env.DB.prepare("UPDATE quests SET status = ?, resolved_at = ? WHERE id = ?")
    .bind(status, status === "doing" ? null : new Date().toISOString(), Number(id)).run();
  let delta = 0;
  if (status === "done") delta = q.xp || DAILY_XP;
  else if (status === "failed") delta = -FAIL_PENALTY;
  const st = delta ? await addXp(env, delta) : await getSystemState(env);
  if (status === "done" || status === "failed") {
    await logActivity(env, {
      kind: status === "done" ? "quest_done" : "quest_failed", quest_id: q.id, goal_id: q.goal_id,
      summary: `${status === "done" ? "Cleared" : "Failed"} quest: ${q.text}`,
      detail: `${delta >= 0 ? "+" : ""}${delta} XP → level ${st.level}`,
    });
  }
  return { ok: true, status, xp_delta: delta, ...st };
}

// ---------- Owner profile the System reasons over ----------

async function ownerProfile(env) {
  const parts = [];
  for (const key of ["bio", "skills"]) {
    const r = await env.DB.prepare("SELECT content FROM profile WHERE key = ?").bind(key).first();
    if (r) parts.push(r.content.slice(0, 1200));
  }
  const { results: mems } = await env.DB.prepare(
    `SELECT category, fact FROM memories
     WHERE category IN ('goal','skill','project','identity','preference') ORDER BY id LIMIT 40`).all();
  if (mems.length) parts.push(mems.map(m => `- (${m.category}) ${m.fact}`).join("\n"));
  return parts.join("\n\n") || "(the System knows little about them yet)";
}

function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- Quest generation ----------

const GEN_PROMPT = (persona, profile, goals, recent) => `You are ${persona.name}. Issue today's quests for the owner.
${voiceBlock(persona)}
A quest is ONE concrete action, done-or-not by tonight, that visibly moves a goal forward.
Not vague ("work on the project"), not busywork. If a goal is large, pick its next real
step. At most ${MAX_DAILY_QUESTS} quests across ALL goals — fewer is stronger. Skip a goal
entirely if today has no sensible step for it.

## The owner's active goals
${goals}

## Quests already issued recently — do NOT repeat these
${recent || "(none)"}

## What you know about them
${profile}

Return ONLY JSON:
{"quests":[{"goal_id": <id or null>, "text": "imperative, specific, checkable tonight", "kind": "daily|milestone|urgent"}]}`;

async function generateDailyQuests(env) {
  const { results: goals } = await env.DB.prepare(
    "SELECT id, title, why, target, deadline FROM goals WHERE status = 'active' ORDER BY id").all();
  if (!goals.length) return { none: true, created: [] };
  const goalText = goals.map(g =>
    `- #${g.id} ${g.title}${g.target ? ` (target: ${g.target})` : ""}` +
    `${g.deadline ? ` [by ${g.deadline}]` : ""}${g.why ? ` — why: ${g.why}` : ""}`).join("\n");
  const { results: recent } = await env.DB.prepare(
    "SELECT text FROM quests ORDER BY id DESC LIMIT 15").all();

  const persona = await getPersona(env);
  const { text, salvaged } = await llm(env,
    GEN_PROMPT(persona, await ownerProfile(env), goalText, recent.map(r => `- ${r.text}`).join("\n")));
  if (salvaged) return { error: "generation salvaged", created: [] };
  const v = parseJson(text);
  const list = Array.isArray(v?.quests) ? v.quests.slice(0, MAX_DAILY_QUESTS) : [];
  const created = [];
  for (const q of list) {
    const r = await createQuest(env, { goal_id: q.goal_id ?? null, text: q.text, kind: q.kind });
    if (r.ok) created.push(r);
  }
  return { created };
}

// ---------- Morning: issue the day's quests ----------

export async function issueDaily(env, tg, { force = false } = {}) {
  const t = ist();
  if (!force && await getState(env, "system_last_issue") === t.date) return { skipped: "already issued today" };

  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM goals WHERE status = 'active'").first();
  if (!active.n) {
    // The Awakening: without a goal there is nothing to drive toward. Demand one.
    await setState(env, "system_last_issue", t.date);
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML",
      text: `⚔️ <b>The System has no goals for you.</b>\n\nA hunter without a goal is prey. ` +
            `Tell me what you are trying to become — the role, the number, the deadline — and I will hold you to it.\n\n` +
            `Just say it, or use <code>/goals</code>.`,
    });
    return { awakening: true };
  }

  const gen = await generateDailyQuests(env);
  await setState(env, "system_last_issue", t.date);
  const created = gen.created || [];
  if (!created.length) return { skipped: gen.error || "no quests generated" };

  await logActivity(env, {
    kind: "quest_issued",
    summary: `Issued ${created.length} quest${created.length === 1 ? "" : "s"} for ${t.date}`,
    detail: created.map(c => `• ${c.text}`).join("\n"),
  });
  await tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML",
    text: `⚔️ <b>DAILY QUESTS — ${t.date}</b>\nClear them before the day ends. Failure has a cost.`,
  });
  for (const q of created) {
    const row = await env.DB.prepare("SELECT id, text, kind, xp FROM quests WHERE id = ?").bind(q.id).first();
    const sent = await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML",
      text: `▫️ <b>${esc(row.text)}</b>\n<i>${row.kind} · +${row.xp} XP</i>`,
      reply_markup: { inline_keyboard: [[
        { text: "✅ Done", callback_data: `q:${row.id}:done` },
        { text: "⏳ Doing", callback_data: `q:${row.id}:doing` },
        { text: "❌ Failed", callback_data: `q:${row.id}:failed` },
      ]]},
    });
    if (sent.ok) {
      await env.DB.prepare("UPDATE quests SET tg_message_id = ? WHERE id = ?")
        .bind(sent.result.message_id, row.id).run();
    }
  }
  return { issued: created.length };
}

// ---------- Night: the reckoning ----------

const DEBRIEF_PROMPT = (persona, facts) => `You are ${persona.name}, delivering tonight's reckoning.
${voiceBlock(persona)}
These are tonight's measured facts — the ONLY facts you have. Never invent a number.
${JSON.stringify(facts, null, 1)}

Write ONE short Telegram message. State plainly what they did and did not do. If they failed
quests, say it without softening — that is the job. If they cleared everything, acknowledge it
in one hard line, no gushing. End with what tomorrow demands. Plain text, <b>/<i> only, under 90 words.`;

export async function debrief(env, tg, { force = false } = {}) {
  const t = ist();
  if (!force && await getState(env, "system_last_debrief") === t.date) return { skipped: "already done today" };

  const { results: today } = await env.DB.prepare(
    "SELECT id, text, kind, status FROM quests WHERE date(issued_at, '+330 minutes') = date('now', '+330 minutes')").all();
  await setState(env, "system_last_debrief", t.date);
  if (!today.length) return { skipped: "no quests today" };

  // Unresolved quests at the reckoning are failures. Penalise each.
  let autoFailed = 0;
  for (const q of today) {
    if (q.status === "issued" || q.status === "doing") {
      await env.DB.prepare("UPDATE quests SET status = 'failed', resolved_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), q.id).run();
      await addXp(env, -FAIL_PENALTY);
      q.status = "failed"; autoFailed++;
    }
  }
  const done = today.filter(q => q.status === "done").length;
  const failed = today.filter(q => q.status === "failed").length;
  const allCleared = failed === 0 && done > 0;

  // Streak: a clean day extends it; any failure resets it to zero.
  let streak = allCleared ? Number(await getState(env, "streak") || 0) + 1 : 0;
  await setState(env, "streak", streak);
  if (streak > Number(await getState(env, "streak_best") || 0)) await setState(env, "streak_best", streak);

  const st = await getSystemState(env);
  const facts = {
    date: t.date, done, failed, auto_failed_for_inaction: autoFailed,
    quests: today.map(q => ({ text: q.text, status: q.status })),
    streak_days: streak, level: st.level, xp: st.xp,
  };
  await logActivity(env, {
    kind: "reckoning",
    summary: `Reckoning ${t.date}: ${done}/${today.length} cleared, ${failed} failed · streak ${streak}`,
    detail: today.map(q => `${q.status === "done" ? "✅" : q.status === "failed" ? "❌" : "•"} ${q.text}`).join("\n"),
  });
  const { text, salvaged } = await llm(env, DEBRIEF_PROMPT(await getPersona(env), facts));
  const body = (!salvaged && text.trim())
    ? text.slice(0, 1500)
    : `${done}/${today.length} done, ${failed} failed. Streak: ${streak} ${streak ? "🔥" : "— broken"}. Level ${st.level}.`;

  const r = await tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML",
    text: `🌑 <b>Reckoning — ${t.date}</b>\n\n${body}`, disable_web_page_preview: true,
  });
  if (!r.ok) {
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID, text: `🌑 Reckoning — ${t.date}\n\n${body.replace(/<[^>]+>/g, "")}`,
    });
  }
  return { done, failed, streak, level: st.level };
}

// ---------- Cron entry ----------

export async function runSystem(env, tg, { force = false } = {}) {
  const t = ist();
  const out = {};
  if (force || t.hour === ISSUE_HOUR) out.issue = await issueDaily(env, tg, { force });
  if (force || t.hour === DEBRIEF_HOUR) out.debrief = await debrief(env, tg, { force });
  if (!out.issue && !out.debrief) out.skipped = `hour ${t.hour} (issue ${ISSUE_HOUR}, debrief ${DEBRIEF_HOUR} IST)`;
  return out;
}

// ---------- Agent tools ----------

export const SYSTEM_TOOLS = {
  set_goal: {
    group: "Goals & Quests",
    desc: 'declare a goal the System will drive them toward. args: {"title": "...", "why": "why it matters", "target": "measurable success", "deadline": "YYYY-MM-DD or null"}',
    run: (env, a) => createGoal(env, a),
  },
  list_goals: {
    group: "Goals & Quests",
    desc: 'the owner\'s goals and progress. args: {"status": "active|all"}',
    run: (env, a) => listGoals(env, a),
  },
  update_goal: {
    group: "Goals & Quests",
    desc: 'edit a goal or mark it achieved/dropped. args: {"id": <n>, "title?": "...", "why?": "...", "target?": "...", "deadline?": "...", "status?": "active|achieved|dropped"}',
    run: (env, a) => a.id ? updateGoal(env, a.id, a) : { error: "need the goal id" },
  },
  drop_goal: {
    group: "Goals & Quests",
    desc: 'stop driving toward a goal. args: {"id": <n>}',
    run: (env, a) => a.id ? updateGoal(env, a.id, { status: "dropped" }) : { error: "need the goal id" },
  },
  add_quest: {
    group: "Goals & Quests",
    desc: 'set a concrete quest (a done-tonight task). args: {"text": "...", "goal_id": <n or null>, "kind": "daily|milestone|urgent"}',
    run: (env, a) => createQuest(env, a),
  },
  list_quests: {
    group: "Goals & Quests",
    desc: 'quests. args: {"status": "today|open|all"}',
    run: (env, a) => listQuests(env, a),
  },
  complete_quest: {
    group: "Goals & Quests",
    desc: 'resolve a quest by id. args: {"id": <n>, "action": "done|doing|failed|skipped"}',
    run: (env, a) => a.id ? resolveQuest(env, a.id, a.action || "done") : { error: "need the quest id" },
  },
  get_rank: {
    group: "Goals & Quests",
    desc: "the owner's level, XP, and streak. args: {}",
    run: (env) => getSystemState(env),
  },
};
