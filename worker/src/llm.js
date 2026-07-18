// The model call, alone in its own module so the tool modules (watch, life) and the
// agent can all use it without importing each other in a circle.

const MODEL = "@cf/openai/gpt-oss-120b";

export async function llm(env, prompt, { timeoutMs = 60_000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      // Workers AI occasionally hangs. Chat turns run on a hard wall-clock budget
      // (the webhook window), so a hung call must lose the race and yield the time
      // back to the loop instead of silently consuming it.
      res = await Promise.race([
        env.AI.run(MODEL, { input: prompt }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("llm call timed out")), timeoutMs)),
      ]);
    } catch (e) {
      console.log(`llm attempt ${attempt} failed: ${String(e).slice(0, 140)}`);
      continue;
    }
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

export function extractJson(text) {
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
