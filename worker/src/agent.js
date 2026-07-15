// Conversational core: a tool-calling agent loop on Workers AI gpt-oss-120b.
// The model speaks a strict JSON protocol ({"tool": ...} or {"reply": ...}) — more
// portable than native function calling and easy to parse defensively.
//
// Context management: every prompt carries the owner's bio, categorized memories,
// a rolling summary of ALL past conversation, and the recent exchanges verbatim.
// Old chat is compacted into the summary, never dropped.

const MODEL = "@cf/openai/gpt-oss-120b";
const MAX_STEPS = 8;
const HISTORY_ACTIVE = 24;      // recent chat_history rows kept verbatim in the prompt
const HISTORY_COMPACT_AT = 48;  // beyond this, oldest rows fold into the rolling summary
const HISTORY_HARD_CAP = 140;   // safety valve if summarization keeps failing

async function llm(env, prompt) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await env.AI.run(MODEL, { input: prompt });
    const out = res.output || [];
    const msg = out.find(o => o.type === "message");
    const text = msg?.content?.find(c => c.type === "output_text")?.text ?? "";
    if (text.trim()) return { text, salvaged: false };
    // gpt-oss sometimes stops inside its reasoning channel without emitting a
    // final message — the decided JSON may be sitting right there. Salvage it,
    // but flag it so the caller never ships raw reasoning prose to the owner.
    const salvage = out.filter(o => o.type === "reasoning")
      .flatMap(o => o.content || []).map(c => c.text || "").join("\n");
    console.log("llm: no message channel, salvaged:", salvage.slice(0, 200));
    if (salvage.trim()) return { text: salvage, salvaged: true };
  }
  return { text: "", salvaged: true };
}

function extractJson(text) {
  // Scan for the last balanced {...} block — reasoning prose may contain
  // several brace fragments before the real decision.
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === "{") depth++;
      if (ch === "}" && --depth === 0) { candidates.push(text.slice(i, j + 1)); i = j; break; }
    }
  }
  for (const c of candidates.reverse()) {
    try {
      const obj = JSON.parse(c);
      if (obj && (obj.reply || obj.tool)) return obj;
    } catch { /* keep scanning */ }
  }
  return null;
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
      await env.DB.prepare("INSERT INTO memories (fact, category, created_at) VALUES (?, ?, ?)")
        .bind(String(args.fact).slice(0, 500), cat, new Date().toISOString()).run();
      return { ok: true };
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
};

// ---------- Prompt assembly ----------

async function context(env) {
  const [mem, hist, bio, summary, docs] = await Promise.all([
    env.DB.prepare("SELECT id, category, fact FROM memories ORDER BY id DESC LIMIT 80").all(),
    env.DB.prepare("SELECT role, content FROM chat_history ORDER BY id DESC LIMIT ?")
      .bind(HISTORY_ACTIVE).all(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'bio'").first(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'conversation_summary'").first(),
    env.DB.prepare("SELECT key FROM profile WHERE key NOT IN ('bio','conversation_summary') ORDER BY key LIMIT 30").all(),
  ]);
  return {
    memories: mem.results.reverse().map(r => `- [#${r.id}|${r.category}] ${r.fact}`).join("\n"),
    history: hist.results.reverse().map(r => `${r.role}: ${r.content.slice(0, 400)}`).join("\n"),
    bio: bio?.content?.slice(0, 800) || "",
    summary: summary?.content?.slice(0, 2000) || "",
    docs: docs.results.map(r => r.key).join(", "),
  };
}

function buildPrompt(ctx, userText, transcript, mustReply) {
  const toolList = Object.entries(TOOLS).map(([n, t]) => `- ${n}: ${t.desc}`).join("\n");
  const nowUtc = new Date().toISOString().slice(0, 16) + "Z";
  return `You are Intelly, the personal AI agent of exactly one owner, living in their Telegram. You handle anything they need: answer questions, research the web, track their applications, set reminders, remember their life. Your standing mission behind it all: find, research, and win opportunities (jobs, internships, hackathons, fellowships, grants, contracts) for them. Be concise and direct — short paragraphs, no corporate fluff, no markdown headers.
Now: ${nowUtc} (UTC). Owner's timezone: Asia/Kolkata, UTC+5:30 — convert times for reminders and when talking about time.

## What you know about your owner
${ctx.bio || "(no bio yet)"}
${ctx.memories || "(no memories saved yet — when the owner tells you about themselves, save_memory it)"}
${ctx.docs ? `Profile documents you can read_profile: ${ctx.docs}` : "(no profile documents yet — the owner can send any text/markdown file in this chat and you'll keep it)"}

## Summary of older conversation
${ctx.summary || "(none yet)"}

## Recent conversation
${ctx.history || "(none)"}

## Tools
${toolList}

## Rules
- When the owner states a fact, preference, or constraint about themselves, call save_memory with the right category BEFORE doing anything else. Never rely on chat history to retain it.
- Saved memories also steer the opportunity-ranking pipeline (recall terms + rank context) — the more the owner tells you about their skills and goals, the better their alerts get. Encourage it when natural.
- If a new fact contradicts or supersedes a memory, forget_memory the old id, then save the new one.
- Reminder due_at must be UTC ISO — subtract 5:30 from Indian times.
- For questions about current events, prices, or anything outside your corpus, use web_search / web_fetch rather than guessing.

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
  const ctx = await context(env);
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
