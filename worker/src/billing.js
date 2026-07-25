// billing.js — the paywall's payment layer: Razorpay ₹149/month subscriptions.
//
// Config (all secrets/vars, set by the owner; absent = billing simply "not configured",
// and the app runs on trials only):
//   RZP_KEY_ID, RZP_KEY_SECRET  — Razorpay API keys
//   RZP_PLAN_ID                 — a ₹149/month Plan created once in the Razorpay dashboard
//   RZP_WEBHOOK_SECRET          — the webhook signing secret (dashboard → Webhooks)
//   RZP_PAYMENT_LINK (optional) — a static payment link, used only if API keys are absent
//
// Flow: /upgrade (bot) or the dashboard's Upgrade button -> createSubscription() returns a
// short_url the user opens to authorize the mandate + pay. Razorpay then POSTs webhooks to
// /api/razorpay/webhook; applyWebhookEvent() flips the user to `pro` and sets plan_expires_at.

export const TRIAL_DAYS = 14;
export const PRICE_INR = 149;
export const PLAN_LABEL = "AXIS Pro · ₹149/month";

export function billingConfigured(env) {
  return !!(env.RZP_KEY_ID && env.RZP_KEY_SECRET && env.RZP_PLAN_ID);
}

// Create a Razorpay subscription for this tenant. Returns { url, id } or { error }.
export async function createSubscription(env, tenant) {
  if (!billingConfigured(env)) {
    // Fall back to a static payment link if one is configured; otherwise report it's off.
    return env.RZP_PAYMENT_LINK ? { url: env.RZP_PAYMENT_LINK } : { error: "billing not configured yet" };
  }
  const auth = "Basic " + btoa(`${env.RZP_KEY_ID}:${env.RZP_KEY_SECRET}`);
  try {
    const r = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_id: env.RZP_PLAN_ID,
        total_count: 120,                 // up to ~10 years of monthly cycles
        customer_notify: 1,
        notes: { user_id: String(tenant.id), email: tenant.email || "" },
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.id) return { error: d?.error?.description || "razorpay rejected the request" };
    return { url: d.short_url, id: d.id };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

// HMAC-SHA256 hex — Razorpay signs webhooks this way (and it's what checkout verify uses).
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Verify the X-Razorpay-Signature header against the raw request body.
export async function verifyWebhook(env, rawBody, signature) {
  if (!env.RZP_WEBHOOK_SECRET || !signature) return false;
  const expected = await hmacHex(env.RZP_WEBHOOK_SECRET, rawBody);
  if (expected.length !== signature.length) return false;
  let diff = 0;                                             // constant-time compare
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// Apply a VERIFIED Razorpay webhook event to the users table (found by rzp_sub_id, set at
// checkout). `env.DB` here is the raw (unscoped) DB — the webhook carries no tenant token.
export async function applyWebhookEvent(env, event) {
  const sub = event?.payload?.subscription?.entity;
  if (!sub?.id) return { skipped: event?.event || "unknown" };
  const kind = event.event;
  if (["subscription.charged", "subscription.activated", "subscription.resumed"].includes(kind)) {
    const expires = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
    const r = await env.DB.prepare("UPDATE users SET plan = 'pro', plan_expires_at = ? WHERE rzp_sub_id = ?")
      .bind(expires, sub.id).run();
    return { applied: kind, rows: r.meta.changes, expires };
  }
  // halted / cancelled / completed: leave plan_expires_at — access lapses naturally at period end.
  return { noted: kind };
}
