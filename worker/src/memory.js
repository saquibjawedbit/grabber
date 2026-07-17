// The memory layer, lifted out of the agent loop on purpose.
//
// v3 kept memory inside the loop: save_memory was a tool, so remembering cost a
// step and competed with answering. The model almost always chose to answer —
// 12 hours of real conversation (a job lead, a whole thread about a person)
// produced zero memories while the loop happily replied to all of it.
//
// v4 decouples them. The agent still has save_memory for when it deliberately
// wants to record something, but every exchange is ALSO swept afterwards by
// extract(), outside the loop, where remembering costs the owner nothing and
// cannot lose a race against the reply.

import { extractJson, llm } from "./llm.js";

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";  // 384-dim, plenty for short facts
const RECALL_K = 14;            // memories retrieved per turn (by meaning, not recency)
const NEAR_DUPLICATE = 0.90;    // cosine above this = the same fact, differently worded
export const CATEGORIES = ["identity", "preference", "skill", "goal", "project", "contact", "health", "money", "fact"];

// ---------- Vectors: packed as base64 Float32, normalised at write time so
// recall is a dot product. JSON arrays would blow the Worker's CPU budget. ----------

export async function embed(env, text) {
  const res = await env.AI.run(EMBED_MODEL, { text: [String(text).slice(0, 1200)] });
  const v = res?.data?.[0];
  if (!Array.isArray(v) || !v.length) throw new Error("embedding came back empty");
  const norm = Math.hypot(...v) || 1;
  return Float32Array.from(v, x => x / norm);
}

export function packVec(f32) {
  const bytes = new Uint8Array(f32.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unpackVec(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ---------- Vectorize: the index that removes the 400-row ceiling ----------
// The scan below (`ORDER BY id DESC LIMIT 400`) was correct but capped: past 400
// memories, old facts silently stopped being recalled AND stopped blocking
// duplicates. Vectorize searches the whole set. D1 stays the source of truth —
// facts and packed vectors both — so the index is disposable and rebuildable
// (/api/vector-backfill). Every call here fails soft: a down index must never
// lose a write or a recall, so callers fall back to the D1 scan on null.

async function vecQuery(env, f32, topK) {
  if (!env.VECTORIZE) return null;
  try {
    const r = await env.VECTORIZE.query(Array.from(f32), { topK });
    // Zero matches means an EMPTY index (query returns nearest-K regardless of
    // similarity), i.e. deployed-but-not-backfilled. Treat as unavailable so the
    // scan answers instead of "no memories" / "no duplicate".
    return r?.matches?.length ? r.matches : null;
  } catch (e) {
    console.log("vectorize query failed:", String(e).slice(0, 120));
    return null;
  }
}

async function vecUpsert(env, id, f32, category) {
  if (!env.VECTORIZE) return false;
  try {
    await env.VECTORIZE.upsert([{ id: String(id), values: Array.from(f32), metadata: { category: category || "fact" } }]);
    return true;
  } catch (e) {
    console.log("vectorize upsert failed:", String(e).slice(0, 120));
    return false;
  }
}

async function vecDelete(env, ids) {
  if (!env.VECTORIZE || !ids.length) return;
  try {
    await env.VECTORIZE.deleteByIds(ids.map(String));
  } catch (e) {
    console.log("vectorize delete failed:", String(e).slice(0, 120));
  }
}

// ---------- Recall ----------

export async function recallMemories(env, query) {
  let q = null;
  try { q = await embed(env, query); } catch { /* scan path falls back to newest */ }

  // Primary: Vectorize over the WHOLE set, then hydrate facts from D1 (the source
  // of truth). Ids whose D1 row is gone (desync) just drop out of the hydration.
  const matches = q ? await vecQuery(env, q, RECALL_K) : null;
  if (matches) {
    // Un-embedded rows (embedding failed, or saved before v3) always ride along —
    // better a slightly bigger prompt than silently forgetting a fact.
    const { results: plain } = await env.DB.prepare(
      "SELECT id, category, fact FROM memories WHERE embedding IS NULL ORDER BY id DESC LIMIT 12").all();
    const ids = matches.map(m => Number(m.id)).filter(Boolean);
    const { results } = await env.DB.prepare(
      `SELECT id, category, fact FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all();
    const byId = new Map(results.map(r => [r.id, r]));
    const rows = matches.map(m => byId.has(Number(m.id))
      ? { ...byId.get(Number(m.id)), sim: m.score } : null).filter(Boolean);
    return [...plain, ...rows];
  }

  // Fallback: the pre-Vectorize scan — newest 400 rows, cosine in JS. Correct but
  // capped; only reached when the index is unbound, empty, or erroring.
  const { results } = await env.DB.prepare(
    "SELECT id, category, fact, embedding FROM memories ORDER BY id DESC LIMIT 400").all();
  if (!results.length) return [];
  const embedded = results.filter(r => r.embedding);
  const plain = results.filter(r => !r.embedding).slice(0, 12);
  if (!embedded.length) return plain;
  if (!q) return results.slice(0, RECALL_K);
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
    const row = await env.DB.prepare("SELECT category FROM memories WHERE id = ?").bind(id).first();
    await vecUpsert(env, id, v, row?.category);   // mirror into the index (fail-soft)
    return true;
  } catch (e) {
    console.log("embedMemory failed:", String(e).slice(0, 120));
    return false;
  }
}

// ---------- Write ----------

/**
 * Insert a fact, unless we already hold it. Returns {id, status}.
 * exclude: ids to ignore when checking for duplicates — a reconciled fact is
 * meant to replace its sources, so it must not be rejected as a copy of them.
 */
export async function saveMemory(env, fact, category, { source = "chat", context = null, exclude = [] } = {}) {
  fact = String(fact || "").trim();
  if (!fact) return { status: "empty" };
  if (!CATEGORIES.includes(category)) category = "fact";

  let vec = null;
  try {
    vec = await embed(env, fact);
  } catch { /* fall through: store unembedded rather than lose the fact */ }

  if (vec) {
    // Dedupe on meaning, not string equality — "22 years old" and "is 22" are
    // one fact, and v3 happily stored both spellings side by side.
    const skip = new Set(exclude.map(Number));
    // Primary: ask Vectorize for the nearest neighbours across the WHOLE set.
    const matches = await vecQuery(env, vec, 8);
    if (matches) {
      for (const m of matches) {
        const id = Number(m.id);
        if (skip.has(id) || m.score < NEAR_DUPLICATE) continue;
        const row = await env.DB.prepare("SELECT id, fact FROM memories WHERE id = ?").bind(id).first();
        if (row) return { id: row.id, status: "duplicate", of: row.fact };
        await vecDelete(env, [id]);   // stale: in the index but gone from D1 — clean it up
      }
    } else {
      // Fallback scan — capped at the newest 400; only when the index can't answer.
      const { results } = await env.DB.prepare(
        "SELECT id, fact, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY id DESC LIMIT 400").all();
      for (const r of results) {
        if (skip.has(r.id)) continue;
        let sim = -1;
        try { sim = dot(vec, unpackVec(r.embedding)); } catch { continue; }
        if (sim >= NEAR_DUPLICATE) return { id: r.id, status: "duplicate", of: r.fact };
      }
    }
  }

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO memories (fact, category, created_at, updated_at, source, context)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(fact, category, now, now, source, context ? String(context).slice(0, 600) : null).first();
  if (vec) {
    await env.DB.prepare("UPDATE memories SET embedding = ? WHERE id = ?")
      .bind(packVec(vec), row.id).run();
    await vecUpsert(env, row.id, vec, category);   // mirror into the index (fail-soft)
  }
  return { id: row.id, status: "saved" };
}

export async function forgetMemory(env, id) {
  const r = await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(Number(id)).run();
  // Keep the index in step — reconcile()'s merge/forget flows both route through
  // here and saveMemory, so the two stores can't drift apart in normal operation.
  if (r.meta.changes > 0) await vecDelete(env, [Number(id)]);
  return r.meta.changes > 0;
}

// ---------- Extraction: the part that runs after the reply is already sent ----------

const EXTRACT_PROMPT = `You maintain the long-term memory of a personal AI agent, for exactly one owner.

Below is one exchange between the owner and the agent, plus the memories you already hold that are closest to it.

Decide what — if anything — is worth remembering FOREVER from this exchange.

Save a fact when the owner reveals something durable about their life: who they are, what they want, what they're working on, people in their life and where things stand with them, their health, their money, their plans, their preferences, their constraints. Opportunities they mention (a role, a company, a deadline) are durable. So are the people they talk about, even in passing.

Do NOT save: pleasantries, the agent's own suggestions, anything the owner asked as a pure question, transient chatter with no lasting fact in it, or anything already covered by the memories listed below.

Write each fact standalone and in the third person, so it still makes sense years later with no surrounding conversation. Include names and specifics. Never write "she" or "that role" — name them, or say what is known.

If a new fact CONTRADICTS or UPDATES a memory you hold, list that memory's id in "forget" and save the corrected version. Facts that merely add detail are not contradictions.

Categories: ${CATEGORIES.join(", ")}.

## Memories you already hold
{existing}

## The exchange
Owner: {user}
Agent: {reply}

Respond with EXACTLY ONE JSON object, nothing else:
{"save": [{"fact": "...", "category": "..."}], "forget": [id, ...]}
Both lists may be empty. Most exchanges yield 0-2 facts; do not pad.

Output ONLY the JSON:`;

/**
 * Sweep one exchange for durable facts. Safe to call from waitUntil — it never
 * throws into the caller and never blocks the owner's reply.
 * dry: report what it would learn without writing. Use it before a backfill —
 * memory is the one table where a bad batch is expensive to unpick by hand.
 * allowForget: let this exchange supersede existing memories. True live, where
 * the newest thing the owner said is by definition the current one. False when
 * replaying history, where "newest exchange wins" is meaningless and lets an old
 * message delete something learned after it — two passes over a history holding
 * both "21" and "22" will otherwise flip the age back and forth forever.
 */
export async function extract(env, userText, reply, { dry = false, allowForget = true, source = "auto" } = {}) {
  try {
    const near = await recallMemories(env, `${userText}\n${reply}`);
    const existing = near.length
      ? near.map(r => `- [#${r.id}|${r.category}] ${r.fact}`).join("\n")
      : "(none yet)";
    const prompt = EXTRACT_PROMPT
      .replace("{existing}", existing)
      .replace("{user}", String(userText).slice(0, 1500))
      .replace("{reply}", String(reply).slice(0, 1500));

    const { text, salvaged } = await llm(env, prompt);
    const action = extractJson(text) || parseMemoryJson(text);
    if (!action) {
      console.log("extract: no JSON from model", salvaged ? "(salvaged)" : "", text.slice(0, 160));
      return { saved: [], forgot: [] };
    }

    const candidates = Array.isArray(action.save) ? action.save.slice(0, 4) : [];
    const forgetIds = allowForget && Array.isArray(action.forget) ? action.forget.slice(0, 5) : [];
    if (dry) return { saved: candidates, forgot: forgetIds, dry: true };

    const forgot = [];
    for (const id of forgetIds) {
      if (await forgetMemory(env, id)) forgot.push(Number(id));
    }

    const saved = [];
    for (const cand of candidates) {
      const r = await saveMemory(env, cand.fact, cand.category, {
        source,
        context: `${String(userText).slice(0, 280)}`,
      });
      if (r.status === "saved") saved.push({ id: r.id, fact: cand.fact, category: cand.category });
    }
    if (saved.length || forgot.length) {
      console.log(`extract: +${saved.length} -${forgot.length}`, saved.map(s => s.fact.slice(0, 60)));
    }
    return { saved, forgot };
  } catch (e) {
    console.log("extract failed:", String(e).slice(0, 200));
    return { saved: [], forgot: [] };
  }
}

// extractJson() only accepts objects carrying `reply` or `tool` — this shape has
// neither, so scan for our own.
function parseMemoryJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return (o && (Array.isArray(o.save) || Array.isArray(o.forget))) ? o : null;
  } catch { return null; }
}

// ---------- Reconcile: audit the memories against each other ----------

// extract() only compares a NEW fact against what's held, so contradictions that
// arrived separately just coexist — v3 held both "22 years old" and "21 years old",
// and near-duplicate identity facts saved minutes apart. Nothing ever re-read the
// set as a whole. This does.
const RECONCILE_PROMPT = `You are auditing the long-term memory of a personal AI agent. Below is everything it currently believes about its owner.

Find only two kinds of problem:
1. CONTRADICTIONS — two memories that cannot both be true (different ages, conflicting facts). Keep whichever is most likely current; if you cannot tell, keep the one with the higher id (saved later).
2. DUPLICATES — two or more memories stating the same thing in different words. Merge them into one fact that keeps every detail from each.

Do NOT touch memories that merely relate to each other, add detail, or sit in the same category. Different facts about the same topic are not duplicates. If nothing is wrong, return an empty list — that is the expected answer.

## Memories
{memories}

For each problem, output the ids to remove and the single fact that should replace them.
Respond with EXACTLY ONE JSON object, nothing else:
{"fixes": [{"forget": [id, ...], "fact": "the merged or corrected fact", "category": "...", "why": "contradiction|duplicate"}]}

Output ONLY the JSON:`;

export async function reconcile(env, { dry = false } = {}) {
  const { results } = await env.DB.prepare(
    "SELECT id, category, fact FROM memories ORDER BY id ASC LIMIT 200").all();
  if (results.length < 2) return { fixes: [], dry };
  const { text } = await llm(env, RECONCILE_PROMPT.replace("{memories}",
    results.map(r => `- [#${r.id}|${r.category}] ${r.fact}`).join("\n")));
  const m = String(text).match(/\{[\s\S]*\}/);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { /* fall through */ }
  const fixes = Array.isArray(parsed?.fixes) ? parsed.fixes.slice(0, 10) : [];
  if (dry) return { fixes, dry: true };

  const applied = [];
  for (const f of fixes) {
    const ids = (Array.isArray(f.forget) ? f.forget : []).map(Number).filter(Boolean);
    if (!ids.length || !f.fact) continue;
    // Write the merged fact BEFORE removing its sources, ignoring those sources in
    // the duplicate check. Deleting first risks the save being rejected as a copy
    // of some third memory, which would drop the originals and keep no merge.
    const r = await saveMemory(env, f.fact, f.category, {
      source: "auto",
      context: `reconciled ${ids.map(i => "#" + i).join(", ")} (${f.why || "duplicate"})`,
      exclude: ids,
    });
    if (r.status === "saved") {
      for (const id of ids) await forgetMemory(env, id);
    } else if (r.status === "duplicate" && !ids.includes(r.id)) {
      // The merge already exists elsewhere — drop the redundant sources, keep that one.
      for (const id of ids) await forgetMemory(env, id);
    } else {
      applied.push({ forgot: [], fact: f.fact, status: "skipped", why: f.why });
      continue;
    }
    applied.push({ forgot: ids, fact: f.fact, status: r.status, why: f.why });
  }
  return { fixes: applied, dry: false };
}

// ---------- Backfill: history that was written before the sweep existed ----------

export async function backfill(env, { limit = 60, dry = false } = {}) {
  const { results } = await env.DB.prepare(
    "SELECT id, role, content, at FROM chat_history ORDER BY id ASC LIMIT ?").bind(limit * 2).all();
  // Walk user->assistant pairs, the same unit extract() sees live.
  const pairs = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].role !== "user") continue;
    const next = results[i + 1];
    pairs.push({ user: results[i].content, reply: next?.role === "assistant" ? next.content : "" });
  }
  const learned = [];
  for (const p of pairs.slice(0, limit)) {
    // Additive only. Contradictions among what it learns are reconcile()'s job —
    // that pass sees every memory at once, which is the only vantage point from
    // which "which of these two is true" is answerable.
    const r = await extract(env, p.user, p.reply, { dry, allowForget: false });
    for (const s of r.saved) learned.push({ from: p.user.slice(0, 60), fact: s.fact, category: s.category });
  }
  return { exchanges: Math.min(pairs.length, limit), saved: learned.length, learned, dry };
}
