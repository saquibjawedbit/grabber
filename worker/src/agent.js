import { APPLY_TOOLS } from "./apply.js";
import { LIFE_TOOLS } from "./life.js";
import { extractJson, llm } from "./llm.js";
import { CATEGORIES as MEMORY_CATEGORIES, embedMemory, extract, forgetMemory, recallMemories, saveMemory } from "./memory.js";
import { getPersona, voiceBlock } from "./persona.js";
import { SYSTEM_TOOLS, logActivity } from "./system.js";

export { llm, embedMemory };

const MAX_STEPS = 8;
const HISTORY_ACTIVE = 24;      // recent chat_history rows kept verbatim in the prompt
const HISTORY_COMPACT_AT = 48;  // beyond this, oldest rows fold into the rolling summary
const HISTORY_HARD_CAP = 140;   // safety valve if summarization keeps failing

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

export const TOOLS = {
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
      const r = await saveMemory(env, String(args.fact).slice(0, 500), args.category, { source: "chat" });
      if (r.status === "duplicate") return { ok: true, id: r.id, note: "already known, kept the existing one" };
      return r.status === "saved" ? { ok: true, id: r.id } : { error: "empty fact" };
    },
  },

  forget_memory: {
    desc: 'delete a memory that is wrong or superseded. args: {"id": <number from the memory list>}',
    run: async (env, args) => {
      if (!args.id) return { error: "need the memory id" };
      return await forgetMemory(env, args.id) ? { ok: true } : { error: "no memory with that id" };
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
      await logActivity(env, {
        kind: "research",
        summary: `Started deep research: ${question.slice(0, 140)}`,
        detail: `depth ${depth} · running on a real machine (~5-15 min)`,
      });
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

  ...SYSTEM_TOOLS,
  ...APPLY_TOOLS,
  ...LIFE_TOOLS,
};

// The tool list is long enough now that a flat dump reads as noise. Group it so the
// model can find the right shelf before the right tool.
// Most tools now carry their own `group` (SYSTEM_TOOLS, APPLY_TOOLS, LIFE_TOOLS); this
// covers the rest defined inline above.
const TOOL_GROUPS = {
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
  const [mem, hist, bio, summary, docs, counts, persona] = await Promise.all([
    recallMemories(env, userText),   // v3: relevant to THIS message, not simply the newest
    env.DB.prepare("SELECT role, content FROM chat_history ORDER BY id DESC LIMIT ?")
      .bind(HISTORY_ACTIVE).all(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'bio'").first(),
    env.DB.prepare("SELECT content FROM profile WHERE key = 'conversation_summary'").first(),
    env.DB.prepare("SELECT key FROM profile WHERE key NOT IN ('bio','conversation_summary') ORDER BY key LIMIT 30").all(),
    env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM memories) AS memories,
        (SELECT COUNT(*) FROM goals WHERE status = 'active') AS active_goals,
        (SELECT COUNT(*) FROM quests WHERE status IN ('issued','doing')) AS open_quests,
        (SELECT COUNT(*) FROM research WHERE status IN ('queued','running')) AS research_running`).first(),
    getPersona(env),
  ]);
  return {
    memories: mem.map(r => `- [#${r.id}|${r.category}] ${r.fact}`).join("\n"),
    recalled: mem.length,
    history: hist.results.reverse().map(r => `${r.role}: ${r.content.slice(0, 400)}`).join("\n"),
    bio: bio?.content?.slice(0, 800) || "",
    summary: summary?.content?.slice(0, 2000) || "",
    docs: docs.results.map(r => r.key).join(", "),
    counts,
    persona,
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
  return `You are ${ctx.persona.name}, the personal agent of exactly one owner, living in their Telegram. You are their strict mentor, and you run a quest System. Your ONE standing motive behind everything: drive the owner to achieve their declared goals — no matter what. You issue quests, hold them accountable, get things done for them (research, applications, reminders), and refuse to let goals quietly die. You also handle anything else they need: answer questions, research the web, remember their life, track their money, body and people — but always in service of moving them forward.
${voiceBlock(ctx.persona)}
Right now it is ${local.text} where the owner is (today's date for them is ${local.iso}). In UTC that is ${nowUtc}.
Always reason about days and weekdays from THEIR local date above — never from the UTC date, which is often the previous day. When they say a weekday, count forward from ${local.text.split(" ")[0]}; "Friday" means the next Friday on or after today, never simply tomorrow.

## What you know about your owner
${ctx.bio || "(no bio yet)"}

Memories relevant to this message${ctx.counts.memories > ctx.recalled ? ` (${ctx.recalled} recalled of ${ctx.counts.memories} you hold — ask and you'll recall others)` : ""}:
${ctx.memories || "(no memories saved yet — when the owner tells you about themselves, save_memory it)"}
${ctx.docs ? `Profile documents you can read_profile: ${ctx.docs}` : "(no profile documents yet — the owner can send any text/markdown file in this chat and you'll keep it)"}
Driving ${ctx.counts.active_goals} active goal(s); ${ctx.counts.open_quests} quest(s) open; ${ctx.counts.research_running} research job(s) in flight.

## Summary of older conversation
${ctx.summary || "(none yet)"}

## Recent conversation
${ctx.history || "(none)"}

## Tools
${tools}

## Rules
- GOALS ARE EVERYTHING. If the owner has no active goals, your first job is to pull them out — what are they trying to become, by when? — and set_goal them. Do not let a conversation drift without tying it back to a goal. Vague intentions ("I should get fit") become concrete goals with a target and a deadline, or they don't count.
- Turn goals into action. When it moves a goal forward, add_quest a concrete, done-tonight task rather than just talking about it. Quests are issued automatically each morning and reckoned each night; you can also set or resolve them on demand. Push — never accept "I'll do it later" without a quest and a time.
- Be a strict mentor, not a cheerleader. When the owner is slipping — a broken streak, a failed quest, a goal going quiet — say it plainly and demand better. Never flatter. Never soften a real number. Encouragement is earned by results.
- Every exchange is swept for durable facts after you reply, so you do NOT need to spend a step saving what the owner just told you — it is already being kept. Use save_memory only when the owner explicitly asks you to remember something, or for a derived fact the sweep couldn't see from the text alone.
- The more the owner tells you about their skills and goals, the sharper your quests get — encourage it when natural.
- If a new fact contradicts or supersedes a memory, forget_memory the old id, then save the new one.
- Reminder due_at must be UTC ISO — subtract 5:30 from Indian times.
- For current events, prices, or anything you don't know, use web_search / web_fetch rather than guessing.
- Quick lookup vs deep dig: web_search/web_fetch answer in seconds and you reply now. spawn_research is for questions worth 10 minutes of an agent's time (interview processes, background on a person or company, "should I do X"). After spawning, reply immediately saying it's running — never wait for it.
- Get things done FOR them. When they mention or link a specific job/fellowship/role, proactively draft_application for it — that is you removing a barrier to a goal. Give the honest fit first; if it's low, say so plainly rather than cheerlead.
- You have senses: their calendar, recruiter mail, and allowlisted phone notifications. Check them before asking the owner something you could look up (get_calendar, search_email, search_notifications).
- You hold their money, body and people. Look things up rather than asking — but never invent a number. If nothing is on file, say so and offer to record it.
- When the owner states a balance, an investment, a debt, a weight, or a detail about a person, PERSIST it first (set_account, set_holding, log_health, remember_person, log_transaction) and only then reply. Doing the arithmetic in your head and moving on loses the data forever.
- NEVER say you saved, recorded, scheduled, set a quest, or did anything unless a tool call actually returned ok. A false "done" is worse than admitting you didn't.
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
    `You are ${ctx.persona.name}, a personal agent. You ran out of tool budget answering the owner's message. From the transcript below, write the best final message you can — answer what you learned, say plainly what you couldn't confirm. Plain text only, no JSON, 1-4 sentences.${voiceBlock(ctx.persona)}\n\nOwner's message: ${userText}\n\nTranscript:${transcript || " (none)"}`);
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
  // The reply is already with the owner, so this costs them nothing — and unlike
  // save_memory inside the loop, it never loses a race against answering.
  await extract(env, userText, reply);
  try {
    await compactHistory(env);
  } catch (e) {
    console.log("compactHistory failed:", String(e).slice(0, 200));
  }
}
