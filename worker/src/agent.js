import { LIFE_TOOLS } from "./life.js";
import { extractJson, llm } from "./llm.js";

export { llm };

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";  // 384-dim, plenty for short facts
const MAX_STEPS = 8;
const HISTORY_ACTIVE = 24;      // recent chat_history rows kept verbatim in the prompt
const HISTORY_COMPACT_AT = 48;  // beyond this, oldest rows fold into the rolling summary
const HISTORY_HARD_CAP = 140;   // safety valve if summarization keeps failing
const RECALL_K = 14;            // memories retrieved per turn (v3: by meaning, not all of them)

// ---------- Memory v3: vectors packed as base64 Float32, normalised at write time
// so recall is a dot product. JSON arrays would blow the Worker's CPU budget. ----------

async function embed(env, text) {
  const res = await env.AI.run(EMBED_MODEL, { text: [String(text).slice(0, 1200)] });
  const v = res?.data?.[0];
  if (!Array.isArray(v) || !v.length) throw new Error("embedding came back empty");
  let norm = Math.hypot(...v) || 1;
  return Float32Array.from(v, x => x / norm);
}

function packVec(f32) {
  const bytes = new Uint8Array(f32.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unpackVec(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function recallMemories(env, query) {
  const { results } = await env.DB.prepare(
    "SELECT id, category, fact, embedding FROM memories ORDER BY id DESC LIMIT 400").all();
  if (!results.length) return [];
  const embedded = results.filter(r => r.embedding);
  // Un-embedded rows (saved before v3, or embedding failed) always ride along —
  // better a slightly bigger prompt than silently forgetting a fact.
  const plain = results.filter(r => !r.embedding).slice(0, 12);
  if (!embedded.length) return plain;
  let q;
  try {
    q = await embed(env, query);
  } catch {
    return results.slice(0, RECALL_K);
  }
  const scored = embedded.map(r => {
    let sim = -1;
    try { sim = dot(q, unpackVec(r.embedding)); } catch { /* corrupt vector */ }
    return { ...r, sim };
  });
  scored.sort((a, b) => b.sim - a.sim);
  return [...plain, ...scored.slice(0, RECALL_K)];
}

export async function embedMemory(env, id, fact) {
  try {
    const v = await embed(env, fact);
    await env.DB.prepare("UPDATE memories SET embedding = ? WHERE id = ?")
      .bind(packVec(v), id).run();
    return true;
  } catch (e) {
    console.log("embedMemory failed:", String(e).slice(0, 120));
    return false;
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\s+/g, " ").trim();
}

// ---------- Tools ----------

const MEMORY_CATEGORIES = ["identity", "preference", "skill", "goal", "project", "contact", "fact"];

export const TOOLS = {
  search_corpus: {
    desc: 'search all ingested postings. args: {"query": "1-3 short keywords"}',
    run: async (env, args) => {
      const tokens = String(args.query || "").split(/\s+/).filter(Boolean).slice(0, 4);
      if (!tokens.length) return { error: "empty query" };
      const where = tokens.map(() => "(title LIKE ? OR body LIKE ?)").join(" AND ");
      const binds = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
      const total = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM postings WHERE ${where}`).bind(...binds).first();
      const { results } = await env.DB.prepare(
        `SELECT title, source, url, deadline, substr(body, 1, 150) AS snippet
         FROM postings WHERE ${where} ORDER BY ingested_at DESC LIMIT 8`
      ).bind(...binds).all();
      return { total_matching: total.n, showing: results.length, results };
    },
  },

  corpus_overview: {
    desc: "posting counts per source plus total — the shape of what has been ingested. args: {}",
    run: async (env) => {
      const { results } = await env.DB.prepare(
        "SELECT source, COUNT(*) AS n FROM postings GROUP BY source ORDER BY n DESC LIMIT 25").all();
      const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM postings").first();
      return { total: total.n, by_source: results };
    },
  },

  web_search: {
    desc: 'search the live web for anything. args: {"query": "..."}',
    run: async (env, args) => {
      const q = String(args.query || "").trim();
      if (!q) return { error: "empty query" };
      // 1. Google CSE — reliable from Workers, free 100 queries/day, needs GOOGLE_CSE_KEY.
      if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_ID) {
        try {
          const r = await fetch("https://www.googleapis.com/customsearch/v1?key=" + env.GOOGLE_CSE_KEY +
            "&cx=" + env.GOOGLE_CSE_ID + "&num=6&q=" + encodeURIComponent(q));
          if (r.ok) {
            const j = await r.json();
            const results = (j.items || []).map(i => ({
              title: i.title, url: i.link, snippet: (i.snippet || "").slice(0, 160),
            }));
            if (results.length) return { results, tip: "web_fetch a result URL to read it" };
          }
        } catch { /* fall through */ }
      }
      // 2. DuckDuckGo endpoints — often block datacenter IPs, but cheap to try.
      const ddgLink = /<a[^>]*(?:class="result__a"|rel="nofollow")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      for (const ep of ["https://html.duckduckgo.com/html/?q=", "https://lite.duckduckgo.com/lite/?q="]) {
        try {
          const r = await fetch(ep + encodeURIComponent(q), {
            headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" },
          });
          if (!r.ok) continue;
          const html = await r.text();
          const results = [];
          let m;
          while ((m = ddgLink.exec(html)) && results.length < 6) {
            let href = m[1];
            const uddg = /uddg=([^&]+)/.exec(href);
            if (uddg) try { href = decodeURIComponent(uddg[1]); } catch { /* keep raw */ }
            if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
            const title = stripHtml(m[2]).slice(0, 120);
            if (!title || results.some(x => x.url === href)) continue;
            results.push({ title, url: href });
          }
          if (results.length) return { results, tip: "web_fetch a result URL to read it" };
        } catch { /* try next */ }
      }
      // 3. Wikipedia — always reachable; better than nothing for factual queries.
      try {
        const r = await fetch("https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&search=" +
          encodeURIComponent(q));
        const [, titles, , urls] = await r.json();
        if (titles?.length) {
          return {
            results: titles.map((t, i) => ({ title: t, url: urls[i] })),
            note: "general search engines blocked this request; these are Wikipedia matches — web_fetch one, or fetch a site you already know",
          };
        }
      } catch { /* give up */ }
      return { error: "all search backends failed — try web_fetch on a specific URL you know" };
    },
  },

  web_fetch: {
    desc: 'read a web page as text. args: {"url": "https://..."}',
    run: async (_env, args) => {
      const url = String(args.url || "");
      if (!/^https?:\/\//.test(url)) return { error: "need a full http(s) url" };
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" },
          redirect: "follow",
        });
        const text = stripHtml(await r.text());
        if (r.ok && text.length > 150) return { text: text.slice(0, 4000) };
      } catch { /* fall through to readability proxy */ }
      try {
        const r = await fetch("https://r.jina.ai/" + url);
        const t = (await r.text()).trim();
        if (r.ok && t) return { via: "reader-proxy", text: t.slice(0, 4000) };
        return { error: `could not fetch (${r.status})` };
      } catch (e) {
        return { error: String(e).slice(0, 200) };
      }
    },
  },

  get_stats: {
    desc: "application tracker numbers: applied/won/rejected counts, per-category rates, corpus size. args: {}",
    run: async (env) => {
      const totals = await env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM postings) AS corpus,
          (SELECT COUNT(*) FROM alerts WHERE sent_at IS NOT NULL) AS alerted,
          (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'applied') AS applied,
          (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'won') AS won,
          (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'rejected') AS rejected`).first();
      const { results: byCategory } = await env.DB.prepare("SELECT * FROM calibration").all();
      return { totals, byCategory };
    },
  },

  get_pending: {
    desc: "alerts the owner has not applied to or skipped yet, with deadlines. args: {}",
    run: async (env) => {
      const { results } = await env.DB.prepare(`
        SELECT a.id AS alert_id, p.title, p.url, p.deadline
        FROM alerts a JOIN postings p ON p.id = a.posting_id
        WHERE a.sent_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM outcomes o
                          WHERE o.alert_id = a.id AND o.action IN ('applied','skipped'))
        ORDER BY CASE WHEN p.deadline IS NULL OR p.deadline = '' THEN 1 ELSE 0 END,
                 date(p.deadline) LIMIT 12`).all();
      return { count: results.length, results };
    },
  },

  get_draft: {
    desc: 'read a prepared application draft. args: {"alert_id": <number>} or {} to list drafts',
    run: async (env, args) => {
      if (args.alert_id) {
        const row = await env.DB.prepare(
          "SELECT content_md FROM drafts WHERE alert_id = ?").bind(Number(args.alert_id)).first();
        return row ? { draft: row.content_md.slice(0, 2500) } : { error: "no draft for that alert_id" };
      }
      const { results } = await env.DB.prepare(`
        SELECT d.alert_id, p.title FROM drafts d
        JOIN alerts a ON a.id = d.alert_id JOIN postings p ON p.id = a.posting_id
        ORDER BY d.created_at DESC LIMIT 10`).all();
      return { drafts: results };
    },
  },

  redraft: {
    desc: 'rewrite a draft per instruction. args: {"alert_id": <number>, "instruction": "what to change"}',
    run: async (env, args) => {
      const row = await env.DB.prepare(`
        SELECT d.content_md, p.title, substr(p.body, 1, 2000) AS body
        FROM drafts d JOIN alerts a ON a.id = d.alert_id JOIN postings p ON p.id = a.posting_id
        WHERE d.alert_id = ?`).bind(Number(args.alert_id)).first();
      if (!row) return { error: "no draft for that alert_id" };
      const { text: rewritten } = await llm(env,
        `Rewrite this application draft. Instruction from the owner: ${args.instruction}\n\n` +
        `Opportunity: ${row.title}\n${row.body}\n\nCurrent draft:\n${row.content_md}\n\n` +
        `Return ONLY the full rewritten draft in the same markdown structure.`);
      if (!rewritten.trim()) return { error: "rewrite came back empty" };
      await env.DB.prepare("UPDATE drafts SET content_md = ? WHERE alert_id = ?")
        .bind(rewritten, Number(args.alert_id)).run();
      return { ok: true, preview: rewritten.slice(0, 400) };
    },
  },

  read_profile: {
    desc: 'read the owner\'s profile documents (bio, resume, notes they sent). args: {} to list, {"key": "..."} to read one',
    run: async (env, args) => {
      if (args.key) {
        const row = await env.DB.prepare(
          "SELECT content FROM profile WHERE key = ?").bind(String(args.key)).first();
        return row ? { content: row.content.slice(0, 3500) } : { error: "no document with that key" };
      }
      const { results } = await env.DB.prepare(
        "SELECT key, length(content) AS chars, updated_at FROM profile ORDER BY key").all();
      return { documents: results };
    },
  },

  save_memory: {
    desc: `store a durable fact about the owner. args: {"fact": "...", "category": one of ${MEMORY_CATEGORIES.join("|")}}`,
    run: async (env, args) => {
      if (!args.fact) return { error: "empty fact" };
      const cat = MEMORY_CATEGORIES.includes(args.category) ? args.category : "fact";
      const fact = String(args.fact).slice(0, 500);
      const row = await env.DB.prepare(
        "INSERT INTO memories (fact, category, created_at) VALUES (?, ?, ?) RETURNING id")
        .bind(fact, cat, new Date().toISOString()).first();
      await embedMemory(env, row.id, fact);   // so it's recallable by meaning, not just recency
      return { ok: true, id: row.id };
    },
  },

  forget_memory: {
    desc: 'delete a memory that is wrong or superseded. args: {"id": <number from the memory list>}',
    run: async (env, args) => {
      if (!args.id) return { error: "need the memory id" };
      const r = await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(Number(args.id)).run();
      return r.meta.changes ? { ok: true } : { error: "no memory with that id" };
    },
  },

  set_reminder: {
    desc: 'schedule a reminder message. args: {"text": "...", "due_at": "UTC ISO datetime"} — delivered on the hour',
    run: async (env, args) => {
      const due = Date.parse(args.due_at || "");
      if (!args.text || isNaN(due)) return { error: 'need text and due_at as UTC ISO like "2026-07-17T04:30:00Z"' };
      await env.DB.prepare("INSERT INTO reminders (text, due_at, created_at) VALUES (?, ?, ?)")
        .bind(String(args.text).slice(0, 300), new Date(due).toISOString(), new Date().toISOString()).run();
      return { ok: true, fires_at_utc: new Date(due).toISOString() };
    },
  },

  list_reminders: {
    desc: "open reminders with ids and due times. args: {}",
    run: async (env) => {
      const { results } = await env.DB.prepare(
        "SELECT id, text, due_at, notified FROM reminders WHERE done = 0 ORDER BY due_at LIMIT 20").all();
      return { count: results.length, reminders: results };
    },
  },

  cancel_reminder: {
    desc: 'cancel or complete a reminder. args: {"id": <number>}',
    run: async (env, args) => {
      if (!args.id) return { error: "need the reminder id" };
      const r = await env.DB.prepare("UPDATE reminders SET done = 1 WHERE id = ?").bind(Number(args.id)).run();
      return r.meta.changes ? { ok: true } : { error: "no reminder with that id" };
    },
  },

  // --- Watchers: the owner names a channel worth watching; nothing else gets crawled ---

  add_watcher: {
    desc: 'watch a channel for opportunities. args: {"kind": "x|rss|page|search", "target": "handle | feed url | page url | search query", "note": "why it matters"}',
    run: async (env, args) => {
      const kind = String(args.kind || "").toLowerCase();
      if (!["x", "rss", "page", "search"].includes(kind)) {
        return { error: 'kind must be one of: x (an X/Twitter handle), rss (feed url), page (url to diff), search (query)' };
      }
      let target = String(args.target || "").trim();
      if (!target) return { error: "empty target" };
      if (kind === "x") target = target.replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "");
      if ((kind === "rss" || kind === "page") && !/^https?:\/\//.test(target)) {
        return { error: `${kind} watchers need a full http(s) url` };
      }
      if (kind === "search" && !env.GOOGLE_CSE_KEY) {
        return { error: "search watchers need GOOGLE_CSE_KEY set — the owner hasn't provided it yet. Suggest an x/rss/page watcher instead." };
      }
      try {
        const row = await env.DB.prepare(
          "INSERT INTO watchers (kind, target, note, created_at) VALUES (?,?,?,?) RETURNING id")
          .bind(kind, target.slice(0, 300), String(args.note || "").slice(0, 200),
                new Date().toISOString()).first();
        return { ok: true, id: row.id, checked: "hourly", note: "I'll only interrupt if something clears the bar." };
      } catch (e) {
        return /UNIQUE/.test(String(e)) ? { error: "already watching that" } : { error: String(e).slice(0, 150) };
      }
    },
  },

  list_watchers: {
    desc: "what is being watched, with last check and hit counts. args: {}",
    run: async (env) => {
      const { results } = await env.DB.prepare(
        "SELECT id, kind, target, note, last_checked, last_error, hits, active FROM watchers ORDER BY id").all();
      return { count: results.length, watchers: results };
    },
  },

  remove_watcher: {
    desc: 'stop watching something. args: {"id": <number>}',
    run: async (env, args) => {
      if (!args.id) return { error: "need the watcher id" };
      const r = await env.DB.prepare("DELETE FROM watchers WHERE id = ?").bind(Number(args.id)).run();
      return r.meta.changes ? { ok: true } : { error: "no watcher with that id" };
    },
  },

  // --- Deep research: hand the question to an agent with a real machine ---

  spawn_research: {
    desc: 'launch a background research agent for a question that needs real digging (browsing many pages, reading articles, watching talks). Takes ~5-15 min and reports back on its own. Use for "what does X ask in interviews", "who is this founder", "is Y worth doing". args: {"question": "...", "depth": "quick|normal|deep"}',
    run: async (env, args) => {
      const question = String(args.question || "").trim();
      if (!question) return { error: "empty question" };
      if (!env.GH_TOKEN || !env.GH_REPO) {
        return { error: "research needs GH_TOKEN + GH_REPO configured — tell the owner it isn't wired up yet" };
      }
      const depth = ["quick", "normal", "deep"].includes(args.depth) ? args.depth : "normal";
      const running = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM research WHERE status IN ('queued','running')").first();
      if (running.n >= 3) return { error: "3 research jobs already in flight — wait for one to land" };

      const row = await env.DB.prepare(
        "INSERT INTO research (question, depth, created_at) VALUES (?,?,?) RETURNING id")
        .bind(question.slice(0, 500), depth, new Date().toISOString()).first();

      // Only the job id travels — the question itself is read from D1 by the runner,
      // so nothing personal lands in a public build log.
      const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GH_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "intelly-agent",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event_type: "research", client_payload: { job_id: row.id } }),
      });
      if (!r.ok) {
        const body = await r.text();
        await env.DB.prepare("UPDATE research SET status = 'failed', error = ? WHERE id = ?")
          .bind(`dispatch ${r.status}: ${body.slice(0, 150)}`, row.id).run();
        return { error: `could not launch the agent (${r.status})` };
      }
      return {
        ok: true, job_id: row.id, depth,
        note: "Agent is on a real machine now. Tell the owner it'll take ~5-15 min and you'll ping them — do NOT wait for it.",
      };
    },
  },

  // --- Senses: things the owner never told you, but you saw ---

  get_calendar: {
    desc: 'upcoming meetings from their Google Calendar. args: {"days": 7}',
    run: async (env, args) => {
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
      const { results } = await env.DB.prepare(`
        SELECT title, starts_at, location, attendees FROM events
        WHERE datetime(starts_at) >= datetime('now')
          AND datetime(starts_at) <= datetime('now', '+' || ? || ' days')
        ORDER BY starts_at LIMIT 20`).bind(days).all();
      return { count: results.length, events: results,
               note: results.length ? "times are UTC — convert to IST for the owner" : "nothing scheduled" };
    },
  },

  search_email: {
    desc: 'search recruiter/opportunity mail the agent has seen. args: {"query": "keywords"} or {} for recent',
    run: async (env, args) => {
      const q = String(args.query || "").trim();
      if (!q) {
        const { results } = await env.DB.prepare(
          "SELECT sender, subject, snippet, kind, received_at FROM emails ORDER BY received_at DESC LIMIT 10").all();
        return { count: results.length, emails: results };
      }
      const { results } = await env.DB.prepare(
        `SELECT sender, subject, snippet, kind, received_at FROM emails
         WHERE sender LIKE ? OR subject LIKE ? OR snippet LIKE ?
         ORDER BY received_at DESC LIMIT 10`).bind(`%${q}%`, `%${q}%`, `%${q}%`).all();
      return { count: results.length, emails: results };
    },
  },

  search_notifications: {
    desc: 'phone notifications the agent captured (bank alerts, recruiter pings). args: {"kind": "bank|recruiter|calendar|other", "days": 7}',
    run: async (env, args) => {
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 90);
      const kind = String(args.kind || "").trim();
      const where = kind ? "kind = ? AND " : "";
      const binds = kind ? [kind, days] : [days];
      const { results } = await env.DB.prepare(
        `SELECT app, title, body, kind, amount, direction, counterparty, received_at
         FROM notifications WHERE ${where} datetime(received_at) >= datetime('now', '-' || ? || ' days')
         ORDER BY received_at DESC LIMIT 25`).bind(...binds).all();
      const spend = results.filter(r => r.direction === "debit")
        .reduce((s, r) => s + (r.amount || 0), 0);
      return {
        count: results.length, notifications: results,
        ...(spend ? { total_debits_in_window: Math.round(spend) } : {}),
      };
    },
  },

  watch_app: {
    desc: 'allow a phone app\'s notifications to be stored (they are dropped unless allowed). args: {"pattern": "lowercase app name fragment", "kind": "bank|recruiter|calendar|delivery|other"}',
    run: async (env, args) => {
      const pattern = String(args.pattern || "").toLowerCase().trim();
      if (!pattern) return { error: "empty pattern" };
      const kind = ["bank", "recruiter", "calendar", "delivery", "other"].includes(args.kind)
        ? args.kind : "other";
      await env.DB.prepare(
        "INSERT OR REPLACE INTO notify_allow (pattern, kind, created_at) VALUES (?,?,?)")
        .bind(pattern.slice(0, 60), kind, new Date().toISOString()).run();
      return { ok: true, note: "notifications matching this will now be stored" };
    },
  },

  get_research: {
    desc: 'read research results. args: {"id": <number>} for one report, or {} to list recent jobs and their status',
    run: async (env, args) => {
      if (args.id) {
        const row = await env.DB.prepare(
          "SELECT id, question, status, report_md, sources, error, finished_at FROM research WHERE id = ?")
          .bind(Number(args.id)).first();
        if (!row) return { error: "no research job with that id" };
        return {
          ...row,
          report_md: row.report_md ? row.report_md.slice(0, 3000) : null,
          sources: row.sources ? JSON.parse(row.sources).slice(0, 15) : [],
        };
      }
      const { results } = await env.DB.prepare(
        "SELECT id, question, status, created_at, finished_at FROM research ORDER BY id DESC LIMIT 10").all();
      return { jobs: results };
    },
  },

  configure_briefing: {
    desc: 'change the morning briefing. args: {"enabled": true|false, "hour_ist": 8}',
    run: async (env, args) => {
      const set = async (k, v) => env.DB.prepare(
        `INSERT INTO state (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(k, String(v), new Date().toISOString()).run();
      if (args.enabled !== undefined) await set("briefing_enabled", args.enabled ? "1" : "0");
      if (args.hour_ist !== undefined) {
        const h = Number(args.hour_ist);
        if (!Number.isInteger(h) || h < 0 || h > 23) return { error: "hour_ist must be 0-23" };
        await set("briefing_hour", h);
      }
      const en = await env.DB.prepare("SELECT value FROM state WHERE key='briefing_enabled'").first();
      const hr = await env.DB.prepare("SELECT value FROM state WHERE key='briefing_hour'").first();
      return { ok: true, enabled: en?.value !== "0", hour_ist: Number(hr?.value || 8),
               note: "I only send it when there's something worth interrupting you for." };
    },
  },

  ...LIFE_TOOLS,
};

// The tool list is long enough now that a flat dump reads as noise. Group it so the
// model can find the right shelf before the right tool.
const TOOL_GROUPS = {
  search_corpus: "Opportunities", corpus_overview: "Opportunities", get_pending: "Opportunities",
  get_stats: "Opportunities", get_draft: "Opportunities", redraft: "Opportunities",
  add_watcher: "Opportunities", list_watchers: "Opportunities", remove_watcher: "Opportunities",
  web_search: "Web & research", web_fetch: "Web & research",
  spawn_research: "Web & research", get_research: "Web & research",
  save_memory: "Memory", forget_memory: "Memory", read_profile: "Memory",
  set_reminder: "Reminders", list_reminders: "Reminders", cancel_reminder: "Reminders",
  get_calendar: "Senses", search_email: "Senses", search_notifications: "Senses",
  watch_app: "Senses",
};

function toolList() {
  const groups = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    const g = t.group || TOOL_GROUPS[name] || "Other";
    (groups[g] ||= []).push(`- ${name}: ${t.desc}`);
  }
  return Object.entries(groups)
    .map(([g, lines]) => `### ${g}\n${lines.join("\n")}`).join("\n");
}

// ---------- Prompt assembly ----------

async function context(env, userText) {
  const [mem, hist, bio, summary, docs, counts] = await Promise.all([
    recallMemories(env, userText),   // v3: relevant to THIS message, not simply the newest
    env.DB.prepare("SELECT role, content FROM chat_history ORDER BY id DESC LIMIT ?")
      .bind(HISTORY_ACTIVE).all(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'bio'").first(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'conversation_summary'").first(),
    env.DB.prepare("SELECT key FROM profile WHERE key NOT IN ('bio','conversation_summary') ORDER BY key LIMIT 30").all(),
    env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM memories) AS memories,
        (SELECT COUNT(*) FROM watchers WHERE active = 1) AS watchers,
        (SELECT COUNT(*) FROM research WHERE status IN ('queued','running')) AS research_running`).first(),
  ]);
  return {
    memories: mem.map(r => `- [#${r.id}|${r.category}] ${r.fact}`).join("\n"),
    recalled: mem.length,
    history: hist.results.reverse().map(r => `${r.role}: ${r.content.slice(0, 400)}`).join("\n"),
    bio: bio?.content?.slice(0, 800) || "",
    summary: summary?.content?.slice(0, 2000) || "",
    docs: docs.results.map(r => r.key).join(", "),
    counts,
  };
}

function localNow() {
  // The owner lives in IST. Late UTC evening is already tomorrow for them, so a
  // prompt carrying only UTC makes the model compute weekdays off the wrong day.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "long", day: "2-digit", month: "long",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return { text: `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} IST`, iso };
}

function buildPrompt(ctx, userText, transcript, mustReply) {
  const tools = toolList();
  const nowUtc = new Date().toISOString().slice(0, 16) + "Z";
  const local = localNow();
  return `You are Intelly, the personal AI agent of exactly one owner, living in their Telegram. You handle anything they need: answer questions, research the web, track their applications, set reminders, remember their life. Your standing mission behind it all: find, research, and win opportunities (jobs, internships, hackathons, fellowships, grants, contracts) for them. Be concise and direct — short paragraphs, no corporate fluff, no markdown headers.
Right now it is ${local.text} where the owner is (today's date for them is ${local.iso}). In UTC that is ${nowUtc}.
Always reason about days and weekdays from THEIR local date above — never from the UTC date, which is often the previous day. When they say a weekday, count forward from ${local.text.split(" ")[0]}; "Friday" means the next Friday on or after today, never simply tomorrow.

## What you know about your owner
${ctx.bio || "(no bio yet)"}

Memories relevant to this message${ctx.counts.memories > ctx.recalled ? ` (${ctx.recalled} recalled of ${ctx.counts.memories} you hold — ask and you'll recall others)` : ""}:
${ctx.memories || "(no memories saved yet — when the owner tells you about themselves, save_memory it)"}
${ctx.docs ? `Profile documents you can read_profile: ${ctx.docs}` : "(no profile documents yet — the owner can send any text/markdown file in this chat and you'll keep it)"}
Currently watching ${ctx.counts.watchers} channel(s); ${ctx.counts.research_running} research job(s) in flight.

## Summary of older conversation
${ctx.summary || "(none yet)"}

## Recent conversation
${ctx.history || "(none)"}

## Tools
${tools}

## Rules
- When the owner states a fact, preference, or constraint about themselves, call save_memory with the right category BEFORE doing anything else. Never rely on chat history to retain it.
- Saved memories also steer the opportunity-ranking pipeline (recall terms + rank context) — the more the owner tells you about their skills and goals, the better their alerts get. Encourage it when natural.
- If a new fact contradicts or supersedes a memory, forget_memory the old id, then save the new one.
- Reminder due_at must be UTC ISO — subtract 5:30 from Indian times.
- For questions about current events, prices, or anything outside your corpus, use web_search / web_fetch rather than guessing.
- Quick lookup vs deep dig: web_search/web_fetch answer in seconds and you reply now. spawn_research is for questions worth 10 minutes of an agent's time (interview processes, background on a person or company, "should I do X"). After spawning, reply immediately saying it's running — never wait for it.
- You have no scraper. Opportunities reach you only through channels the owner asked you to watch, so when they mention someone or something worth following, offer to add_watcher it.
- You have senses: their calendar, recruiter mail, and allowlisted phone notifications. Check them before asking the owner something you could look up (get_calendar, search_email, search_notifications).
- You hold their money, body and people. Look things up rather than asking — but never invent a number. If nothing is on file, say so and offer to record it.
- When the owner states a balance, an investment, a debt, a weight, or a detail about a person, PERSIST it first (set_account, set_holding, log_health, remember_person, log_transaction) and only then reply. Doing the arithmetic in your head and moving on loses the data forever.
- NEVER say you saved, recorded, scheduled or watched something unless a tool call actually returned ok. If you only worked it out in your head, say exactly that. A false "I've recorded it" is worse than admitting you didn't.
- When they mention a person by name, log_interaction. Relationships go cold through inattention, not intent, and you are the one keeping count.

## Protocol
Respond with EXACTLY ONE JSON object and nothing else:
  {"tool": "<name>", "args": {...}}   to use a tool
  {"reply": "<final message to the owner>"}   when ready to answer
${mustReply ? 'You are OUT OF TOOL CALLS. You MUST respond with {"reply": ...} now.' : ""}

## Owner's message
${userText}
${transcript ? `\n## Your tool calls so far${transcript}` : ""}

Now output ONLY the JSON object as your final answer message:`;
}

// ---------- The loop ----------

export async function runAgent(env, userText) {
  const ctx = await context(env, userText);
  let transcript = "";
  let lastPlain = ""; // clean-channel prose kept as a last resort, never shipped mid-loop
  for (let step = 0; step < MAX_STEPS; step++) {
    const { text: out, salvaged } = await llm(env, buildPrompt(ctx, userText, transcript, step === MAX_STEPS - 1));
    console.log(`agent step ${step} (salvaged=${salvaged}): ${out.slice(0, 300) || "(empty)"}`);
    const action = extractJson(out);
    if (!action) {
      // No JSON at all. Shipping prose directly proved unsafe — the model
      // sometimes narrates its NEXT tool call ("We will call web_fetch...")
      // in the message channel. Always nudge; keep clean prose as fallback.
      if (!salvaged && out.trim()) lastPlain = out;
      transcript += "\n(Your previous output broke protocol. Respond with ONE valid JSON object: {\"tool\":...} or {\"reply\":...}.)";
      continue;
    }
    if (action.reply) return String(action.reply).slice(0, 3800);
    const tool = TOOLS[action.tool];
    let result;
    if (!tool) {
      result = { error: `unknown tool '${action.tool}'` };
    } else {
      try {
        result = await tool.run(env, action.args || {});
      } catch (e) {
        result = { error: String(e).slice(0, 200) };
      }
    }
    transcript += `\nYou called ${action.tool}(${JSON.stringify(action.args || {})}) -> ${JSON.stringify(result).slice(0, 2500)}`;
  }
  // Out of steps. Never ship loop prose (it can be raw deliberation) — make one
  // protocol-free call that composes an owner-facing answer from the transcript.
  const { text: final, salvaged } = await llm(env,
    `You are Intelly, a personal agent. You ran out of tool budget answering the owner's message. From the transcript below, write the best final message you can — answer what you learned, say plainly what you couldn't confirm. Plain text only, no JSON, 1-4 sentences.\n\nOwner's message: ${userText}\n\nTranscript:${transcript || " (none)"}`);
  if (final.trim() && !salvaged) return final.slice(0, 3800);
  return "I hit my step limit on that one — ask me a bit more specifically?";
}

// ---------- Rolling memory: nothing is forgotten, old chat becomes summary ----------

async function compactHistory(env) {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_history").first()).n;
  if (n <= HISTORY_COMPACT_AT) return;
  const { results: old } = await env.DB.prepare(
    "SELECT id, role, content FROM chat_history ORDER BY id ASC LIMIT ?")
    .bind(n - HISTORY_ACTIVE).all();
  if (!old.length) return;
  const prev = await env.DB.prepare(
    "SELECT content FROM profile WHERE key = 'conversation_summary'").first();
  const { text: merged, salvaged } = await llm(env,
    `You maintain the long-term conversation memory of a personal agent. Merge the older messages below into the running summary. Keep every durable fact, decision, owner preference, and open thread; drop pleasantries and resolved back-and-forth. Dense bullet points, under 300 words total.\n\n` +
    `Current summary:\n${prev?.content || "(none)"}\n\n` +
    `Older messages to fold in:\n${old.map(r => `${r.role}: ${r.content.slice(0, 350)}`).join("\n")}\n\n` +
    `Return ONLY the updated summary text.`);
  const cutoff = old[old.length - 1].id;
  if (merged.trim() && !salvaged) {
    await env.DB.prepare(`
      INSERT INTO profile (key, content, updated_at) VALUES ('conversation_summary', ?, ?)
      ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`)
      .bind(merged.slice(0, 5000), new Date().toISOString()).run();
    await env.DB.prepare("DELETE FROM chat_history WHERE id <= ?").bind(cutoff).run();
  } else if (n > HISTORY_HARD_CAP) {
    // Summarizer keeps failing — cap raw history rather than grow unbounded.
    await env.DB.prepare("DELETE FROM chat_history WHERE id <= ?").bind(cutoff).run();
  }
}

export async function rememberExchange(env, userText, reply) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO chat_history (role, content, at) VALUES ('user', ?, ?), ('assistant', ?, ?)")
    .bind(userText.slice(0, 1000), now, reply.slice(0, 1000), now).run();
  try {
    await compactHistory(env);
  } catch (e) {
    console.log("compactHistory failed:", String(e).slice(0, 200));
  }
}
