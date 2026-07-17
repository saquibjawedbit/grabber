// The bottleneck isn't finding opportunities — it's applying to them. This turns any
// opportunity (a URL, a pasted JD, or a description) into a tailored, copy-paste-ready
// application pack, drawn from the owner's real résumé, and tracks it through the
// pipeline. One honest fit score up front so no time is wasted on bad matches.

import { llm } from "./llm.js";
import { logActivity } from "./system.js";

const STATUSES = ["ready", "applied", "responded", "interview", "offer", "rejected", "dropped"];

const strip = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, " ").trim();

async function ownerProfile(env) {
  const parts = [];
  for (const key of ["resume", "bio", "skills"]) {
    const row = await env.DB.prepare("SELECT content FROM profile WHERE key = ?").bind(key).first();
    if (row) parts.push(`### ${key}\n${row.content.slice(0, 3500)}`);
  }
  const { results: mems } = await env.DB.prepare(
    "SELECT category, fact FROM memories ORDER BY category, id LIMIT 50").all();
  if (mems.length) parts.push("### stated\n" + mems.map(m => `- (${m.category}) ${m.fact}`).join("\n"));
  return parts.join("\n\n");
}

const PACK_PROMPT = (profile, jd) => `You are helping one specific person apply to an opportunity.
Everything you write must be grounded in their REAL résumé below — reuse their actual projects,
metrics, and companies. Never invent an achievement, a number, or a technology they don't have.

## The person (their real résumé and profile)
${profile || "(no résumé on file — say so and keep the pack generic)"}

## The opportunity
${jd.slice(0, 6000)}

## Your job
First judge fit honestly — if their background is a weak match, say so and score low; a wasted
application costs them more than a skipped one. Then write a pack they can paste with almost no
editing, in their own plain, confident voice (no corporate filler, no "I am writing to express").

Return ONLY this JSON:
{
 "title": "the role + company, e.g. 'Backend Engineer at Acme'",
 "company": "company name or null",
 "fit": 0-10,
 "fit_reason": "one honest sentence — should they apply, and why / why not",
 "cover_note": "150-220 words they can paste into the form or send as a DM. Their voice. Leads with the single most relevant proof point from their résumé for THIS role.",
 "resume_bullets": ["3-5 of their REAL achievements, each rephrased to hit what this role wants"],
 "answers": [
   {"q": "Why you / why this role?", "a": "grounded in their actual edge"},
   {"q": "Tell us about a relevant project", "a": "uses a real project of theirs"},
   {"q": "Why this company?", "a": "specific to the opportunity; if you lack company detail, say what they should look up"}
 ],
 "before_you_send": ["what this application will likely ask for — links, portfolio, references — so nothing surprises them mid-form"]
}`;

function packToMarkdown(v) {
  const lines = [`# ${v.title}`, "", `**Honest fit: ${v.fit}/10** — ${v.fit_reason}`, "",
    "## Cover note", v.cover_note, "", "## Résumé bullets to lead with",
    ...(v.resume_bullets || []).map(b => `- ${b}`), "", "## Likely questions",
    ...(v.answers || []).flatMap(a => [`**${a.q}**`, a.a, ""]), "## Before you send",
    ...(v.before_you_send || []).map(b => `- ${b}`)];
  return lines.join("\n");
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export const APPLY_TOOLS = {
  draft_application: {
    group: "Applications",
    desc: 'build a ready-to-send application pack for an opportunity. args: {"opportunity": "a full http(s) url, OR the pasted job description, OR a plain description of the role"}. Fetches the page if given a url.',
    args: { opportunity: { type: "string", required: true } },
    run: async (env, args) => {
      let jd = String(args.opportunity || "").trim();
      if (!jd) return { error: "give me a url, a pasted job description, or a description of the role" };
      let url = null;
      if (/^https?:\/\//.test(jd)) {
        url = jd;
        try {
          const r = await fetch(jd, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" } });
          const text = strip(await r.text());
          jd = text.length > 200 ? text : `(couldn't read much from ${url})\n${text}`;
        } catch {
          return { error: `couldn't fetch ${url} — paste the job description text instead` };
        }
      }
      const profile = await ownerProfile(env);
      const { text, salvaged } = await llm(env, PACK_PROMPT(profile, jd));
      const v = extractJson(text);
      if (!v || !v.cover_note || salvaged) return { error: "the pack came back malformed — try again" };

      const pack = packToMarkdown(v);
      const row = await env.DB.prepare(
        `INSERT INTO applications (title, company, url, source, fit, cover_note, package_md, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
        .bind(String(v.title || "Untitled role").slice(0, 200), v.company || null, url,
              url ? "manual-url" : "manual", Number(v.fit) || 0,
              String(v.cover_note).slice(0, 4000), pack.slice(0, 12000),
              new Date().toISOString(), new Date().toISOString()).first();
      await logActivity(env, {
        kind: "application",
        summary: `Drafted application: ${String(v.title || "role").slice(0, 140)}`,
        detail: `honest fit ${Number(v.fit) || 0}/10 — ${String(v.fit_reason || "").slice(0, 200)}`,
      });
      return {
        ok: true, id: row.id, title: v.title, fit: v.fit, fit_reason: v.fit_reason,
        cover_note: v.cover_note,
        note: "Full pack (bullets, Q&A, checklist) saved — it's on the dashboard Applications view, or ask me for any part. Show the owner the fit and the cover note; if fit is low, say so honestly.",
      };
    },
  },

  get_application: {
    group: "Applications",
    desc: 'read a saved application pack. args: {"id": <number>} for the full pack, or {} to list them',
    run: async (env, args) => {
      if (args.id) {
        const row = await env.DB.prepare(
          "SELECT id, title, company, url, fit, status, package_md FROM applications WHERE id = ?")
          .bind(Number(args.id)).first();
        return row ? { ...row, package_md: row.package_md.slice(0, 3500) } : { error: "no application with that id" };
      }
      const { results } = await env.DB.prepare(
        "SELECT id, title, company, fit, status, created_at, applied_at FROM applications ORDER BY id DESC LIMIT 20").all();
      return { count: results.length, applications: results };
    },
  },

  set_application_status: {
    group: "Applications",
    desc: `move an application through the pipeline. args: {"id": <number>, "status": one of ${STATUSES.join("|")}}`,
    args: { id: { type: "number", required: true }, status: { type: "string", required: true, enum: STATUSES } },
    run: async (env, args) => {
      if (!args.id) return { error: "need the application id" };
      const status = STATUSES.includes(args.status) ? args.status : null;
      if (!status) return { error: `status must be one of: ${STATUSES.join(", ")}` };
      const appliedAt = status === "applied" ? new Date().toISOString() : null;
      const r = await env.DB.prepare(
        `UPDATE applications SET status = ?, updated_at = ?,
           applied_at = COALESCE(applied_at, ?) WHERE id = ?`)
        .bind(status, new Date().toISOString(), appliedAt, Number(args.id)).run();
      return r.meta.changes ? { ok: true, status } : { error: "no application with that id" };
    },
  },
};
