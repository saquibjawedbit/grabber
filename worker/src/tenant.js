// tenant.js — the multi-tenant seam.
//
// Every function in this Worker already reaches the world through `env`
// (env.DB.prepare, env.TELEGRAM_BOT_TOKEN, env.VECTORIZE, ...). So we don't thread a
// tenant argument through hundreds of signatures: each entry point wraps `env` ONCE
// with scopeEnv(), and every downstream call becomes tenant-aware for free because it
// already reads from env. `env._tenant` is the tenant's `users` row; env.DB becomes a
// tenant-guarded DB. Unknown keys pass straight through to the real env, so every
// existing secret/binding read keeps working unchanged.

// Tables that MUST carry user_id in every query once the schema migration lands.
// The inert opportunity-engine tables (postings/idf/alerts/outcomes/drafts/calibration)
// are deliberately excluded — they're global/dormant, see the plan §3.
const SCOPED = new Set([
  "profile", "state", "memories", "chat_history", "reminders", "goals", "milestones",
  "quests", "activity", "metrics", "plan_questions", "research", "applications",
  "emails", "events", "health", "meals", "notifications", "transactions", "accounts",
  "holdings", "people", "interactions", "merchant_category", "notify_allow", "awards",
]);
const tableRe = new RegExp(`\\b(?:from|join|into|update)\\s+(${[...SCOPED].join("|")})\\b`, "i");

// The DB guard turns a forgotten `user_id` from a silent cross-tenant leak into a loud
// failure. Mode is env-driven so the wrapper can ship inert now and be flipped per
// phase with no code change:
//   TENANT_GUARD = "off" (default) | "warn" (log) | "strict" (throw)
// Retrofit the 253 query sites under "warn", then run staging under "strict" to make
// the first missed site throw instead of quietly serving tenant A's data to tenant B.
function guardedDb(db, userId, mode) {
  if (mode !== "warn" && mode !== "strict") return db;       // pure pass-through
  return new Proxy(db, {
    get(t, k) {
      if (k !== "prepare") return typeof t[k] === "function" ? t[k].bind(t) : t[k];
      return (sql) => {
        if (tableRe.test(sql) && !/user_id/.test(sql)) {
          const m = `UNSCOPED query (tenant ${userId}): ${String(sql).slice(0, 90)}`;
          if (mode === "strict") throw new Error(m);
          console.log(m);
        }
        return db.prepare(sql);
      };
    },
  });
}

// A per-request env carrying the tenant + a tenant-guarded DB.
export function scopeEnv(env, tenant) {
  const gdb = guardedDb(env.DB, tenant.id, env.TENANT_GUARD || "off");
  return new Proxy(env, {
    get(t, k) {
      if (k === "DB") return gdb;
      if (k === "_tenant") return tenant;
      return t[k];
    },
  });
}

// Accessors used at the call sites we migrate off the global secrets.
export const uid = (env) => env._tenant.id;
export const tz = (env) => env._tenant.timezone || "Asia/Kolkata";
export const ownerChat = (env) => env._tenant.owner_chat_id;
export const botToken = (env) => env._tenant.bot_token;
export const webhookSecret = (env) => env._tenant.webhook_secret;

// ---------- Secret encryption at rest (AES-GCM via env.MASTER_KEY) ----------
// A bot token / Google refresh token is full account control, so a leaked D1 dump must
// not hand them over. MASTER_KEY is base64 of 32 random bytes (a Worker secret).
// Encrypted values are stored as "enc:" + base64(iv[12] || ciphertext); anything without
// the prefix is treated as plaintext (legacy / MASTER_KEY unset), so this degrades soft.
async function aesKey(env) {
  if (!env.MASTER_KEY) return null;
  const bytes = Uint8Array.from(atob(env.MASTER_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env, text) {
  const key = await aesKey(env);
  if (!key || text == null) return text ?? null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(String(text))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  let s = ""; for (const b of out) s += String.fromCharCode(b);
  return "enc:" + btoa(s);
}

export async function decryptSecret(env, blob) {
  if (typeof blob !== "string" || !blob.startsWith("enc:")) return blob;   // plaintext/legacy
  const key = await aesKey(env);
  if (!key) return blob;
  const raw = Uint8Array.from(atob(blob.slice(4)), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return new TextDecoder().decode(pt);
}

// Random opaque token as lowercase hex (webhook_id, dashboard_token, ...).
export function hexToken(nbytes = 16) {
  const b = crypto.getRandomValues(new Uint8Array(nbytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Tenant #1 fabricated from the legacy env secrets. Lets the owner keep working before
// (and after) the `users` row is populated — migration 011 seeds a matching id=1 row so
// DB-backed lookups and this synthetic view agree.
export function syntheticOwner(env) {
  return {
    id: 1,
    bot_token: env.TELEGRAM_BOT_TOKEN,
    bot_username: null,
    bot_id: null,
    webhook_id: null,
    webhook_secret: env.TG_WEBHOOK_SECRET,
    owner_chat_id: env.TELEGRAM_CHAT_ID,
    timezone: "Asia/Kolkata",
    dashboard_token: env.DASH_TOKEN,
    notify_secret: env.NOTIFY_SECRET,
    google_refresh_token: env.GOOGLE_REFRESH_TOKEN,
    gmail_address: null,
    status: "active",
  };
}

// Resolve a tenant from one entry-point key and return a scoped env, or null on a miss
// the caller should reject. `by` is one of {webhookId} | {dashToken} | {notifySecret}.
// The legacy env secrets still resolve to tenant #1 (the owner), so /telegram, the admin
// DASH_TOKEN, and the owner's NOTIFY_SECRET keep working alongside self-registered bots.
export async function resolveTenant(env, by) {
  // Owner short-circuits: env-backed secrets always map to the synthetic owner (tenant #1).
  if (by.dashToken && env.DASH_TOKEN && by.dashToken === env.DASH_TOKEN) {
    return scopeEnv(env, syntheticOwner(env));
  }
  if (by.notifySecret && env.NOTIFY_SECRET && by.notifySecret === env.NOTIFY_SECRET) {
    return scopeEnv(env, syntheticOwner(env));
  }

  let row = null;
  if (by.id) {
    row = await env.DB.prepare(
      "SELECT * FROM users WHERE id = ? AND status = 'active'").bind(by.id).first();
  } else if (by.webhookId) {
    row = await env.DB.prepare(
      "SELECT * FROM users WHERE webhook_id = ? AND status = 'active'").bind(by.webhookId).first();
  } else if (by.dashToken) {
    row = await env.DB.prepare(
      "SELECT * FROM users WHERE dashboard_token = ? AND status = 'active'").bind(by.dashToken).first();
  } else if (by.notifySecret) {
    row = await env.DB.prepare(
      "SELECT * FROM users WHERE notify_secret = ? AND status = 'active'").bind(by.notifySecret).first();
  }
  if (!row) return null;

  // Tenant #1's row is a stub — fill it from the env secrets so the owner's real bot/token
  // are used, not the NULLs seeded by migration 011.
  if (row.id === 1) return scopeEnv(env, { ...syntheticOwner(env), timezone: row.timezone });

  // Real tenant: decrypt the secrets held at rest so tg()/webhook checks see plaintext.
  row.bot_token = await decryptSecret(env, row.bot_token);
  row.webhook_secret = await decryptSecret(env, row.webhook_secret);
  row.google_refresh_token = await decryptSecret(env, row.google_refresh_token);
  return scopeEnv(env, row);
}
