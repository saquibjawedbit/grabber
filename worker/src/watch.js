// Watchers: the scraper's replacement. You name a channel worth watching, and only
// that gets checked. Hits land in `postings` as watch:<target>, so the corpus — and
// therefore measured IDF rarity (point 3) — now describes the material you actually
// chose, not board noise.
//
// Flow per hit: store -> cheap recall score (edge over IDF, point 5 stage 1) ->
// LLM reads survivors -> draft -> alert if it clears the bar and the budget holds.

import { llm } from "./agent.js";

const MAX_ALERTS_PER_DAY = 2;   // point 7: silence is the product
const MIN_FIT_TO_ALERT = 70;
const RANK_PER_RUN = 6;         // cap LLM spend per cron tick (free neurons)
const NITTER_HOSTS = ["nitter.net", "nitter.poast.org", "xcancel.com"];

// Obscurity prior (point 2). A watched personal account is the whole point;
// a job board is where everyone already looked.
const KIND_WEIGHT = { x: 1.5, rss: 1.1, page: 1.2, search: 1.0 };

const strip = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
  .replace(/\s+/g, " ").trim();

async function sha12(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

const UA = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" };

// ---------- checkers: each returns [{external_id, title, body, url}] ----------

function parseFeed(xml, limit = 12) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks.slice(0, limit)) {
    const pick = tag => (b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")) || [])[1] || "";
    const cdata = s => strip(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    const title = cdata(pick("title"));
    let url = cdata(pick("link"));
    if (!url) url = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const body = cdata(pick("description") || pick("content:encoded") || pick("summary") || pick("content"));
    if (title || body) items.push({ external_id: url || title, title: title || body.slice(0, 80), body, url });
  }
  return items;
}

async function checkRss(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`feed ${r.status}`);
  return parseFeed(await r.text());
}

async function checkX(handle) {
  const h = handle.replace(/^@/, "");
  let lastErr = "no instance responded";
  for (const host of NITTER_HOSTS) {
    try {
      const r = await fetch(`https://${host}/${h}/rss`, { headers: UA });
      if (!r.ok) { lastErr = `${host} ${r.status}`; continue; }
      const items = parseFeed(await r.text());
      if (items.length) return items.map(i => ({ ...i, url: (i.url || "").replace(/https?:\/\/[^/]+/, "https://x.com") }));
      lastErr = `${host} empty`;
    } catch (e) { lastErr = `${host} ${String(e).slice(0, 60)}`; }
  }
  throw new Error(lastErr);
}

async function checkPage(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`page ${r.status}`);
  const text = strip(await r.text()).slice(0, 4000);
  // A page is one item; its hash is the id, so it only re-fires when it changes.
  return [{ external_id: await sha12(text), title: `Update: ${url}`, body: text, url }];
}

async function checkSearch(env, query) {
  if (!env.GOOGLE_CSE_KEY || !env.GOOGLE_CSE_ID) throw new Error("search watchers need GOOGLE_CSE_KEY");
  const r = await fetch("https://www.googleapis.com/customsearch/v1?key=" + env.GOOGLE_CSE_KEY +
    "&cx=" + env.GOOGLE_CSE_ID + "&num=8&sort=date&q=" + encodeURIComponent(query));
  if (!r.ok) throw new Error(`cse ${r.status}`);
  const j = await r.json();
  return (j.items || []).map(i => ({
    external_id: i.link, title: i.title, body: i.snippet || "", url: i.link,
  }));
}

const CHECKERS = {
  x: (env, t) => checkX(t),
  rss: (env, t) => checkRss(t),
  page: (env, t) => checkPage(t),
  search: (env, t) => checkSearch(env, t),
};

// ---------- stage 1: cheap recall (no LLM) ----------

const TOKEN_RE = /[a-z][a-z0-9+#.\-]{1,30}/g;
const STOP = new Set(`a an and are as at be by for from has have if in into is it its of on or
that the this to was we will with you your our not can more all new who what i me my mine am
were being strongly really very much prefer prefers like likes love loves want wants need needs
must only also work working sweet spot great good best things stuff etc currently right now
them they these those there here about after before because when where which while just still`.split(/\s+/));

const MEMORY_TERM_WEIGHT = 0.25;

async function edgeTerms(env) {
  // Terms the owner cares about (memories + skills), each weighted by measured IDF.
  const [mem, skills] = await Promise.all([
    env.DB.prepare("SELECT fact FROM memories").all(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'skills'").first(),
  ]);
  const terms = new Set();
  for (const r of mem.results) {
    for (const t of (r.fact.toLowerCase().match(TOKEN_RE) || [])) {
      if (t.length >= 4 && !STOP.has(t)) terms.add(t);
    }
  }
  if (skills?.content) {
    for (const line of skills.content.split("\n")) {
      const k = (line.split(":")[0] || "").trim().toLowerCase();
      if (k.length >= 4 && !k.startsWith("#")) terms.add(k);
    }
  }
  if (!terms.size) return {};
  const list = [...terms];
  const out = {};
  for (let i = 0; i < list.length; i += 50) {   // D1: max 100 bound params
    const chunk = list.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT term, idf FROM idf WHERE term IN (${marks})`).bind(...chunk).all();
    for (const r of results) out[r.term] = r.idf;
  }
  for (const t of list) if (!(t in out)) out[t] = 1.0;  // unseen term: neutral
  return out;
}

function recallScore(text, terms, kind) {
  const low = text.toLowerCase();
  let score = 0;
  const matched = [];
  for (const [term, idf] of Object.entries(terms)) {
    if (low.includes(term)) { score += MEMORY_TERM_WEIGHT * idf; matched.push(term); }
  }
  return { score: score * (KIND_WEIGHT[kind] || 1), matched };
}

// ---------- stage 2: the LLM reads survivors ----------

const RANK_PROMPT = (profile, item, source) => `You are judging one item for one specific person.
Be brutally selective: a false alert costs trust; silence is the product. Most items are noise —
a retweet, an opinion, a newsletter blurb. Only a concrete opportunity they could ACT on today
should alert.

## The person
${profile}

Anything under "Owner-stated memories" came from them directly and is authoritative: an item that
conflicts with a stated preference or constraint should almost never alert.

## The item
Watched channel: ${source}
Title: ${item.title}
${item.url || ""}
${(item.body || "").slice(0, 3000)}

## Your job
Return JSON only:
{"category":"hackathon|fellowship|grant|job|internship|contract|news|other",
 "is_opportunity": true|false,
 "fit": 0-100,
 "p_convert": 0.0-1.0,
 "alert": true|false,
 "deadline": "YYYY-MM-DD or null",
 "reasons": "one or two sentences naming their specific edge, no fluff",
 "angle": "one line: the strongest angle for their application"}`;

const DRAFT_PROMPT = (profile, item, angle) => `Prepare application material for this opportunity,
in this person's own voice. Do not invent achievements that aren't in the material below.

## Opportunity
${item.title}
${item.url || ""}
${(item.body || "").slice(0, 3000)}

## Winning angle (already decided)
${angle}

## Them
${profile}

Produce markdown with exactly these sections:
# Message draft
(what to actually send — if this is a founder's post, a reply they could paste; if a form, the essay)
# Proof points to lead with
(ordered bullets: which of their real achievements to put first for THIS one)
# Before you hit send
(what this will ask for: links, resume, references — so nothing surprises them mid-form)`;

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { /* fall through */ }
  return null;
}

async function ownerProfile(env) {
  const parts = [];
  for (const key of ["bio", "skills", "resume"]) {
    const row = await env.DB.prepare("SELECT content FROM profile WHERE key = ?").bind(key).first();
    if (row) parts.push(`### ${key}\n${row.content.slice(0, 2000)}`);
  }
  const { results: mems } = await env.DB.prepare(
    "SELECT category, fact FROM memories ORDER BY category, id LIMIT 60").all();
  if (mems.length) {
    parts.push("### Owner-stated memories\n" + mems.map(m => `- (${m.category}) ${m.fact}`).join("\n"));
  }
  return parts.join("\n\n") || "(nothing known yet)";
}

async function alertsToday(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM alerts WHERE sent_at > datetime('now', '-1 day')").first();
  return row.n;
}

async function blendedP(env, category, prior) {
  const row = await env.DB.prepare(
    "SELECT n_won, n_rejected, rate FROM calibration WHERE category = ?").bind(category).first();
  if (!row || row.rate == null) return prior;
  const n = (row.n_won || 0) + (row.n_rejected || 0);
  const w = n / (n + 10);                    // measured rate takes over as labels arrive
  return prior * (1 - w) + row.rate * w;
}

// ---------- the cron tick ----------

export async function runWatchers(env, tg) {
  const { results: watchers } = await env.DB.prepare(
    "SELECT * FROM watchers WHERE active = 1").all();
  if (!watchers.length) return { checked: 0 };

  const terms = await edgeTerms(env);
  const fresh = [];

  for (const w of watchers) {
    const source = `watch:${w.kind}:${w.target}`;
    try {
      const items = await CHECKERS[w.kind](env, w.target);
      for (const it of items) {
        const id = await sha12(`${source}:${it.external_id}`);
        const res = await env.DB.prepare(
          `INSERT OR IGNORE INTO postings
             (id, source, external_id, url, title, body, org, deadline, posted_at, ingested_at)
           VALUES (?,?,?,?,?,?,'','','',?) RETURNING id`)
          .bind(id, source, String(it.external_id).slice(0, 200), it.url || "",
                (it.title || "").slice(0, 300), (it.body || "").slice(0, 8000),
                new Date().toISOString()).all();
        if (!res.results.length) continue;         // already seen
        const { score, matched } = recallScore(`${it.title} ${it.body}`, terms, w.kind);
        fresh.push({ ...it, id, source, score, matched, watcher: w });
      }
      await env.DB.prepare(
        "UPDATE watchers SET last_checked = ?, last_error = NULL, hits = hits + ? WHERE id = ?")
        .bind(new Date().toISOString(), items.length, w.id).run();
    } catch (e) {
      await env.DB.prepare("UPDATE watchers SET last_checked = ?, last_error = ? WHERE id = ?")
        .bind(new Date().toISOString(), String(e).slice(0, 200), w.id).run();
      console.log(`watch: ${source} failed: ${e}`);
    }
  }

  if (!fresh.length) return { checked: watchers.length, fresh: 0 };

  // Stage 1 cut: only the top few earn an LLM read.
  fresh.sort((a, b) => b.score - a.score);
  const survivors = fresh.filter(f => f.score > 0).slice(0, RANK_PER_RUN);
  console.log(`watch: ${fresh.length} new, ${survivors.length} survive recall`);

  const profile = await ownerProfile(env);
  let budget = Math.max(0, MAX_ALERTS_PER_DAY - await alertsToday(env));

  for (const item of survivors) {
    const { text } = await llm(env, RANK_PROMPT(profile, item, item.source));
    const v = extractJson(text);
    if (!v) { console.log(`watch: rank returned no JSON for ${item.id}`); continue; }

    const prior = Number(v.p_convert) || 0;
    const p = await blendedP(env, v.category || "other", prior);
    const row = await env.DB.prepare(
      `INSERT INTO alerts (posting_id, category, fit, p_convert, llm_prior, reasons, angle)
       VALUES (?,?,?,?,?,?,?) RETURNING id`)
      .bind(item.id, v.category || "other", Number(v.fit) || 0, p, prior,
            v.reasons || "", v.angle || "").first();
    if (v.deadline) {
      await env.DB.prepare("UPDATE postings SET deadline = ? WHERE id = ?")
        .bind(v.deadline, item.id).run();
    }

    if (!(v.alert && v.is_opportunity && Number(v.fit) >= MIN_FIT_TO_ALERT && budget > 0)) continue;

    // Point 1: the alert arrives with the work already done.
    try {
      const { text: draft } = await llm(env, DRAFT_PROMPT(profile, item, v.angle || ""));
      if (draft.trim()) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO drafts (alert_id, content_md, created_at) VALUES (?,?,?)")
          .bind(row.id, draft, new Date().toISOString()).run();
      }
    } catch (e) { console.log(`watch: draft failed: ${e}`); }

    const e = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const sent = await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      text: `🎯 <b>${e(item.title.slice(0, 150))}</b>\n` +
            `${e(v.category)} · fit ${Number(v.fit)}/100 · P(win) ${Math.round(p * 100)}%` +
            `${v.deadline ? ` · deadline ${e(v.deadline)}` : ""}\n` +
            `spotted on <i>${e(item.watcher.kind === "x" ? "@" + item.watcher.target.replace(/^@/, "") : item.watcher.target)}</i>\n\n` +
            `${e(v.reasons)}\n<i>angle: ${e(v.angle)}</i>\n\n${e(item.url || "")}`,
      reply_markup: { inline_keyboard: [[
        { text: "✅ Applied", callback_data: `a:${row.id}:applied` },
        { text: "🙅 Skip", callback_data: `a:${row.id}:skipped` },
        { text: "💤 Snooze", callback_data: `a:${row.id}:snoozed` },
      ]]},
    });
    if (sent.ok) {
      await env.DB.prepare("UPDATE alerts SET sent_at = ?, tg_message_id = ? WHERE id = ?")
        .bind(new Date().toISOString(), sent.result.message_id, row.id).run();
      budget--;
      console.log(`watch: alerted #${row.id} ${item.title.slice(0, 60)}`);
    }
  }
  return { checked: watchers.length, fresh: fresh.length, ranked: survivors.length };
}
