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
const AUTONOMY_HOUR = 13;   // IST — the daily autonomous "ponder" tick
const QUIET_START = 22, QUIET_END = 7;   // IST — no unscheduled messages in this window
const AUTONOMY_BUDGET = 3;  // max self-directed actions per day
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

export async function logActivity(env, { kind, summary, detail = null, reasoning = null, actor = "system", goal_id = null, quest_id = null }) {
  try {
    await env.DB.prepare(
      "INSERT INTO activity (at, kind, actor, summary, detail, reasoning, goal_id, quest_id) VALUES (?,?,?,?,?,?,?,?)")
      .bind(new Date().toISOString(), kind, actor, String(summary).slice(0, 300),
            detail ? String(detail).slice(0, 1000) : null,
            reasoning ? String(reasoning).slice(0, 400) : null,
            goal_id ? Number(goal_id) : null, quest_id ? Number(quest_id) : null).run();
  } catch (e) {
    console.log("logActivity failed:", String(e).slice(0, 120));
  }
}

// ---------- Metrics: arbitrary numbers the agent tracks + the dashboard charts ----------

export async function logMetric(env, { name, value, unit = null, note = null, goal_id = null, at = null }) {
  name = String(name || "").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
  const v = Number(value);
  if (!name) return { error: "a metric needs a name" };
  if (!isFinite(v)) return { error: "value must be a number" };
  await env.DB.prepare(
    "INSERT INTO metrics (name, value, unit, note, goal_id, at) VALUES (?,?,?,?,?,?)")
    .bind(name, v, unit ? String(unit).slice(0, 12) : null, note ? String(note).slice(0, 200) : null,
          goal_id ? Number(goal_id) : null, at || new Date().toISOString()).run();
  await logActivity(env, {
    kind: "metric", actor: "owner", goal_id: goal_id ? Number(goal_id) : null,
    summary: `Logged ${name}: ${v}${unit ? " " + unit : ""}`,
  });
  const prev = await env.DB.prepare(
    "SELECT value FROM metrics WHERE name = ? ORDER BY at DESC LIMIT 1 OFFSET 1").bind(name).first();
  return { ok: true, name, value: v, change_since_last: prev ? Math.round((v - prev.value) * 100) / 100 : null };
}

export async function listMetrics(env, { name = null, limit = 300 } = {}) {
  if (name) {
    const { results } = await env.DB.prepare(
      "SELECT name, value, unit, note, at FROM metrics WHERE name = ? ORDER BY at DESC LIMIT ?")
      .bind(String(name).toLowerCase(), Math.min(limit, 500)).all();
    return { name, points: results.reverse() };
  }
  const { results } = await env.DB.prepare(
    "SELECT name, value, unit, at FROM metrics ORDER BY at DESC LIMIT ?").bind(Math.min(limit, 500)).all();
  return { count: results.length, metrics: results.reverse() };   // oldest-first, ready to chart
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

// ---------- Temporal context: the agent always knows what day it is ----------

const MS_DAY = 86400000;
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / MS_DAY);
const istToday = () => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric",
}).format(new Date());

// The true, code-computed time facts, spread into every reasoning prompt. Never guessed
// by the model — this is what turns a pep-talk into "you set this 12 days ago, deadline
// in 40, you're behind pace."
export async function clockContext(env, goal = null) {
  const t = ist();
  const nowIso = new Date().toISOString();
  const c = { today: istToday(), now_ist: `${t.date} ${String(t.hour).padStart(2, "0")}:00 IST` };
  if (goal) {
    c.goal_age_days = Math.max(0, daysBetween(goal.created_at, nowIso));
    c.progress = Math.round((goal.progress || 0) * 100) / 100;
    if (goal.deadline) {
      const total = Math.max(1, daysBetween(goal.created_at, goal.deadline));
      c.days_to_deadline = daysBetween(nowIso, goal.deadline);
      c.runway_used_pct = Math.round((c.goal_age_days / total) * 100);
    }
  }
  const last = await env.DB.prepare("SELECT MAX(resolved_at) AS at FROM quests WHERE status = 'done'").first();
  if (last?.at) c.days_since_last_cleared = daysBetween(last.at, nowIso);
  c.streak = Number(await getState(env, "streak") || 0);
  return c;
}

// ---------- Progress & pace (pure SQL + arithmetic — never a model call) ----------

export async function computeProgress(env, goalId) {
  if (!goalId) return { progress: 0 };
  const ms = (await env.DB.prepare(
    "SELECT id, status FROM milestones WHERE goal_id = ? ORDER BY seq").bind(goalId).all()).results;
  let progress;
  if (ms.length) {
    const done = ms.filter(m => m.status === "done").length;
    const active = ms.find(m => m.status === "active");
    let activeRatio = 0;
    if (active) {
      const q = await env.DB.prepare(
        "SELECT COUNT(*) AS n, SUM(status = 'done') AS d FROM quests WHERE milestone_id = ?").bind(active.id).first();
      activeRatio = q.n ? (q.d || 0) / q.n : 0;
    }
    progress = (done + activeRatio) / ms.length;
  } else {
    // No roadmap yet — fall back to quest completion for the goal.
    const q = await env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(status = 'done') AS d FROM quests WHERE goal_id = ?").bind(goalId).first();
    progress = q.n ? (q.d || 0) / q.n : 0;
  }
  progress = Math.max(0, Math.min(1, progress));
  await env.DB.prepare("UPDATE goals SET progress = ?, updated_at = ? WHERE id = ?")
    .bind(progress, new Date().toISOString(), goalId).run();
  return { progress };
}

// progress vs how much of the runway has burned → on-track / behind / at-risk + projection.
export function paceOf(goal) {
  const progress = goal.progress || 0;
  if (!goal.deadline || !goal.created_at) return { progress, pace: "no-deadline" };
  const total = Math.max(1, daysBetween(goal.created_at, goal.deadline));
  const elapsedDays = Math.max(0, daysBetween(goal.created_at, new Date().toISOString()));
  const elapsed = Math.min(1, elapsedDays / total);
  const delta = progress - elapsed;
  const pace = delta >= 0.10 ? "ahead" : delta >= -0.10 ? "on-track" : delta >= -0.25 ? "behind" : "at-risk";
  let projected = null;
  if (progress > 0.02) {
    projected = new Date(new Date(goal.created_at).getTime() + Math.round(elapsedDays / progress) * MS_DAY)
      .toISOString().slice(0, 10);
  }
  return { progress, pace, projected, days_left: daysBetween(new Date().toISOString(), goal.deadline) };
}

// ---------- Milestones: the persistent roadmap ----------

export async function listMilestones(env, goalId) {
  const { results } = await env.DB.prepare(
    "SELECT id, goal_id, seq, title, done_when, target_date, status, done_at FROM milestones WHERE goal_id = ? ORDER BY seq")
    .bind(goalId).all();
  return results;
}
async function activeMilestone(env, goalId) {
  return env.DB.prepare(
    "SELECT * FROM milestones WHERE goal_id = ? AND status = 'active' ORDER BY seq LIMIT 1").bind(goalId).first();
}

// Advance the active milestone when its quests are substantially cleared.
async function advanceMilestones(env, goalId) {
  const active = await activeMilestone(env, goalId);
  if (!active) return;
  const q = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(status='done') AS d, SUM(status IN ('issued','doing')) AS open
     FROM quests WHERE milestone_id = ?`).bind(active.id).first();
  if (q.n >= 2 && (q.open || 0) === 0 && (q.d || 0) >= Math.ceil(q.n * 0.6)) {
    await env.DB.prepare("UPDATE milestones SET status = 'done', done_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), active.id).run();
    const next = await env.DB.prepare(
      "SELECT id, title FROM milestones WHERE goal_id = ? AND status = 'pending' ORDER BY seq LIMIT 1")
      .bind(goalId).first();
    if (next) await env.DB.prepare("UPDATE milestones SET status = 'active' WHERE id = ?").bind(next.id).run();
    await logActivity(env, {
      kind: "milestone_done", goal_id: goalId,
      summary: `Milestone cleared: ${active.title}`,
      detail: next ? `Now on: ${next.title}` : "Final milestone — the goal is within reach.",
    });
  }
}

// ---------- The planner: a goal becomes a route ----------

const PLAN_PROMPT = (persona, clock, goal, profile) => `You are ${persona.name}, mapping the route to a goal.
${voiceBlock(persona)}
It is ${clock.today}. This goal was set ${clock.goal_age_days === 0 ? "today" : clock.goal_age_days + " days ago"}${goal.deadline ? `, deadline ${goal.deadline} (${clock.days_to_deadline} days out)` : " (no deadline set)"}.

## The goal
${goal.title}${goal.target ? `\nTarget: ${goal.target}` : ""}${goal.why ? `\nWhy: ${goal.why}` : ""}

## Who it's for
${profile}

Break this into an ORDERED route of 3-6 concrete milestones — the real checkpoints between here
and done, each with a clear definition of done. The first must be startable this week. Space the
target dates across the runway${goal.deadline ? " up to the deadline" : " (assume ~8-12 weeks)"}.
Be specific to THIS goal and person; no generic filler.

Return ONLY JSON:
{"reasoning":"one or two sentences on the route you chose",
 "milestones":[{"title":"...","done_when":"how you'll know it's complete","weeks_from_now":<number>}]}`;

// Idempotent: no-ops if the goal already has milestones. Called from createGoal and lazily
// at issuance, so a goal is always planned before its first quests.
export async function planGoal(env, goalId) {
 try {
  const goal = await env.DB.prepare("SELECT * FROM goals WHERE id = ?").bind(goalId).first();
  if (!goal || goal.status !== "active") return { skipped: "no active goal" };
  const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM milestones WHERE goal_id = ?").bind(goalId).first();
  if (have.n) return { skipped: "already planned" };
  const { text, salvaged } = await llm(env,
    PLAN_PROMPT(await getPersona(env), await clockContext(env, goal), goal, await ownerProfile(env)));
  if (salvaged) return { error: "planner salvaged" };
  const v = parseJson(text);
  const list = Array.isArray(v?.milestones) ? v.milestones.slice(0, 8) : [];
  if (!list.length) return { error: "no milestones produced" };
  const now = new Date().toISOString();
  const deadlineMs = goal.deadline ? new Date(goal.deadline).getTime() : null;
  let seq = 1, prevWeeks = 0;
  for (const m of list) {
    if (!m.title) continue;
    // Keep target dates in order: each milestone lands at least half a week after the
    // previous one (the model sometimes returns weeks_from_now out of order), and never
    // past the goal's deadline.
    let weeks = Number(m.weeks_from_now);
    if (!isFinite(weeks) || weeks <= 0) weeks = prevWeeks + 2;
    if (weeks < prevWeeks + 0.5) weeks = prevWeeks + 0.5;
    prevWeeks = weeks;
    let targetMs = Date.now() + weeks * 7 * MS_DAY;
    if (deadlineMs && targetMs > deadlineMs) targetMs = deadlineMs;
    const target = new Date(targetMs).toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO milestones (goal_id, seq, title, done_when, target_date, status, created_at)
       VALUES (?,?,?,?,?,?,?)`)
      .bind(goalId, seq, String(m.title).slice(0, 200), String(m.done_when || "").slice(0, 300) || null,
            target, seq === 1 ? "active" : "pending", now).run();
    seq++;
  }
  await computeProgress(env, goalId);
  await logActivity(env, {
    kind: "plan", goal_id: goalId,
    summary: `Mapped a ${seq - 1}-step route to: ${goal.title}`,
    detail: list.map((m, i) => `${i + 1}. ${m.title}`).join("\n"),
    reasoning: v.reasoning ? String(v.reasoning).slice(0, 300) : null,
  });
  return { ok: true, milestones: seq - 1 };
 } catch (e) {
  console.log("planGoal threw:", String(e && e.stack || e).slice(0, 300));
  return { error: "planner failed: " + String(e && e.message || e).slice(0, 160) };
 }
}

// Discard a goal's roadmap and map a fresh one. Quests FK milestones(id), so their
// links must be detached before the milestones can be deleted.
export async function replanGoal(env, goalId) {
  goalId = Number(goalId);
  await env.DB.prepare(
    "UPDATE quests SET milestone_id = NULL WHERE milestone_id IN (SELECT id FROM milestones WHERE goal_id = ?)")
    .bind(goalId).run();
  await env.DB.prepare("DELETE FROM milestones WHERE goal_id = ?").bind(goalId).run();
  return planGoal(env, goalId);
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
    kind: "goal", actor: "owner", goal_id: row.id,
    summary: `New goal set: ${title}`,
    detail: [target && `Target: ${target}`, deadline && `By ${deadline}`, why].filter(Boolean).join(" · ") || null,
  });
  // Map the route immediately so the roadmap is there the moment the goal lands. One LLM
  // call; wrapped so a planner failure never blocks goal creation (it re-plans lazily at issuance).
  let planned = 0;
  try { planned = (await planGoal(env, row.id)).milestones || 0; }
  catch (e) { console.log("planGoal failed:", String(e).slice(0, 120)); }
  return { ok: true, id: row.id, title, milestones: planned, note: "Route mapped — The System will drive you at it." };
}

export async function listGoals(env, { status = "active" } = {}) {
  const where = status === "all" ? "" : "WHERE status = ?";
  const binds = status === "all" ? [] : [status];
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title, g.why, g.target, g.deadline, g.status, g.created_at, g.progress,
            (SELECT COUNT(*) FROM quests q WHERE q.goal_id = g.id AND q.status = 'done') AS quests_done,
            (SELECT COUNT(*) FROM quests q WHERE q.goal_id = g.id AND q.status = 'failed') AS quests_failed
     FROM goals g ${where} ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.id`)
    .bind(...binds).all();
  return { count: results.length, goals: results.map(g => ({ ...g, ...paceOf(g) })) };
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

export async function createQuest(env, { goal_id = null, milestone_id = null, text, kind = "daily", due_at }) {
  text = String(text || "").trim();
  if (!text) return { error: "a quest needs text" };
  const k = QUEST_KINDS.includes(kind) ? kind : "daily";
  const row = await env.DB.prepare(
    `INSERT INTO quests (goal_id, milestone_id, text, kind, status, xp, due_at, issued_at)
     VALUES (?,?,?,?, 'issued', ?, ?, ?) RETURNING id`)
    .bind(goal_id ? Number(goal_id) : null, milestone_id ? Number(milestone_id) : null,
          text.slice(0, 300), k, XP_BY_KIND[k],
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
      kind: status === "done" ? "quest_done" : "quest_failed", actor: "owner", quest_id: q.id, goal_id: q.goal_id,
      summary: `${status === "done" ? "Cleared" : "Failed"} quest: ${q.text}`,
      detail: `${delta >= 0 ? "+" : ""}${delta} XP → level ${st.level}`,
    });
  }
  // A resolved quest moves goal progress and can advance the active milestone.
  if (q.goal_id) {
    await computeProgress(env, q.goal_id);
    await advanceMilestones(env, q.goal_id);
    await computeProgress(env, q.goal_id);
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

const GEN_PROMPT = (persona, clock, profile, goals, recent) => `You are ${persona.name}. Issue today's quests for the owner.
${voiceBlock(persona)}
Today is ${clock.today}.${clock.days_since_last_cleared != null ? ` It has been ${clock.days_since_last_cleared} day(s) since they last cleared a quest.` : ""} Current streak: ${clock.streak}.

A quest is ONE concrete action, done-or-not by tonight, that advances the CURRENT MILESTONE of
a goal. Not vague ("work on the project"), not busywork. At most ${MAX_DAILY_QUESTS} quests across
ALL goals — fewer is stronger. Prioritise goals that are behind pace. Skip a goal with no sensible
step today.

## Active goals and their current milestone
${goals}

## Quests already issued recently — do NOT repeat these
${recent || "(none)"}

## What you know about them
${profile}

Return ONLY JSON:
{"quests":[{"goal_id": <id or null>, "text": "imperative, specific, checkable tonight", "kind": "daily|milestone|urgent"}]}`;

async function generateDailyQuests(env) {
  const { results: goals } = await env.DB.prepare(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY id").all();
  if (!goals.length) return { none: true, created: [] };

  // Ensure every active goal has a roadmap, then aim quests at each one's active milestone.
  const activeMs = {};   // goal_id -> active milestone row
  const blocks = [];
  for (const g of goals) {
    try { await planGoal(env, g.id); } catch { /* lazy plan is best-effort */ }
    const m = await activeMilestone(env, g.id);
    activeMs[g.id] = m;
    const p = paceOf(g);
    blocks.push(
      `- #${g.id} ${g.title}${g.target ? ` (target: ${g.target})` : ""}` +
      `${g.deadline ? ` [deadline ${g.deadline} · ${p.days_left}d left · ${p.pace} · ${Math.round((g.progress || 0) * 100)}% done]` : ""}` +
      (m ? `\n    → current milestone: ${m.title}${m.done_when ? ` — done when: ${m.done_when}` : ""}${m.target_date ? ` (by ${m.target_date})` : ""}`
         : `\n    → no milestone yet; pick a concrete first step`));
  }
  const { results: recent } = await env.DB.prepare(
    "SELECT text FROM quests ORDER BY id DESC LIMIT 15").all();

  const persona = await getPersona(env);
  const { text, salvaged } = await llm(env, GEN_PROMPT(
    persona, await clockContext(env, null), await ownerProfile(env),
    blocks.join("\n"), recent.map(r => `- ${r.text}`).join("\n")));
  if (salvaged) return { error: "generation salvaged", created: [] };
  const v = parseJson(text);
  const list = Array.isArray(v?.quests) ? v.quests.slice(0, MAX_DAILY_QUESTS) : [];
  const created = [];
  for (const q of list) {
    const gid = q.goal_id ?? null;
    const r = await createQuest(env, { goal_id: gid, milestone_id: gid ? activeMs[gid]?.id : null, text: q.text, kind: q.kind });
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

  // Roll progress + milestones forward for every active goal after tonight's resolutions.
  for (const g of (await env.DB.prepare("SELECT id FROM goals WHERE status = 'active'").all()).results) {
    await computeProgress(env, g.id);
    await advanceMilestones(env, g.id);
  }

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

// ---------- Autonomy: the daily "ponder" tick ----------
//
// Once a day the System reasons over its own state and takes ONE useful, low-cost move.
// Bounded by a mode (off | suggest | act), a daily action budget, quiet hours, and
// dedup — and every move is logged with its reasoning, so nothing it does is a mystery.

export async function getAutonomyMode(env) {
  const m = await getState(env, "autonomy_mode");
  return ["off", "suggest", "act"].includes(m) ? m : "suggest";  // default: suggest-only
}
export async function setAutonomyMode(env, mode) {
  const m = ["off", "suggest", "act"].includes(mode) ? mode : "suggest";
  await setState(env, "autonomy_mode", m);
  return { autonomy_mode: m };
}
async function autonomyBudget(env) {
  const key = "autonomy_budget_" + ist().date;
  const used = Number(await getState(env, key) || 0);
  return { key, used, left: Math.max(0, AUTONOMY_BUDGET - used) };
}
export async function getSettings(env) {
  const b = await autonomyBudget(env);
  return { autonomy_mode: await getAutonomyMode(env), autonomy_budget: AUTONOMY_BUDGET, autonomy_left_today: b.left };
}

const PONDER_PROMPT = (persona, clock, mode, goals, recentAct, recentRes) => `You are ${persona.name}, taking your daily autonomous action. No one asked — you decide the single most useful thing to do RIGHT NOW to move the owner's goals forward.
${voiceBlock(persona)}
It is ${clock.today}. Mode: "${mode}" (suggest = you may research and message findings, and PROPOSE plan changes, but not silently change tasks; act = you may also add a task).

## The owner's goals — progress · pace
${goals}

## What you've done recently — do NOT repeat
${recentAct || "(nothing)"}

## Research already run — do NOT repeat
${recentRes || "(none)"}

Most days one small move is enough; some days the right move is none. Pick ONE:
- "research": dig into an open question blocking the current milestone. Provide "query".
- "nudge": one pointed message, ONLY if they're slipping / behind pace. Provide "message".
- "stretch_quest": add one extra task toward the active milestone (act mode only). Provide "quest" + "goal_id".
- "replan": the route looks off — propose revisiting it. Provide "goal_id".
- "none": nothing is worth an interruption today.

Return ONLY JSON:
{"action":"research|nudge|stretch_quest|replan|none","goal_id":<id or null>,"query":"...","message":"...","quest":"...","reasoning":"one sentence: why this","summary":"one line for the activity log"}`;

export async function autonomyTick(env, tg, { force = false, spawn = null } = {}) {
  const t = ist();
  const mode = await getAutonomyMode(env);
  if (mode === "off") return { skipped: "autonomy off" };
  if (!force && t.hour !== AUTONOMY_HOUR) return { skipped: `hour ${t.hour} != ${AUTONOMY_HOUR}` };
  if (!force && await getState(env, "autonomy_last") === t.date) return { skipped: "already ran today" };
  const budget = await autonomyBudget(env);
  if (budget.left <= 0) { await setState(env, "autonomy_last", t.date); return { skipped: "budget spent" }; }

  const { results: goals } = await env.DB.prepare(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY id").all();
  if (!goals.length) { await setState(env, "autonomy_last", t.date); return { skipped: "no active goals" }; }

  const clock = await clockContext(env, null);
  const goalLines = [];
  for (const g of goals) {
    const m = await activeMilestone(env, g.id);
    const p = paceOf(g);
    goalLines.push(`#${g.id} ${g.title} — ${Math.round((g.progress || 0) * 100)}% · ${p.pace}` +
      `${g.deadline ? ` · ${p.days_left}d left` : ""}${m ? ` · milestone: ${m.title}` : ""}`);
  }
  const recentAct = (await env.DB.prepare(
    "SELECT kind, summary FROM activity ORDER BY id DESC LIMIT 12").all()).results;
  const recentRes = (await env.DB.prepare(
    "SELECT question FROM research ORDER BY id DESC LIMIT 8").all()).results;

  const { text, salvaged } = await llm(env, PONDER_PROMPT(
    await getPersona(env), clock, mode, goalLines.join("\n"),
    recentAct.map(a => `- ${a.kind}: ${a.summary}`).join("\n"),
    recentRes.map(r => `- ${r.question}`).join("\n")));
  await setState(env, "autonomy_last", t.date);
  const v = salvaged ? null : parseJson(text);
  if (!v || !v.action || v.action === "none") {
    return { skipped: "pondered — nothing worth doing", reasoning: v?.reasoning };
  }

  const reasoning = String(v.reasoning || "").slice(0, 300);
  const goalId = Number(v.goal_id) || null;
  const quiet = t.hour >= QUIET_START || t.hour < QUIET_END;
  let action = v.action, outcome;
  try {
    if (action === "research" && v.query && spawn) {
      const q = String(v.query).slice(0, 300);
      if (recentRes.some(r => (r.question || "").toLowerCase() === q.toLowerCase())) outcome = { skipped: "duplicate research" };
      else outcome = await spawn(env, { question: q, depth: "normal" });
    } else if (action === "nudge" && v.message && !quiet) {
      await tg(env, "sendMessage", {
        chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", disable_web_page_preview: true,
        text: `⚡ <b>The System</b>\n\n${String(v.message).slice(0, 700)}`,
      });
      outcome = { nudged: true };
    } else if (action === "stretch_quest" && v.quest && goalId && mode === "act") {
      const m = await activeMilestone(env, goalId);
      const r = await createQuest(env, { goal_id: goalId, milestone_id: m?.id, text: String(v.quest).slice(0, 300), kind: "daily" });
      outcome = r.ok ? { added_quest: r.id } : { error: r.error };
    } else if (action === "replan") {
      outcome = { proposed: "re-plan (owner confirms)" };   // surfaced in the feed; not executed silently
    } else {
      outcome = { skipped: mode !== "act" && action === "stretch_quest" ? "suggest-mode won't act silently" : "unactionable" };
    }
  } catch (e) {
    outcome = { error: String(e).slice(0, 150) };
  }

  await setState(env, budget.key, budget.used + 1);
  await logActivity(env, {
    kind: "autonomous", actor: "system", goal_id: goalId,
    summary: v.summary ? String(v.summary).slice(0, 200) : `Autonomous action: ${action}`,
    detail: outcome ? JSON.stringify(outcome).slice(0, 200) : null, reasoning,
  });
  return { action, outcome, reasoning };
}

// ---------- Cron entry ----------

export async function runSystem(env, tg, { force = false, spawn = null } = {}) {
  const t = ist();
  const out = {};
  if (force || t.hour === ISSUE_HOUR) out.issue = await issueDaily(env, tg, { force });
  if (force || t.hour === AUTONOMY_HOUR) out.autonomy = await autonomyTick(env, tg, { force, spawn });
  if (force || t.hour === DEBRIEF_HOUR) out.debrief = await debrief(env, tg, { force });
  if (!out.issue && !out.debrief && !out.autonomy) {
    out.skipped = `hour ${t.hour} (issue ${ISSUE_HOUR}, ponder ${AUTONOMY_HOUR}, debrief ${DEBRIEF_HOUR} IST)`;
  }
  return out;
}

// ---------- Agent tools ----------

export const SYSTEM_TOOLS = {
  set_goal: {
    group: "Goals & Quests",
    desc: 'declare a goal the System will drive them toward. args: {"title": "...", "why": "why it matters", "target": "measurable success", "deadline": "YYYY-MM-DD or null"}',
    args: { title: { type: "string", required: true }, why: { type: "string" }, target: { type: "string" }, deadline: { type: "string" } },
    run: (env, a) => createGoal(env, a),
  },
  list_goals: {
    group: "Goals & Quests",
    desc: 'the owner\'s goals and progress. args: {"status": "active|all"}',
    run: (env, a) => listGoals(env, a),
  },
  list_milestones: {
    group: "Goals & Quests",
    desc: 'the roadmap (ordered milestones) for a goal. args: {"goal_id": <n>}',
    args: { goal_id: { type: "number", required: true } },
    run: async (env, a) => a.goal_id
      ? { goal_id: a.goal_id, milestones: await listMilestones(env, a.goal_id) }
      : { error: "need the goal id" },
  },
  replan_goal: {
    group: "Goals & Quests",
    desc: 'discard a goal\'s roadmap and map a fresh one (use when the route is off). args: {"goal_id": <n>}',
    args: { goal_id: { type: "number", required: true } },
    run: (env, a) => a.goal_id ? replanGoal(env, a.goal_id) : { error: "need the goal id" },
  },
  update_goal: {
    group: "Goals & Quests",
    desc: 'edit a goal or mark it achieved/dropped. args: {"id": <n>, "title?": "...", "why?": "...", "target?": "...", "deadline?": "...", "status?": "active|achieved|dropped"}',
    args: { id: { type: "number", required: true }, status: { type: "string", enum: ["active", "achieved", "dropped"] } },
    run: (env, a) => a.id ? updateGoal(env, a.id, a) : { error: "need the goal id" },
  },
  drop_goal: {
    group: "Goals & Quests",
    desc: 'stop driving toward a goal. args: {"id": <n>}',
    args: { id: { type: "number", required: true } },
    run: (env, a) => a.id ? updateGoal(env, a.id, { status: "dropped" }) : { error: "need the goal id" },
  },
  add_quest: {
    group: "Goals & Quests",
    desc: 'set a concrete quest (a done-tonight task). args: {"text": "...", "goal_id": <n or null>, "kind": "daily|milestone|urgent"}',
    args: { text: { type: "string", required: true }, goal_id: { type: "number" }, kind: { type: "string", enum: QUEST_KINDS } },
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
    args: { id: { type: "number", required: true }, action: { type: "string", enum: ["done", "doing", "failed", "skipped"] } },
    run: (env, a) => a.id ? resolveQuest(env, a.id, a.action || "done") : { error: "need the quest id" },
  },
  get_rank: {
    group: "Goals & Quests",
    desc: "the owner's level, XP, and streak. args: {}",
    run: (env) => getSystemState(env),
  },
  log_metric: {
    group: "Metrics",
    desc: 'record a numeric data point to track over time — weight, MRR/revenue, leetcode solved, minutes practiced, reps, anything. It gets charted on the dashboard. args: {"name": "mrr", "value": 250, "unit": "$", "note": "...", "goal_id": <n or null>}',
    args: { name: { type: "string", required: true }, value: { type: "number", required: true }, unit: { type: "string" }, note: { type: "string" }, goal_id: { type: "number" } },
    run: (env, a) => logMetric(env, a),
  },
  list_metrics: {
    group: "Metrics",
    desc: 'read logged metrics. args: {"name": "mrr"} for one series over time, or {} for recent across all',
    run: (env, a) => listMetrics(env, a),
  },
};
