// "How I see you" — the agent's honest, self-authored read of its owner.
//
// Honesty is enforced by structure, not by asking nicely: the model must separate
// what it KNOWS (grounded in real rows) from what it INFERS from what it DOESN'T
// know. With an empty brain the only honest output is "I barely know you" — and it
// is made to say exactly that rather than invent a character from nothing.
//
// Generated on demand (a dashboard button), cached in `state`. Never on every load —
// that would spend neurons for no reason.

import { extractJson, llm } from "./llm.js";
import { getPersona } from "./persona.js";

async function gather(env) {
  const q = sql => env.DB.prepare(sql).first();
  const all = sql => env.DB.prepare(sql).all();
  const [mems, bio, skills, resume, summary, docs, counts, apps, money, weight, people] =
    await Promise.all([
      all("SELECT category, fact FROM memories ORDER BY category, id LIMIT 120"),
      q("SELECT content FROM profile WHERE key = 'bio'"),
      q("SELECT length(content) AS n FROM profile WHERE key = 'skills'"),
      q("SELECT length(content) AS n FROM profile WHERE key = 'resume'"),
      q("SELECT content FROM profile WHERE key = 'conversation_summary'"),
      all("SELECT key FROM profile WHERE key LIKE 'doc:%'"),
      q(`SELECT (SELECT COUNT(*) FROM memories) AS memories,
                (SELECT COUNT(*) FROM watchers WHERE active = 1) AS watchers,
                (SELECT COUNT(*) FROM research WHERE status = 'done') AS research_done,
                (SELECT COUNT(*) FROM chat_history) AS chat_rows`),
      q(`SELECT (SELECT COUNT(*) FROM alerts WHERE sent_at IS NOT NULL) AS alerted,
                (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'applied') AS applied,
                (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'won') AS won,
                (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'rejected') AS rejected,
                (SELECT COUNT(*) FROM alerts a WHERE a.sent_at IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.alert_id = a.id
                                   AND o.action IN ('applied','skipped'))) AS pending_unacted`),
      q(`SELECT (SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind != 'card') AS cash,
                (SELECT COALESCE(SUM(value),0) FROM holdings WHERE kind = 'asset') AS assets,
                (SELECT COUNT(*) FROM transactions) AS tx,
                (SELECT COALESCE(SUM(amount),0) FROM transactions
                   WHERE direction = 'debit' AND datetime(at) >= datetime('now','-30 days')) AS spend_30d`),
      q("SELECT value, at FROM health WHERE metric = 'weight' AND value IS NOT NULL ORDER BY at DESC LIMIT 1"),
      q(`SELECT COUNT(*) AS total,
                SUM(CASE WHEN julianday('now') - julianday(COALESCE(last_contact, created_at)) >= 14
                    THEN 1 ELSE 0 END) AS cold
         FROM people WHERE status != 'closed'`),
    ]);
  return {
    memories: mems.results,
    bio: bio?.content?.slice(0, 700) || null,
    has_skills_file: Boolean(skills?.n),
    has_resume: Boolean(resume?.n),
    documents: docs.results.map(d => d.key),
    conversation_summary: summary?.content?.slice(0, 1200) || null,
    counts,
    applications: apps,
    money,
    weight: weight ? { latest: weight.value, at: weight.at } : null,
    people,
  };
}

// The persona's NAME is used here but deliberately NOT its voice. This prompt asks
// "what do you actually think of me — skip the flattery", and a voice the owner
// picked is them grading their own exam. Measured, not theoretical: a flattering
// persona rewrote this and silently dropped "he hasn't applied to anything yet",
// the one finding the whole product exists to surface.
const PROMPT = (persona, data) => `You are ${persona.name}, a personal agent. Your owner asked, bluntly: "what do you
actually think of me?" Answer with your HONEST perception — the real read a sharp assistant would
give if told to skip the flattery. Candid, not cruel; specific, not generic.

THE RULE THAT MATTERS: never invent. Everything below is literally all you know about them. If it
is thin, your honest perception is that you barely know them yet — say that plainly and do not
manufacture a personality from empty data. Separate what you KNOW (backed by the data) from what
you INFER (reasonable reading, labelled as such) from what you DON'T KNOW.

Notice real patterns without lecturing. In particular: opportunities alerted vs applications
actually sent — if they see chances and don't act, that is the single most honest thing you can
reflect back, because applying is the bottleneck, not finding.

## Everything you know about them
${JSON.stringify(data, null, 1)}

Return ONLY this JSON:
{
 "confidence": "low" | "medium" | "high",
 "coverage": "one blunt line on how much you actually have to go on",
 "headline": "one honest sentence — how you'd sum them up right now",
 "read": "2 to 4 sentences of candid interpretation. Who they seem to be, what they're chasing, the pattern you notice. Label inference as inference. If you know almost nothing, this is where you say so honestly.",
 "grounded_in": ["specific things you actually know from the data — real facts only, [] if none"],
 "blind_spots": ["what you don't know that most limits your read of them"],
 "sharpen": ["the 2-3 things they could tell or show you that would improve this most"]
}`;

export async function generatePerception(env) {
  const data = await gather(env);
  const { text, salvaged } = await llm(env, PROMPT(await getPersona(env), data));
  let obj = extractJson(text);
  // extractJson only accepts {reply|tool}; parse the perception shape directly.
  if (!obj || !obj.headline) {
    const m = text.match(/\{[\s\S]*\}/);
    try { obj = m ? JSON.parse(m[0]) : null; } catch { obj = null; }
  }
  if (!obj || !obj.headline || salvaged) {
    return { error: "couldn't compose a perception just now — try again in a moment" };
  }
  const clean = {
    confidence: ["low", "medium", "high"].includes(obj.confidence) ? obj.confidence : "low",
    coverage: String(obj.coverage || "").slice(0, 300),
    headline: String(obj.headline).slice(0, 400),
    read: String(obj.read || "").slice(0, 2000),
    grounded_in: (obj.grounded_in || []).slice(0, 12).map(s => String(s).slice(0, 300)),
    blind_spots: (obj.blind_spots || []).slice(0, 8).map(s => String(s).slice(0, 300)),
    sharpen: (obj.sharpen || []).slice(0, 6).map(s => String(s).slice(0, 300)),
    at: new Date().toISOString(),
  };
  await env.DB.prepare(
    `INSERT INTO state (key, value, updated_at) VALUES ('perception', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(clean), clean.at).run();
  return clean;
}

export async function getPerception(env) {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = 'perception'").first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
