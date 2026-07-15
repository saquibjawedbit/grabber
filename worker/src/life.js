// Phase 5: money, body, people — the domains that make this a personal agent
// rather than a job bot.
//
// BOUNDARY: everything here is read and written by the Worker only. No GitHub
// Actions job may touch these tables while the repo is public — build logs are
// public, and this is where the owner's bank balance lives.

import { llm } from "./llm.js";

const CATEGORIES = ["food", "transport", "rent", "shopping", "subscription",
                    "bills", "health", "education", "income", "transfer", "other"];
const RELATIONS = ["friend", "family", "recruiter", "founder", "mentor", "colleague", "dating"];

const nowIso = () => new Date().toISOString();

// ---------- Bank notifications become transactions, cheaply ----------

async function categorise(env, counterparty, note) {
  const hay = `${counterparty || ""} ${note || ""}`.toLowerCase();
  const { results } = await env.DB.prepare("SELECT pattern, category FROM merchant_category").all();
  const hit = results.find(r => hay.includes(r.pattern));
  if (hit) return hit.category;
  if (!counterparty) return "other";

  // Unknown merchant: ask once, then remember it forever.
  const { text } = await llm(env,
    `Categorise one payment for a personal finance tracker in India.\n` +
    `Merchant/counterparty: "${counterparty}"\n\n` +
    `Reply with ONE word from this list and nothing else: ${CATEGORIES.join(", ")}`);
  const guess = CATEGORIES.find(c => text.toLowerCase().includes(c)) || "other";
  const key = counterparty.toLowerCase().split(/\s+/)[0].slice(0, 40);
  if (key.length >= 3 && guess !== "other") {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO merchant_category (pattern, category, created_at) VALUES (?,?,?)")
      .bind(key, guess, nowIso()).run();
  }
  return guess;
}

// Phase 4 files bank notifications; this turns the parsed ones into money.
export async function processBankNotifications(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, title, body, amount, direction, counterparty, received_at, app
    FROM notifications
    WHERE kind = 'bank' AND amount IS NOT NULL AND surfaced = 0
    ORDER BY id LIMIT 25`).all();
  let made = 0;
  for (const n of results) {
    const category = await categorise(env, n.counterparty, `${n.title} ${n.body}`);
    await env.DB.prepare(
      `INSERT INTO transactions (amount, direction, counterparty, category, account, note, at,
                                 source, notification_id)
       VALUES (?,?,?,?,?,?,?,'notification',?)`)
      .bind(n.amount, n.direction, n.counterparty, category, n.app,
            (n.body || "").slice(0, 200), n.received_at, n.id).run();
    await env.DB.prepare("UPDATE notifications SET surfaced = 1 WHERE id = ?").bind(n.id).run();
    made++;
  }
  return { transactions_created: made };
}

async function netWorth(env) {
  const acc = await env.DB.prepare(
    "SELECT COALESCE(SUM(balance), 0) AS v FROM accounts WHERE kind != 'card'").first();
  const cards = await env.DB.prepare(
    "SELECT COALESCE(SUM(balance), 0) AS v FROM accounts WHERE kind = 'card'").first();
  const assets = await env.DB.prepare(
    "SELECT COALESCE(SUM(value), 0) AS v FROM holdings WHERE kind = 'asset'").first();
  const liab = await env.DB.prepare(
    "SELECT COALESCE(SUM(value), 0) AS v FROM holdings WHERE kind = 'liability'").first();
  // Card balances are money owed, however they're entered.
  const owed = Math.abs(cards.v) + liab.v;
  return { cash: acc.v, assets: assets.v, owed, net: acc.v + assets.v - owed };
}

export const LIFE_TOOLS = {
  // --- Money ---

  net_worth: {
    group: "Money",
    desc: "the owner's whole financial position in one number: cash, investments, what they owe. args: {}",
    run: async (env) => {
      const n = await netWorth(env);
      const { results: accounts } = await env.DB.prepare(
        "SELECT name, kind, balance, updated_at FROM accounts ORDER BY balance DESC").all();
      const { results: holdings } = await env.DB.prepare(
        "SELECT name, kind, category, value FROM holdings ORDER BY value DESC").all();
      if (!accounts.length && !holdings.length) {
        return { error: "nothing on file — ask the owner what accounts and investments they have, then set_account / set_holding" };
      }
      return { ...n, currency: "INR", accounts, holdings };
    },
  },

  set_account: {
    group: "Money",
    desc: 'record or update an account balance. args: {"name": "HDFC savings", "kind": "bank|wallet|investment|card", "balance": 96400}',
    run: async (env, args) => {
      const name = String(args.name || "").trim();
      const kind = ["bank", "wallet", "investment", "card"].includes(args.kind) ? args.kind : "bank";
      const balance = Number(args.balance);
      if (!name || !isFinite(balance)) return { error: "need a name and a numeric balance" };
      await env.DB.prepare(
        `INSERT INTO accounts (name, kind, balance, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, balance = excluded.balance,
                                         updated_at = excluded.updated_at`)
        .bind(name.slice(0, 60), kind, balance, nowIso()).run();
      return { ok: true, ...(await netWorth(env)) };
    },
  },

  set_holding: {
    group: "Money",
    desc: 'record an asset or a debt. args: {"name": "Zerodha portfolio", "kind": "asset|liability", "category": "investment|property|vehicle|loan|card_debt|other", "value": 92800}',
    run: async (env, args) => {
      const name = String(args.name || "").trim();
      const kind = args.kind === "liability" ? "liability" : "asset";
      const value = Number(args.value);
      if (!name || !isFinite(value)) return { error: "need a name and a numeric value" };
      await env.DB.prepare(
        `INSERT INTO holdings (name, kind, category, value, note, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, category = excluded.category,
           value = excluded.value, updated_at = excluded.updated_at`)
        .bind(name.slice(0, 60), kind, String(args.category || "other"), Math.abs(value),
              String(args.note || "").slice(0, 200), nowIso()).run();
      return { ok: true, ...(await netWorth(env)) };
    },
  },

  log_transaction: {
    group: "Money",
    desc: 'record money moving when no notification caught it. args: {"amount": 480, "direction": "debit|credit", "counterparty": "Swiggy", "category": "food", "note": "lunch"}',
    run: async (env, args) => {
      const amount = Number(args.amount);
      if (!isFinite(amount) || amount <= 0) return { error: "need a positive amount" };
      const direction = args.direction === "credit" ? "credit" : "debit";
      const counterparty = String(args.counterparty || "").slice(0, 60) || null;
      const category = CATEGORIES.includes(args.category)
        ? args.category : await categorise(env, counterparty, args.note);
      await env.DB.prepare(
        `INSERT INTO transactions (amount, direction, counterparty, category, note, at, source)
         VALUES (?,?,?,?,?,?,'manual')`)
        .bind(amount, direction, counterparty, category,
              String(args.note || "").slice(0, 200), args.at || nowIso()).run();
      return { ok: true, logged: { amount, direction, counterparty, category } };
    },
  },

  spending: {
    group: "Money",
    desc: 'where the money went, by category, with a comparison to the previous period. args: {"days": 30}',
    run: async (env, args) => {
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 365);
      const { results: byCat } = await env.DB.prepare(`
        SELECT category, COUNT(*) AS n, ROUND(SUM(amount)) AS total FROM transactions
        WHERE direction = 'debit' AND datetime(at) >= datetime('now', '-' || ? || ' days')
        GROUP BY category ORDER BY total DESC`).bind(days).all();
      const cur = await env.DB.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS v FROM transactions
        WHERE direction = 'debit' AND datetime(at) >= datetime('now', '-' || ? || ' days')`)
        .bind(days).first();
      const prev = await env.DB.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS v FROM transactions
        WHERE direction = 'debit'
          AND datetime(at) >= datetime('now', '-' || ? || ' days')
          AND datetime(at) <  datetime('now', '-' || ? || ' days')`)
        .bind(days * 2, days).first();
      const income = await env.DB.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS v FROM transactions
        WHERE direction = 'credit' AND datetime(at) >= datetime('now', '-' || ? || ' days')`)
        .bind(days).first();
      if (!byCat.length) return { error: `no transactions in the last ${days} days` };
      const change = prev.v ? Math.round(((cur.v - prev.v) / prev.v) * 100) : null;
      return {
        window_days: days, spent: Math.round(cur.v), received: Math.round(income.v),
        previous_period: Math.round(prev.v),
        change_pct: change, by_category: byCat,
      };
    },
  },

  // --- Body ---

  log_health: {
    group: "Body",
    desc: 'record a body metric. args: {"metric": "weight|waist|sleep|run_km|workout", "value": 71.2, "unit": "kg", "note": "..."}',
    run: async (env, args) => {
      const metric = String(args.metric || "").toLowerCase().trim();
      if (!metric) return { error: "need a metric name" };
      const value = args.value == null ? null : Number(args.value);
      await env.DB.prepare(
        "INSERT INTO health (metric, value, unit, note, at) VALUES (?,?,?,?,?)")
        .bind(metric.slice(0, 30), value, String(args.unit || "").slice(0, 12),
              String(args.note || "").slice(0, 200), args.at || nowIso()).run();
      // A number alone is trivia; the trend is the point.
      const prev = await env.DB.prepare(
        `SELECT value, at FROM health WHERE metric = ? AND value IS NOT NULL
         ORDER BY at DESC LIMIT 1 OFFSET 1`).bind(metric).first();
      const first = await env.DB.prepare(
        `SELECT value, at FROM health WHERE metric = ? AND value IS NOT NULL
           AND datetime(at) >= datetime('now', '-60 days') ORDER BY at ASC LIMIT 1`).bind(metric).first();
      return {
        ok: true,
        change_since_last: prev && value != null ? Math.round((value - prev.value) * 100) / 100 : null,
        change_over_60d: first && value != null ? Math.round((value - first.value) * 100) / 100 : null,
      };
    },
  },

  health_trend: {
    group: "Body",
    desc: 'the history of a body metric. args: {"metric": "weight", "days": 90}',
    run: async (env, args) => {
      const metric = String(args.metric || "weight").toLowerCase();
      const days = Math.min(Math.max(Number(args.days) || 90, 1), 730);
      const { results } = await env.DB.prepare(
        `SELECT value, unit, note, at FROM health
         WHERE metric = ? AND datetime(at) >= datetime('now', '-' || ? || ' days')
         ORDER BY at`).bind(metric, days).all();
      if (!results.length) return { error: `nothing logged for '${metric}' in that window` };
      const vals = results.filter(r => r.value != null).map(r => r.value);
      return {
        metric, count: results.length, points: results.slice(-30),
        first: vals[0], latest: vals[vals.length - 1],
        change: vals.length > 1 ? Math.round((vals[vals.length - 1] - vals[0]) * 100) / 100 : null,
      };
    },
  },

  // --- People ---

  remember_person: {
    group: "People",
    desc: `record or update someone in the owner's life. Pass spoke_today when the owner just saw or heard from them. args: {"name": "Ankit", "relation": "${RELATIONS.join("|")}", "how_met": "...", "notes": "...", "next_step": "send resume", "status": "active|cold|closed", "spoke_today": true}`,
    run: async (env, args) => {
      const name = String(args.name || "").trim();
      if (!name) return { error: "need a name" };
      const existing = await env.DB.prepare("SELECT * FROM people WHERE name = ?")
        .bind(name).first();
      const merged = {
        relation: args.relation || existing?.relation || null,
        how_met: args.how_met || existing?.how_met || null,
        notes: args.notes || existing?.notes || null,
        next_step: args.next_step !== undefined ? args.next_step : existing?.next_step || null,
        status: ["active", "cold", "closed"].includes(args.status)
          ? args.status : existing?.status || "active",
      };
      await env.DB.prepare(
        `INSERT INTO people (name, relation, how_met, status, notes, next_step, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET relation = excluded.relation, how_met = excluded.how_met,
           status = excluded.status, notes = excluded.notes, next_step = excluded.next_step`)
        .bind(name.slice(0, 80), merged.relation, merged.how_met, merged.status,
              String(merged.notes || "").slice(0, 600), merged.next_step, nowIso()).run();
      if (args.spoke_today) {
        await env.DB.prepare("UPDATE people SET last_contact = ? WHERE name = ?")
          .bind(nowIso(), name.slice(0, 80)).run();
      }
      return { ok: true, person: name, ...merged };
    },
  },

  log_interaction: {
    group: "People",
    desc: 'record that the owner spoke with someone — this is what keeps threads from going cold unnoticed. args: {"name": "Ankit", "what": "he asked for my resume"}',
    run: async (env, args) => {
      const name = String(args.name || "").trim();
      const what = String(args.what || "").trim();
      if (!name || !what) return { error: "need a name and what happened" };
      let p = await env.DB.prepare("SELECT id FROM people WHERE name = ?").bind(name).first();
      if (!p) {
        p = await env.DB.prepare(
          "INSERT INTO people (name, status, created_at) VALUES (?, 'active', ?) RETURNING id")
          .bind(name.slice(0, 80), nowIso()).first();
      }
      const at = args.at || nowIso();
      await env.DB.prepare("INSERT INTO interactions (person_id, what, at) VALUES (?,?,?)")
        .bind(p.id, what.slice(0, 400), at).run();
      await env.DB.prepare(
        "UPDATE people SET last_contact = ?, status = 'active' WHERE id = ?").bind(at, p.id).run();
      return { ok: true };
    },
  },

  get_people: {
    group: "People",
    desc: 'who the owner knows. args: {"relation": "recruiter"} or {"cold": true} for threads going quiet, or {} for everyone',
    run: async (env, args) => {
      if (args.cold) {
        // Measured from real contact — falling back to when they were first recorded,
        // so someone you added and then never followed up with still surfaces. Relying
        // on log_interaction always being called would make this silently miss people.
        const { results } = await env.DB.prepare(`
          SELECT name, relation, next_step, last_contact, notes,
                 CAST(julianday('now') - julianday(COALESCE(last_contact, created_at)) AS INTEGER) AS days_quiet
          FROM people
          WHERE status != 'closed'
            AND julianday('now') - julianday(COALESCE(last_contact, created_at)) >= 10
          ORDER BY days_quiet DESC LIMIT 15`).all();
        return { cold_threads: results.length, people: results };
      }
      const where = args.relation ? "WHERE relation = ?" : "";
      const binds = args.relation ? [String(args.relation)] : [];
      const { results } = await env.DB.prepare(
        `SELECT name, relation, how_met, status, next_step, last_contact, notes
         FROM people ${where} ORDER BY COALESCE(last_contact, created_at) DESC LIMIT 30`)
        .bind(...binds).all();
      return { count: results.length, people: results };
    },
  },

  person_history: {
    group: "People",
    desc: 'everything the owner has told you about one person. args: {"name": "Ankit"}',
    run: async (env, args) => {
      const name = String(args.name || "").trim();
      const p = await env.DB.prepare("SELECT * FROM people WHERE name = ?").bind(name).first();
      if (!p) return { error: `nobody called '${name}' on file` };
      const { results } = await env.DB.prepare(
        "SELECT what, at FROM interactions WHERE person_id = ? ORDER BY at DESC LIMIT 20")
        .bind(p.id).all();
      return { person: p, interactions: results };
    },
  },
};
