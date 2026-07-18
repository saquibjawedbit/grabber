// Grabber edge worker: conversational agent, Telegram webhook (taps -> labels),
// deadline nags, dashboard API.

import { embedMemory, rememberExchange, runAgent, TOOLS, validateArgs } from "./agent.js";
import { backfill, extract, forgetMemory, reconcile, saveMemory, unpackVec } from "./memory.js";
import { DEFAULT_PERSONA, getPersona, resetPersona, setPersona } from "./persona.js";
import { adaptPlan, announceOpenQuestions, answerPlanQuestion, answerPlanQuestions, checkAwards, createGoal, debrief, getSettings, getSystemState, issueDaily, listAwards, listGoals, listMetrics, listMilestones, listPlanQuestions, listQuests, maybeAdaptOnDone, replanGoal, resolveQuest, runSystem, setAutonomyMode, updateGoal } from "./system.js";
import { classifyInbox, googleConnected, ingestNotification, pollCalendar, remindEvents } from "./senses.js";
import { processBankNotifications } from "./life.js";
import { generatePerception, getPerception } from "./perception.js";

const TG = (env, method) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

async function tg(env, method, body) {
  const r = await fetch(TG(env, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- Bot commands: the tracker you can talk to ----------

const HELP = `I'm your System — a strict mentor with one motive: get you to your goals. I don't wait around.

• <b>Declare a goal</b> — tell me what you're trying to become, the target, the deadline. Everything I do runs off your goals.
• <b>Daily quests</b> — every morning I issue quests toward your goals. Tap ✅/⏳/❌. Every night is a reckoning: unfinished = failed, and failure costs XP and your streak.
• <b>I get things done for you</b> — paste a job/role and I'll draft the whole application. Ask me to dig ("what does Zepto ask in SDE interviews? go deep") and I put a research agent on a real machine for ~10 min.
• <b>Remember you</b> — tell me anything; I recall what's relevant when it matters.
• <b>Reminders</b> — "remind me Friday 6pm to follow up with Ankit".
• Send any text/markdown file, a voice note, a video, or a screenshot — I read it and use it.

Commands:
/goals — your goals and progress
/quests — today's quests
/rank — your level, XP and streak
/research — recent deep dives
/memories — what I know about you
/help — this message`;

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function cmdGoals(env) {
  const { goals } = await listGoals(env, { status: "active" });
  if (!goals.length) {
    return "⚔️ <b>No goals yet.</b>\n\nA hunter without a goal is prey. Tell me what you're trying to become — the role, the number, the deadline — and I'll drive you at it.";
  }
  const lines = goals.map(g => {
    const days = g.deadline ? Math.ceil((new Date(g.deadline) - Date.now()) / 86400000) : null;
    const when = days == null ? "" : days < 0 ? " · ⚠️ deadline passed" : days === 0 ? " · 🔥 due today" : ` · ${days}d left`;
    const prog = `${g.quests_done} done${g.quests_failed ? ` · ${g.quests_failed} failed` : ""}`;
    return `• <b>${esc(g.title)}</b>${g.target ? ` — ${esc(g.target)}` : ""}${when}\n  <i>${prog}</i> <code>#${g.id}</code>`;
  });
  return `⚔️ <b>Your goals (${goals.length})</b>\n\n${lines.join("\n")}\n\nSay "achieved #id" or "drop #id", or name a new one.`;
}

async function cmdQuests(env) {
  const { quests } = await listQuests(env, { status: "today" });
  if (!quests.length) return "No quests issued today yet. They land each morning — or say \"issue my quests\".";
  const icon = { done: "✅", failed: "❌", doing: "⏳", issued: "▫️", skipped: "⤴️" };
  const lines = quests.map(q =>
    `${icon[q.status] || "▫️"} <b>${esc(q.text)}</b> <i>(+${q.xp} XP)</i> <code>#${q.id}</code>`);
  const done = quests.filter(q => q.status === "done").length;
  return `⚔️ <b>Today's quests — ${done}/${quests.length} cleared</b>\n\n${lines.join("\n")}`;
}

async function cmdRank(env) {
  const s = await getSystemState(env);
  const bar = "▰".repeat(Math.round((s.xp_into_level / Math.max(1, s.xp_into_level + s.xp_to_next)) * 10))
    .padEnd(10, "▱");
  return `🗿 <b>Level ${s.level}</b>\n${bar}  ${s.xp} XP (${s.xp_to_next} to next)\n\n` +
    `🔥 Streak: <b>${s.streak}</b> day${s.streak === 1 ? "" : "s"} (best ${s.streak_best})`;
}

async function cmdMemories(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, category, fact FROM memories ORDER BY category, id DESC LIMIT 60").all();
  const docs = await env.DB.prepare(
    "SELECT key FROM profile WHERE key != 'conversation_summary' ORDER BY key LIMIT 20").all();
  if (!results.length && !docs.results.length) {
    return "Nothing saved yet. Tell me things worth remembering — preferences, skills, constraints — or send me a file.";
  }
  const memLines = results.map(m => `• <i>#${m.id} ${esc(m.category)}</i> — ${esc(m.fact)}`).join("\n");
  const docLine = docs.results.length
    ? `\n\n📄 <b>Profile documents:</b> ${docs.results.map(d => esc(d.key)).join(", ")}` : "";
  return `🧠 <b>What I know about you</b>\n\n${memLines || "(no memories yet)"}${docLine}\n\nSay "forget #id" to remove one.`;
}

async function cmdResearch(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, question, status, created_at, finished_at FROM research ORDER BY id DESC LIMIT 8").all();
  if (!results.length) {
    return "🔍 No deep dives yet.\n\nAsk me something that deserves real digging — <i>\"what does Zepto ask in SDE interviews? go deep\"</i> — and I'll put an agent on it for ten minutes.";
  }
  const icon = { done: "✅", running: "◐", queued: "◌", failed: "⚠️" };
  const lines = results.map(r =>
    `${icon[r.status] || "·"} <b>${esc(r.question.slice(0, 70))}</b>\n  <i>${esc(r.status)}</i> <code>#${r.id}</code>`);
  return `🔍 <b>Research</b>\n\n${lines.join("\n")}\n\nSay "show me research #id" for the full report.`;
}

function isOwner(chatId, env) {
  return String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

async function handleCommand(text, chatId, env) {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  let reply;
  if (cmd === "/start") reply = `Your chat_id is <code>${chatId}</code> — set it as TELEGRAM_CHAT_ID.\n\n${esc(HELP)}`;
  else if (!isOwner(chatId, env)) reply = "I'm a personal agent working for one person, and it isn't you. 🙂";
  else if (cmd === "/help") reply = esc(HELP);
  else if (cmd === "/goals") reply = await cmdGoals(env);
  else if (cmd === "/quests") reply = await cmdQuests(env);
  else if (cmd === "/rank") reply = await cmdRank(env);
  else if (cmd === "/memories") reply = await cmdMemories(env);
  else if (cmd === "/research") reply = await cmdResearch(env);
  else reply = `Unknown command.\n\n${esc(HELP)}`;
  await tg(env, "sendMessage", {
    chat_id: chatId, text: reply, parse_mode: "HTML", disable_web_page_preview: true,
  });
}

// ---------- Voice: talking is faster than typing ----------

const MAX_VOICE_BYTES = 20_000_000;
const MAX_IMAGE_BYTES = 10_000_000;

async function download(env, fileId, maxBytes, what) {
  const fi = await tg(env, "getFile", { file_id: fileId });
  const path = fi.result?.file_path;
  if (!path) throw new Error(`Telegram wouldn't hand over the ${what}`);
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!r.ok) throw new Error(`${what} download failed (${r.status})`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error(`that ${what} is too big for me`);
  return new Uint8Array(buf);
}

async function transcribe(env, fileId) {
  const bytes = await download(env, fileId, MAX_VOICE_BYTES, "audio");
  const res = await env.AI.run("@cf/openai/whisper", { audio: [...bytes] });
  return (res?.text || "").trim();
}

function toDataUri(bytes, mime) {
  // btoa needs a binary string, and spreading a whole image into fromCharCode
  // blows the stack — walk it in chunks.
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${mime || "image/jpeg"};base64,${btoa(s)}`;
}

// Images: read them rather than ignore them — a JD screenshot or a whiteboard photo
// is a question, and the owner shouldn't have to retype it.
// Model choice is constrained: llava's OCR can't read a screenshot, and
// llama-3.2-vision is gated behind a per-account licence prompt. Mistral reads
// text out of images accurately with no gate.
async function describeImage(env, fileId, caption, mime) {
  const bytes = await download(env, fileId, MAX_IMAGE_BYTES, "image");
  const res = await env.AI.run("@cf/mistralai/mistral-small-3.1-24b-instruct", {
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: caption
            ? `Transcribe every word of text in this image verbatim, then describe what it shows. The person sent it saying: "${caption}"`
            : "Transcribe every word of text in this image verbatim, then describe what it shows. It may be a screenshot of a job post, a message, or a document.",
        },
        { type: "image_url", image_url: { url: toDataUri(bytes, mime) } },
      ],
    }],
    max_tokens: 1024,
  });
  return (res?.response ?? res?.choices?.[0]?.message?.content ?? "").trim();
}

async function handleVoice(env, chatId, fileId, placeholderId, quoted = "") {
  let heard;
  try {
    heard = await transcribe(env, fileId);
  } catch (e) {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: placeholderId,
      text: `🎧 I couldn't make that out — ${String(e.message || e).slice(0, 120)}`,
    });
    return;
  }
  if (!heard) {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: placeholderId,
      text: "🎧 That came through silent — try again?",
    });
    return;
  }
  // Show what was heard before answering: a wrong transcript should be obvious,
  // not something the owner has to reverse-engineer from a strange reply.
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: placeholderId,
    text: `🎧 <i>“${esc(heard)}”</i>\n\n🤔 …`, parse_mode: "HTML",
  });
  await converse(env, chatId, quoted + heard, placeholderId, `🎧 <i>“${esc(heard)}”</i>\n\n`);
}

async function handlePhoto(env, chatId, fileId, caption, placeholderId, mime) {
  let seen;
  try {
    seen = await describeImage(env, fileId, caption, mime);
  } catch (e) {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: placeholderId,
      text: `🖼 I couldn't open that image — ${String(e.message || e).slice(0, 120)}`,
    });
    return;
  }
  if (!seen) {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: placeholderId,
      text: "🖼 I couldn't make out anything in that one — send it larger, or tell me what to look at?",
    });
    return;
  }
  await tg(env, "editMessageText", {
    chat_id: chatId, message_id: placeholderId, text: "🖼 🤔 …",
  });
  // The caption is the actual instruction; what the image says is context for it.
  const ask = caption
    ? `${caption}\n\n[The image I sent contains: ${seen}]`
    : `I sent you this image. Here is what it contains:\n\n${seen}\n\nRespond to it as if I had sent you its contents directly.`;
  await converse(env, chatId, ask, placeholderId, "🖼 ");
}

// ---------- Conversational agent ----------

// The agent writes Markdown, but messages go out with parse_mode=HTML — sent
// verbatim, Telegram shows the asterisks literally. Convert the subset the
// model actually produces. A reply already carrying Telegram HTML tags passes
// through untouched.
const TG_HTML = /<\/?(b|strong|i|em|u|s|del|code|pre|blockquote|tg-spoiler)>|<a href=/i;
function mdToHtml(md) {
  const src = String(md ?? "");
  if (TG_HTML.test(src)) return src;
  // Code first: nothing inside it may be styled, and its content needs escaping.
  const keep = [];
  const stash = html => `\u0000${keep.push(html) - 1}\u0000`;
  let s = src.replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => stash(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`));
  s = esc(s)
    .replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${c}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])/g, "$1<i>$2</i>")
    .replace(/(^|\s)_(\S(?:[^_\n]*\S)?)_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/^#{1,6} +(.+)$/gm, "<b>$1</b>")
    .replace(/^[-*] +/gm, "• ");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}

async function converse(env, chatId, text, placeholderId, prefix = "") {
  let reply;
  try {
    reply = await runAgent(env, text);
  } catch (e) {
    reply = `⚠️ I hit an error: ${String(e).slice(0, 200)}`;
  }
  const body = {
    chat_id: chatId, text: prefix + mdToHtml(reply), parse_mode: "HTML", disable_web_page_preview: true,
  };
  let r = placeholderId
    ? await tg(env, "editMessageText", { ...body, message_id: placeholderId })
    : await tg(env, "sendMessage", body);
  if (!r.ok) {
    // Usually the model emitted HTML-unsafe text — resend plain, and strip the
    // prefix's own markup so the owner never sees raw <i> tags.
    delete body.parse_mode;
    body.text = prefix.replace(/<[^>]+>/g, "") + reply;
    r = placeholderId
      ? await tg(env, "editMessageText", { ...body, message_id: placeholderId })
      : await tg(env, "sendMessage", body);
  }
  if (r.ok && !reply.startsWith("⚠️")) await rememberExchange(env, text, reply);
}

// ---------- File uploads: "knows everything about me" — any text file becomes profile corpus ----------

const TEXT_EXT = /\.(md|txt|markdown|yaml|yml|json|csv|tex|rst)$/i;

async function ingestDocument(env, chatId, doc) {
  const name = doc.file_name || "untitled.txt";
  let reply;
  if ((doc.file_size || 0) > 300_000) {
    reply = "That file is over 300KB — send a trimmed text version and I'll keep it.";
  } else if (!TEXT_EXT.test(name) && !(doc.mime_type || "").startsWith("text/")) {
    reply = `I can only read text for now (.md, .txt, .yaml, .json…). For a PDF resume, export or paste it as text/markdown and send that.`;
  } else {
    const fi = await tg(env, "getFile", { file_id: doc.file_id });
    const path = fi.result?.file_path;
    if (!path) {
      reply = "Telegram wouldn't hand me that file — try sending it again.";
    } else {
      const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
      const content = (await r.text()).slice(0, 200_000);
      const base = name.toLowerCase().replace(/\.[^.]+$/, "");
      // resume.md / bio.md land on the canonical keys the ranker + agent already read.
      const key = ["resume", "bio", "skills"].includes(base)
        ? base : `doc:${base.replace(/[^a-z0-9._-]+/g, "-")}`;
      await env.DB.prepare(`
        INSERT INTO profile (key, content, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`)
        .bind(key, content, new Date().toISOString()).run();
      reply = `📄 Saved as <b>${esc(key)}</b> (${content.length} chars). I'll use it in everything — rankings, drafts, and our chats.`;
    }
  }
  await tg(env, "sendMessage", { chat_id: chatId, text: reply, parse_mode: "HTML" });
}

// ---------- Telegram webhook: every tap is a label (point 4) ----------

// Telegram's swipe-to-reply carries the quoted message in reply_to_message; it used to
// be silently dropped, so "done" replied onto a quest meant nothing to the agent. Worse,
// quest/reckoning/briefing messages are sent by the cron path and never enter
// chat_history — a reply to one of those arrived with ZERO context. Quests are matched
// exactly via the tg_message_id stored at issue time; anything else is quoted verbatim.
async function replyContext(env, msg) {
  const r = msg?.reply_to_message;
  if (!r) return "";
  try {
    const q = await env.DB.prepare(
      "SELECT id, text, status FROM quests WHERE tg_message_id = ?").bind(r.message_id).first();
    if (q) return `[replying to quest #${q.id} — "${q.text}" (status: ${q.status})] `;
  } catch { /* fall through to the plain quote */ }
  const quoted = (r.text || r.caption || "").slice(0, 300);
  if (!quoted) return "";
  return `[replying to ${r.from?.is_bot ? "your earlier message" : "their own earlier message"}: "${quoted}"] `;
}

async function handleTelegram(request, env, ctx) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();

  const msg = update.message;
  if (msg?.text?.startsWith("/")) {
    await handleCommand(msg.text, msg.chat.id, env);
    return new Response("ok");
  }
  // Photos arrive as an array of sizes, smallest first — the last one is the original.
  // An image sent as a file (uncompressed) is a photo too, not profile corpus.
  const photo = msg?.photo?.[msg.photo.length - 1]
    || (msg?.document?.mime_type?.startsWith("image/") ? msg.document : null);
  if (photo) {
    if (!isOwner(msg.chat.id, env)) return new Response("ok");
    const sent = await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "🖼 looking…" });
    ctx.waitUntil(handlePhoto(env, msg.chat.id, photo.file_id, msg.caption,
      sent.result?.message_id, photo.mime_type));
    return new Response("ok");
  }
  if (msg?.document) {
    if (!isOwner(msg.chat.id, env)) return new Response("ok");
    await ingestDocument(env, msg.chat.id, msg.document);
    return new Response("ok");
  }
  // Video rides the same path: Whisper reads the audio track out of the container.
  const audio = msg?.voice || msg?.audio || msg?.video_note || msg?.video;
  if (audio) {
    if (!isOwner(msg.chat.id, env)) return new Response("ok");
    const sent = await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "🎧 listening…" });
    const quoted = await replyContext(env, msg);
    ctx.waitUntil(handleVoice(env, msg.chat.id, audio.file_id, sent.result?.message_id, quoted));
    return new Response("ok");
  }
  if (msg?.text) {
    if (!isOwner(msg.chat.id, env)) {
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id, text: "I'm a personal agent working for one person, and it isn't you. 🙂",
      });
      return new Response("ok");
    }
    // Ack Telegram fast; think in the background, then edit the placeholder.
    const sent = await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "🤔 …" });
    const quoted = await replyContext(env, msg);
    ctx.waitUntil(converse(env, msg.chat.id, quoted + msg.text, sent.result?.message_id));
    return new Response("ok");
  }
  if (msg && isOwner(msg.chat.id, env)) {
    // Stickers, locations, contacts, polls. Say so — silence reads as a dead bot.
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "I can read text, voice, video, images and text files — that one I can't. Describe it to me?",
    });
    return new Response("ok");
  }

  const cb = update.callback_query;
  if (!cb) return new Response("ok");

  const [tag, id, action] = (cb.data || "").split(":");
  if (tag === "r" && id) {
    await env.DB.prepare("UPDATE reminders SET done = 1 WHERE id = ?").bind(Number(id)).run();
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Done ✅" });
    return new Response("ok");
  }
  // Quest resolution: every tap is a label. done/failed move XP; doing keeps it open.
  if (tag === "q" && id && action) {
    const r = await resolveQuest(env, id, action);
    let toast = r.error ? r.error : `Quest ${action}`;
    if (!r.error) {
      if (r.already) toast = `Already ${r.already} — that stands.`;   // no-op: don't fake an XP gain
      else if (action === "done") toast = `✅ ${r.overturned ? "Overturned. " : ""}+${r.xp_delta} XP · Level ${r.level}${r.leveled_up ? " — LEVEL UP" : ""}`;
      else if (action === "failed") toast = `❌ ${r.xp_delta} XP. Do better tomorrow.`;
      else if (action === "doing") toast = "In progress. The reckoning is tonight.";
    }
    // 'doing' keeps the buttons live; a terminal action clears them.
    if (action !== "doing") {
      await tg(env, "editMessageReplyMarkup", {
        chat_id: cb.message.chat.id, message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: toast });
    // A ✅ re-evaluates the goal's plan against what just happened — in the background,
    // so the button toast never waits on an LLM call (cooldown-gated inside) — and runs
    // the award check so a crossed threshold (quest totals, rank) lands immediately.
    if (r.status === "done") {
      ctx.waitUntil(checkAwards(env, tg));
      if (r.goal_id) ctx.waitUntil(maybeAdaptOnDone(env, r.goal_id, tg));
    }
    return new Response("ok");
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  return new Response("ok");
}

// ---------- Senses on the cron: mail (via IMAP job) + calendar (OAuth, optional) ----------

async function sensesProfile(env) {
  const parts = [];
  for (const key of ["bio", "skills"]) {
    const row = await env.DB.prepare("SELECT content FROM profile WHERE key = ?").bind(key).first();
    if (row) parts.push(row.content.slice(0, 1200));
  }
  const { results: mems } = await env.DB.prepare("SELECT fact FROM memories ORDER BY id LIMIT 30").all();
  return [...parts, ...mems.map(m => `- ${m.fact}`)].join("\n") || "(nothing known yet)";
}

async function runSenses(env) {
  const out = {};
  // Mail: the IMAP job (Actions) writes to D1; here we classify the backlog and
  // surface only what's worth interrupting for. No OAuth needed.
  try {
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM emails WHERE surfaced = 0").first();
    if (pending.n) {
      out.mail = await classifyInbox(env, tg, await sensesProfile(env));
    }
  } catch (e) {
    out.mail_error = String(e).slice(0, 150);
  }
  // Calendar still rides on OAuth — off unless connected, which it isn't by default.
  if (googleConnected(env)) {
    try {
      out.calendar = await pollCalendar(env);
      out.reminded = await remindEvents(env, tg);
    } catch (e) {
      out.calendar_error = String(e).slice(0, 150);
    }
  }
  return out;
}

// ---------- Reminders: general-agent capability, fired by the hourly cron ----------

async function runReminders(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, text FROM reminders
    WHERE done = 0 AND notified = 0 AND datetime(due_at) <= datetime('now')
    ORDER BY due_at LIMIT 20`).all();
  for (const r of results) {
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `⏰ Reminder: ${r.text}`,
      reply_markup: { inline_keyboard: [[{ text: "✅ Done", callback_data: `r:${r.id}:done` }]] },
    });
    await env.DB.prepare("UPDATE reminders SET notified = 1 WHERE id = ?").bind(r.id).run();
  }
}

// ---------- Dashboard API ----------

async function handleApi(url, env, request) {
  if (url.searchParams.get("t") !== env.DASH_TOKEN) {
    return Response.json({ error: "bad token" }, { status: 403 });
  }
  if (url.pathname === "/api/alerts") {
    const { results } = await env.DB.prepare(`
      SELECT a.id, a.category, a.fit, a.p_convert, a.reasons, a.angle, a.sent_at,
             p.title, p.url, p.org, p.deadline, p.source,
             d.content_md AS draft,
             (SELECT group_concat(o.action) FROM outcomes o WHERE o.alert_id = a.id) AS outcomes
      FROM alerts a
      JOIN postings p ON p.id = a.posting_id
      LEFT JOIN drafts d ON d.alert_id = a.id
      WHERE a.sent_at IS NOT NULL
      ORDER BY a.sent_at DESC LIMIT 100`).all();
    return Response.json(results);
  }
  if (url.pathname === "/api/brain") {
    // Everything the dashboard shows: memory, reminders, profile, corpus shape.
    const [mem, rem, docs, summary, bySource, totals, recent] = await Promise.all([
      env.DB.prepare(`SELECT id, category, fact, created_at, updated_at, source, context
                      FROM memories ORDER BY id DESC LIMIT 200`).all(),
      env.DB.prepare("SELECT id, text, due_at, notified FROM reminders WHERE done = 0 ORDER BY due_at LIMIT 50").all(),
      env.DB.prepare("SELECT key, length(content) AS chars, updated_at FROM profile WHERE key != 'conversation_summary' ORDER BY key").all(),
      env.DB.prepare("SELECT content, updated_at FROM profile WHERE key = 'conversation_summary'").first(),
      env.DB.prepare("SELECT source, COUNT(*) AS n FROM postings GROUP BY source ORDER BY n DESC").all(),
      env.DB.prepare(`
        SELECT
          (SELECT COUNT(*) FROM postings) AS corpus,
          (SELECT COUNT(*) FROM memories) AS memories,
          (SELECT COUNT(*) FROM watchers WHERE active = 1) AS watchers,
          (SELECT COUNT(*) FROM research WHERE status = 'done') AS research,
          (SELECT COUNT(*) FROM reminders WHERE done = 0) AS reminders,
          (SELECT COUNT(*) FROM notifications) +
            (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM emails) AS sensed,
          (SELECT COUNT(*) FROM applications) AS packs,
          (SELECT COUNT(*) FROM applications WHERE status NOT IN ('ready','dropped')) AS sent,
          (SELECT COUNT(*) FROM alerts WHERE sent_at IS NOT NULL) AS alerted,
          (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'applied') AS applied,
          (SELECT COUNT(DISTINCT alert_id) FROM outcomes WHERE action = 'won') AS won,
          (SELECT COUNT(*) FROM chat_history) AS chat_rows`).first(),
      env.DB.prepare(`
        SELECT title, source, url, deadline, ingested_at FROM postings
        ORDER BY ingested_at DESC LIMIT 12`).all(),
    ]);
    // The conversation itself: the dashboard showed what was distilled from it but
    // never the thing being distilled, so a quiet memory layer looked like an empty one.
    const chat = await env.DB.prepare(
      "SELECT id, role, content, at FROM chat_history ORDER BY id DESC LIMIT 60").all();
    const persona = await getPersona(env);
    // Measured rarity (point 3) and the learned pieces are the most interesting
    // things this system holds — they belong on screen, not only in the ranker.
    const [rarity, calib, people, txs, health, merchants, briefing] = await Promise.all([
      env.DB.prepare(`SELECT term, df, ROUND(idf, 2) AS idf FROM idf
                      WHERE term NOT LIKE 'phrase:%' AND df >= 2
                      ORDER BY idf DESC LIMIT 24`).all(),
      env.DB.prepare("SELECT * FROM calibration ORDER BY n_applied DESC").all(),
      env.DB.prepare(`SELECT p.name, p.relation, p.how_met, p.status, p.next_step, p.notes,
                             p.last_contact, p.created_at,
                             CAST(julianday('now') - julianday(COALESCE(p.last_contact, p.created_at)) AS INTEGER) AS days_quiet,
                             (SELECT COUNT(*) FROM interactions i WHERE i.person_id = p.id) AS touches
                      FROM people p ORDER BY days_quiet ASC LIMIT 40`).all(),
      env.DB.prepare(`SELECT amount, direction, counterparty, category, at, source
                      FROM transactions ORDER BY at DESC LIMIT 25`).all(),
      env.DB.prepare(`SELECT metric, value, unit, at FROM health
                      WHERE datetime(at) >= datetime('now', '-180 days') ORDER BY at`).all(),
      env.DB.prepare("SELECT pattern, category FROM merchant_category ORDER BY category, pattern").all(),
      env.DB.prepare("SELECT value, updated_at FROM state WHERE key = 'briefing_text'").first(),
    ]);
    const perception = await getPerception(env);
    const applications = (await env.DB.prepare(
      `SELECT id, title, company, url, fit, status, created_at, applied_at, cover_note, package_md
       FROM applications ORDER BY id DESC LIMIT 40`).all()).results;
    const [accounts, holdings, spend, weight, cold, txCount] = await Promise.all([
      env.DB.prepare("SELECT name, kind, balance FROM accounts ORDER BY balance DESC").all(),
      env.DB.prepare("SELECT name, kind, category, value FROM holdings ORDER BY value DESC").all(),
      env.DB.prepare(`SELECT category, ROUND(SUM(amount)) AS total FROM transactions
                      WHERE direction = 'debit' AND datetime(at) >= datetime('now', '-30 days')
                      GROUP BY category ORDER BY total DESC`).all(),
      env.DB.prepare(`SELECT value, at FROM health WHERE metric = 'weight' AND value IS NOT NULL
                      AND datetime(at) >= datetime('now', '-120 days') ORDER BY at`).all(),
      env.DB.prepare(`SELECT name, relation, next_step, last_contact,
                             CAST(julianday('now') - julianday(COALESCE(last_contact, created_at)) AS INTEGER) AS days_quiet
                      FROM people WHERE status != 'closed'
                        AND julianday('now') - julianday(COALESCE(last_contact, created_at)) >= 10
                      ORDER BY days_quiet DESC LIMIT 8`).all(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first(),
    ]);
    const [notifications, events, mails, allow] = await Promise.all([
      env.DB.prepare(`SELECT app, title, body, kind, amount, direction, counterparty, received_at
                      FROM notifications ORDER BY id DESC LIMIT 20`).all(),
      env.DB.prepare(`SELECT title, starts_at, location FROM events
                      WHERE datetime(starts_at) >= datetime('now') ORDER BY starts_at LIMIT 10`).all(),
      env.DB.prepare(`SELECT sender, subject, kind, received_at FROM emails
                      ORDER BY received_at DESC LIMIT 10`).all(),
      env.DB.prepare("SELECT pattern, kind FROM notify_allow ORDER BY kind, pattern").all(),
    ]);
    const [watchers, research] = await Promise.all([
      env.DB.prepare("SELECT id, kind, target, note, last_checked, last_error, hits, active FROM watchers ORDER BY id").all(),
      env.DB.prepare(`SELECT id, question, depth, status, sources, steps, created_at, finished_at,
                             error, substr(report_md, 1, 4000) AS report_md
                      FROM research ORDER BY id DESC LIMIT 20`).all(),
    ]);
    return Response.json({
      memories: mem.results,
      persona: { ...persona, default_voice: DEFAULT_PERSONA.voice, default_name: DEFAULT_PERSONA.name },
      chat: chat.results.reverse(),   // oldest-first: the panel reads like a conversation
      reminders: rem.results,
      documents: docs.results,
      summary: summary ? { text: summary.content, updated_at: summary.updated_at } : null,
      by_source: bySource.results,
      totals,
      recent: recent.results,
      watchers: watchers.results,
      research: research.results.map(r => ({ ...r, sources: r.sources ? JSON.parse(r.sources) : [] })),
      life: {
        accounts: accounts.results,
        holdings: holdings.results,
        spend_30d: spend.results,
        weight: weight.results,
        cold_threads: cold.results,
        tx_count: txCount.n,
        transactions: txs.results,
        people: people.results,
        health: health.results,
      },
      rarity: rarity.results,
      calibration: calib.results,
      applications,
      merchants: merchants.results,
      briefing: briefing ? { text: briefing.value, at: briefing.updated_at } : null,
      perception,
      senses: {
        google_connected: googleConnected(env),
        notify_wired: Boolean(env.NOTIFY_SECRET),
        notifications: notifications.results,
        events: events.results,
        emails: mails.results,
        allowlist: allow.results,
      },
    });
  }
  if (url.pathname === "/api/embed-backfill") {
    // One-shot: give memories saved before v3 their vectors.
    const { results } = await env.DB.prepare(
      "SELECT id, fact FROM memories WHERE embedding IS NULL LIMIT 50").all();
    let ok = 0;
    for (const m of results) if (await embedMemory(env, m.id, m.fact)) ok++;
    return Response.json({ pending: results.length, embedded: ok });
  }
  if (url.pathname === "/api/vector-backfill") {
    // One-shot: push every D1-held vector into Vectorize. D1 is the source of truth,
    // so this is also the rebuild path if the index is ever wiped or recreated.
    // Upserts are idempotent — safe to re-run.
    if (!env.VECTORIZE) {
      return Response.json({ error: "no VECTORIZE binding — create the index (see wrangler.toml) and redeploy" }, { status: 400 });
    }
    const { results } = await env.DB.prepare(
      "SELECT id, category, embedding FROM memories WHERE embedding IS NOT NULL").all();
    let pushed = 0, failed = 0;
    for (let i = 0; i < results.length; i += 100) {
      const batch = results.slice(i, i + 100).map(r => ({
        id: String(r.id),
        values: Array.from(unpackVec(r.embedding)),
        metadata: { category: r.category || "fact" },
      }));
      try {
        await env.VECTORIZE.upsert(batch);
        pushed += batch.length;
      } catch (e) {
        failed += batch.length;
        console.log("vector-backfill batch failed:", String(e).slice(0, 150));
      }
    }
    return Response.json({ vectors: results.length, pushed, failed });
  }
  if (url.pathname === "/api/memory-backfill") {
    // Sweep chat_history that predates the post-reply extractor. Additive and
    // near-duplicate-checked, so re-running is safe, but it is not a no-op: the
    // model may word a fact differently enough to clear the threshold. Follow it
    // with /api/memory-reconcile.
    const limit = Math.min(Number(url.searchParams.get("limit") || 40), 100);
    const dry = url.searchParams.get("dry") === "1";
    return Response.json(await backfill(env, { limit, dry }));
  }
  // ---------- Teaching it from the dashboard ----------
  // Telegram was the only way in, which meant anything you wanted it to know had
  // to be typed at a phone. These are the same memory layer, reached from the desk.

  if (url.pathname === "/api/teach" && request.method === "POST") {
    // Paste anything — notes, a bio, a JD, a brain-dump. The extractor mines the
    // durable facts out of it, exactly as it does for a Telegram exchange.
    const { text = "", dry = false } = await request.json().catch(() => ({}));
    if (!String(text).trim()) return Response.json({ error: "nothing to read" }, { status: 400 });
    const r = await extract(env, String(text).slice(0, 4000),
      "(the owner pasted this into the dashboard for you to remember)",
      { dry, allowForget: false, source: "dashboard" });
    return Response.json(r);
  }

  if (url.pathname === "/api/persona" && request.method === "POST") {
    // Who it is when it speaks. Applies to chat, briefings, weekly, overnight and
    // perception alike — one voice, not five.
    const body = await request.json().catch(() => ({}));
    if (body.reset) return Response.json(await resetPersona(env));
    return Response.json({ ...await setPersona(env, body), custom: true });
  }

  if (url.pathname === "/api/memory" && request.method === "POST") {
    const { fact = "", category = "fact" } = await request.json().catch(() => ({}));
    if (!String(fact).trim()) return Response.json({ error: "empty fact" }, { status: 400 });
    const r = await saveMemory(env, String(fact).slice(0, 500), category, { source: "dashboard" });
    return Response.json(r, { status: r.status === "empty" ? 400 : 200 });
  }

  if (url.pathname === "/api/memory" && request.method === "DELETE") {
    const id = Number(url.searchParams.get("id"));
    if (!id) return Response.json({ error: "need an id" }, { status: 400 });
    return Response.json({ ok: await forgetMemory(env, id) });
  }

  if (url.pathname === "/api/profile" && request.method === "POST") {
    // The corpus the ranker and the agent both read. Previously only reachable by
    // sending a file to the bot; now editable in place.
    const { key = "", content = "" } = await request.json().catch(() => ({}));
    const clean = String(key).trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
    if (!clean || clean === "conversation_summary") {
      return Response.json({ error: "pick a name (resume, bio, skills, or notes:anything)" }, { status: 400 });
    }
    if (!String(content).trim()) {
      await env.DB.prepare("DELETE FROM profile WHERE key = ?").bind(clean).run();
      return Response.json({ ok: true, deleted: clean });
    }
    await env.DB.prepare(`
      INSERT INTO profile (key, content, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`)
      .bind(clean, String(content).slice(0, 200_000), new Date().toISOString()).run();
    return Response.json({ ok: true, key: clean, chars: String(content).length });
  }

  if (url.pathname === "/api/profile-read") {
    const key = url.searchParams.get("key") || "";
    const row = await env.DB.prepare("SELECT key, content FROM profile WHERE key = ?").bind(key).first();
    return row ? Response.json(row) : Response.json({ error: "no such document" }, { status: 404 });
  }

  if (url.pathname === "/api/memory-reconcile") {
    // Audit memories against each other for contradictions and duplicates.
    // ?dry=1 first — this one deletes.
    return Response.json(await reconcile(env, { dry: url.searchParams.get("dry") === "1" }));
  }
  if (url.pathname === "/api/mail-status") {
    // What the IMAP job has delivered to D1, and what's waiting to be classified.
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM emails").first();
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM emails WHERE surfaced = 0").first();
    const { results } = await env.DB.prepare(
      "SELECT sender, subject, kind, received_at FROM emails ORDER BY received_at DESC LIMIT 10").all();
    return Response.json({ total: total.n, awaiting_classification: pending.n, latest: results });
  }
  if (url.pathname === "/api/perception") {
    // ?refresh=1 regenerates (one LLM call); otherwise return the cached read.
    if (url.searchParams.get("refresh") === "1") {
      return Response.json(await generatePerception(env));
    }
    return Response.json(await getPerception(env) || { empty: true });
  }
  if (url.pathname === "/api/tool") {
    // Debug: run one agent tool directly. /api/tool?t=TOKEN&name=web_search&args={"query":"..."}
    const tool = TOOLS[url.searchParams.get("name")];
    if (!tool) return Response.json({ error: "unknown tool" }, { status: 404 });
    let args = {};
    try { args = JSON.parse(url.searchParams.get("args") || "{}"); } catch { /* empty */ }
    // Same boundary check the agent loop applies, so manual testing exercises it too.
    const bad = tool.args ? validateArgs(tool.args, args) : null;
    if (bad) return Response.json({ error: `invalid args: ${bad}` });
    try {
      return Response.json(await tool.run(env, args));
    } catch (e) {
      return Response.json({ error: String(e) });
    }
  }
  if (url.pathname === "/api/cron") {
    // Manual trigger for testing — same work as the hourly cron.
    // ?system=1 issues/debriefs now; add &force=1 to bypass the hour + once-a-day gates.
    // &issue=1 / &debrief=1 force just one half.
    const q = k => url.searchParams.get(k) === "1";
    await runReminders(env);
    const money = await processBankNotifications(env);
    const senses = q("senses") ? await runSenses(env) : "skipped";
    let system = "skipped";
    if (q("issue")) system = { issue: await issueDaily(env, tg, { force: true }) };
    else if (q("debrief")) system = { debrief: await debrief(env, tg, { force: true }) };
    else if (q("awards")) system = { awards: await checkAwards(env, tg) };
    else if (q("system")) system = await runSystem(env, tg, { force: q("force"), spawn: (en, args) => TOOLS.spawn_research.run(en, args) });
    return Response.json({ ok: true, money, senses, system });
  }
  if (url.pathname === "/api/rank") {
    return Response.json({ ...await getSystemState(env), ...await listGoals(env, { status: "active" }) });
  }
  if (url.pathname === "/api/goal" && request.method === "POST") {
    // Set a goal from the dashboard (same createGoal the agent's set_goal tool uses),
    // change its status, or re-map its roadmap. {title,…} creates; {id,status} updates;
    // {id,replan:true} maps a fresh route.
    const body = await request.json().catch(() => ({}));
    if (body.id && body.replan) {
      const r = await replanGoal(env, body.id);
      if (r.questions_asked) await announceOpenQuestions(env, tg);
      return Response.json(r);
    }
    if (body.id && body.adapt) {
      const r = await adaptPlan(env, body.id);
      if (r.questions_asked) await announceOpenQuestions(env, tg);
      return Response.json(r);
    }
    if (body.id) {
      const status = ["active", "achieved", "dropped"].includes(body.status) ? body.status : null;
      if (!status) return Response.json({ error: "status must be active|achieved|dropped" }, { status: 400 });
      return Response.json(await updateGoal(env, body.id, { status }));
    }
    const r = await createGoal(env, body);
    // The initial plan may have asked questions — ping them out right away.
    if (r.ok) { try { await announceOpenQuestions(env, tg); } catch { /* never blocks creation */ } }
    return Response.json(r, { status: r.error ? 400 : 200 });
  }
  if (url.pathname === "/api/settings" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.autonomy_mode) return Response.json(await setAutonomyMode(env, body.autonomy_mode));
    return Response.json({ error: "nothing to set" }, { status: 400 });
  }
  if (url.pathname === "/api/plan-question" && request.method === "POST") {
    // Answer (or dismiss) planner questions from the dashboard. {answers:[{id,answer}]}
    // batches: every answer recorded first, then ONE re-plan per goal. A single {id,answer}
    // re-plans only when it closes the goal's last open question (same auto rule as chat).
    const body = await request.json().catch(() => ({}));
    if (body.id && body.dismiss) {
      await env.DB.prepare("UPDATE plan_questions SET status = 'dismissed' WHERE id = ?").bind(Number(body.id)).run();
      return Response.json({ ok: true, dismissed: Number(body.id) });
    }
    const r = Array.isArray(body.answers)
      ? await answerPlanQuestions(env, body)
      : await answerPlanQuestion(env, body);
    return Response.json(r, { status: r.error ? 400 : 200 });
  }
  if (url.pathname === "/api/system") {
    // Everything the dashboard's System tab shows: rank, goals (with roadmap + pace),
    // today's quests, the work log, and the autonomy setting.
    const [rank, goalsR, questsToday, activity, settings, metrics] = await Promise.all([
      getSystemState(env),
      listGoals(env, { status: "all" }),   // already carries progress + pace
      env.DB.prepare(`
        SELECT id, goal_id, milestone_id, text, kind, status, xp, due_at, issued_at, resolved_at
        FROM quests WHERE date(issued_at, '+330 minutes') = date('now', '+330 minutes')
        ORDER BY CASE status WHEN 'issued' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, id`).all(),
      env.DB.prepare(`
        SELECT id, at, kind, actor, summary, detail, reasoning, goal_id, quest_id
        FROM activity ORDER BY id DESC LIMIT 60`).all(),
      getSettings(env),
      listMetrics(env, {}),
    ]);
    // Attach each goal's roadmap + the reasoning behind its latest plan, so the
    // dashboard can show WHY the route looks the way it does, not just what it is.
    const goals = await Promise.all(goalsR.goals.map(async g => {
      const [milestones, plan] = await Promise.all([
        listMilestones(env, g.id),
        env.DB.prepare(
          `SELECT reasoning, at, kind FROM activity
           WHERE goal_id = ? AND kind IN ('plan','plan_adapt') AND reasoning IS NOT NULL
           ORDER BY id DESC LIMIT 1`).bind(g.id).first(),
      ]);
      return { ...g, milestones, plan_reasoning: plan?.reasoning || null, plan_at: plan?.at || null };
    }));
    return Response.json({
      rank, goals, settings,
      quests_today: questsToday.results,
      activity: activity.results,
      metrics: metrics.metrics,
      awards: (await listAwards(env)).awards,
      plan_questions: (await listPlanQuestions(env, { status: "open" })).questions,
      // Battle record: per-IST-day quest outcomes for the last 14 days.
      quest_history: (await env.DB.prepare(`
        SELECT date(issued_at, '+330 minutes') AS d,
               SUM(status = 'done') AS done, SUM(status = 'failed') AS failed, COUNT(*) AS n
        FROM quests WHERE datetime(issued_at) >= datetime('now', '-14 days')
        GROUP BY d ORDER BY d`).all()).results,
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/ai-debug" && url.searchParams.get("t") === env.DASH_TOKEN) {
      try {
        const res = await env.AI.run("@cf/openai/gpt-oss-120b",
          { input: "Reply with exactly: BINDING OK", reasoning: { effort: "low" } });
        return Response.json({ raw: res });
      } catch (e) {
        return Response.json({ error: String(e) });
      }
    }
    if (url.pathname === "/ingest/notification" && request.method === "POST") {
      // The phone bridge posts here. Its own secret, so a leaked dashboard token
      // can't write into the agent's senses.
      if (request.headers.get("X-Intelly-Secret") !== env.NOTIFY_SECRET || !env.NOTIFY_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "expected json" }, { status: 400 });
      }
      try {
        return Response.json(await ingestNotification(env, payload));
      } catch (e) {
        return Response.json({ error: String(e).slice(0, 150) }, { status: 500 });
      }
    }
    if (url.pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return handleApi(url, env, request);
    // The dashboard is one HTML file that changes every deploy — never let a browser
    // or edge cache serve a stale copy, or a UI fix looks broken until a hard reload.
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-cache, must-revalidate");
    return new Response(res.body, { status: res.status, headers });
  },
  async scheduled(_event, env) {
    await runReminders(env);
    // One job failing must never stop the others.
    for (const [name, fn] of [
      ["senses", runSenses],
      ["money", processBankNotifications],   // bank alerts Phase 4 filed -> transactions
      // The System last: it issues the day's quests and holds the nightly reckoning,
      // self-gating on the IST hour (issue 07:00, debrief 21:00).
      ["system", e => runSystem(e, tg, { spawn: (en, args) => TOOLS.spawn_research.run(en, args) })],
    ]) {
      try {
        const out = await fn(env);
        if (out && !out.skipped) console.log(`${name}:`, JSON.stringify(out).slice(0, 200));
      } catch (e) {
        console.log(`${name} failed:`, String(e).slice(0, 200));
      }
    }
  },
};
