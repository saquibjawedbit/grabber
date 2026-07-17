// Who the agent is when it talks. One row in `state`, read by every prompt that
// speaks to the owner — chat, briefings, weekly, overnight, perception — so the
// voice is the same everywhere instead of five hardcoded "You are Intelly"s.
//
// Voice is styling, never conduct — but know exactly how far that holds. MEASURED
// against the live model with a persona explicitly ordering it to invent numbers
// and claim it had saved things:
//   HELD  — it still answered "0 applications" (the truth) rather than inventing
//           one, and did not claim any tool call it hadn't made. The rules below
//           the voice block win on facts.
//   DID NOT HOLD — tone leaks into judgement. The same persona had it close with
//           "watch the offers roll in!", and it rewrote the perception to drop
//           "he hasn't applied to anything yet" entirely.
// So: voice cannot make it lie, but it CAN make it soft. That is the owner's call
// everywhere it speaks TO them — except perception.js, which takes the name and
// ignores the voice, because "what do you actually think of me" is worthless if
// the person asking picked the tone of the answer.

const KEY = "persona";

export const DEFAULT_PERSONA = {
  name: "Intelly",
  voice: "Concise and direct — short paragraphs, no corporate fluff, no markdown headers.",
};

export const NAME_MAX = 40;
export const VOICE_MAX = 1500;

export async function getPersona(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(KEY).first();
    if (!row?.value) return { ...DEFAULT_PERSONA, custom: false };
    const p = JSON.parse(row.value);
    return {
      name: cleanName(p.name, NAME_MAX) || DEFAULT_PERSONA.name,
      voice: clean(p.voice, VOICE_MAX) || DEFAULT_PERSONA.voice,
      custom: true,
    };
  } catch (e) {
    // A broken persona row must never take the agent down — it just talks plainly.
    console.log("getPersona failed:", String(e).slice(0, 120));
    return { ...DEFAULT_PERSONA, custom: false };
  }
}

export async function setPersona(env, { name, voice }) {
  const p = {
    name: cleanName(name, NAME_MAX) || DEFAULT_PERSONA.name,
    voice: clean(voice, VOICE_MAX) || DEFAULT_PERSONA.voice,
  };
  await env.DB.prepare(`
    INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(KEY, JSON.stringify(p), new Date().toISOString()).run();
  return p;
}

export async function resetPersona(env) {
  await env.DB.prepare("DELETE FROM state WHERE key = ?").bind(KEY).run();
  return { ...DEFAULT_PERSONA, custom: false };
}

/** The block dropped into every prompt. Empty when the voice is the default —
 *  the prompts already read that way, and repeating it just burns tokens. */
export function voiceBlock(persona) {
  if (!persona.custom) return "";
  return `\n## How you talk\n${persona.voice}\nThat covers your voice and tone only. It never licenses you to flatter, to soften a bad fit, or to claim you did something you didn't — the rules below win over it every time.\n`;
}

// Braces and backticks are stripped because the agent loop parses the model's
// reply as ONE JSON object — owner text shaped like {"reply": ...} is asking for
// trouble. Newlines survive in the voice: people write it as lines, and a save
// that silently reflows their text into one paragraph feels broken.
function clean(s, max) {
  return String(s ?? "")
    .replace(/[`{}]/g, "")
    .replace(/[^\S\n]+/g, " ")     // collapse runs of spaces/tabs, keep newlines
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ *\n */g, "\n")
    .trim()
    .slice(0, max);
}

// A name is one line by definition.
function cleanName(s, max) {
  return clean(s, max).replace(/\n+/g, " ").trim();
}
