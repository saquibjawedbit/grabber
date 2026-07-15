// Phase 1 conversational core: a tool-calling agent loop on Workers AI gpt-oss-120b.
// The model speaks a strict JSON protocol ({"tool": ...} or {"reply": ...}) — more
// portable than native function calling and easy to parse defensively.

const MODEL = "@cf/openai/gpt-oss-120b";
const MAX_STEPS = 5;
const HISTORY_KEEP = 60; // rows kept in chat_history (30 exchanges)

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

// ---------- Tools ----------

const TOOLS = {
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

  save_memory: {
    desc: 'store a durable fact about the owner (preferences, skills, goals, constraints). args: {"fact": "..."}',
    run: async (env, args) => {
      if (!args.fact) return { error: "empty fact" };
      await env.DB.prepare("INSERT INTO memories (fact, created_at) VALUES (?, ?)")
        .bind(String(args.fact).slice(0, 500), new Date().toISOString()).run();
      return { ok: true };
    },
  },
};

// ---------- Prompt assembly ----------

async function context(env) {
  const [mem, hist, bio] = await Promise.all([
    env.DB.prepare("SELECT fact FROM memories ORDER BY id DESC LIMIT 50").all(),
    env.DB.prepare("SELECT role, content FROM chat_history ORDER BY id DESC LIMIT 12").all(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'bio'").first(),
  ]);
  return {
    memories: mem.results.map(r => `- ${r.fact}`).reverse().join("\n"),
    history: hist.results.reverse().map(r => `${r.role}: ${r.content.slice(0, 400)}`).join("\n"),
    bio: bio?.content?.slice(0, 800) || "",
  };
}

function buildPrompt(ctx, userText, transcript, mustReply) {
  const toolList = Object.entries(TOOLS).map(([n, t]) => `- ${n}: ${t.desc}`).join("\n");
  return `You are Intelly, the personal agent of exactly one owner. Your life purpose: find, research, and win opportunities (hackathons, fellowships, grants, jobs, contracts) for them. You live in their Telegram. Be concise and direct — short paragraphs, no corporate fluff, no markdown headers.
Today is ${new Date().toISOString().slice(0, 10)}.

## What you know about your owner
${ctx.bio || "(no bio seeded yet)"}
${ctx.memories || "(no memories saved yet — when the owner tells you about themselves, save_memory it)"}

## Recent conversation
${ctx.history || "(none)"}

## Tools
${toolList}

## Rules
- When the owner states a fact, preference, or constraint about themselves, call save_memory with it BEFORE doing anything else. Never rely on chat history to retain it.

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
  for (let step = 0; step < MAX_STEPS; step++) {
    const { text: out, salvaged } = await llm(env, buildPrompt(ctx, userText, transcript, step === MAX_STEPS - 1));
    console.log(`agent step ${step} (salvaged=${salvaged}): ${out.slice(0, 300) || "(empty)"}`);
    const action = extractJson(out);
    if (!action) {
      // A clean message channel without JSON = the model chose to speak plainly.
      // Salvaged reasoning without JSON = an aborted step; nudge and retry.
      if (!salvaged && out.trim()) return out.slice(0, 3800);
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
  return "I hit my step limit on that one — ask me a bit more specifically?";
}

export async function rememberExchange(env, userText, reply) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO chat_history (role, content, at) VALUES ('user', ?, ?), ('assistant', ?, ?)")
    .bind(userText.slice(0, 1000), now, reply.slice(0, 1000), now).run();
  await env.DB.prepare(
    "DELETE FROM chat_history WHERE id NOT IN (SELECT id FROM chat_history ORDER BY id DESC LIMIT ?)")
    .bind(HISTORY_KEEP).run();
}
