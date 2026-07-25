-- Paywall: a 14-day free trial, then ₹149/month via Razorpay (soft lock). Entitlement is
-- computed in worker/src/tenant.js `entitled()`; the owner (tenant #1) is always entitled.
-- See docs/09-multi-tenant.md and worker/src/billing.js.
ALTER TABLE users ADD COLUMN plan            TEXT NOT NULL DEFAULT 'trial';  -- trial | pro
ALTER TABLE users ADD COLUMN trial_ends_at   TEXT;   -- set at signup (created_at + 14d), ISO
ALTER TABLE users ADD COLUMN plan_expires_at TEXT;   -- pro period end, renewed by the webhook; NULL on trial
ALTER TABLE users ADD COLUMN rzp_sub_id      TEXT;   -- Razorpay subscription id (for webhook lookup)

-- Existing tenants: owner is 'pro' forever; any real tenant gets a fresh 14-day trial.
UPDATE users SET plan = 'pro' WHERE id = 1;
UPDATE users SET trial_ends_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+14 days')
  WHERE id > 1 AND trial_ends_at IS NULL;
