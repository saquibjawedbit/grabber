-- Frictionless onboarding: replace the beta invite gate with email + password accounts.
-- A tenant now signs up with {email, password, bot_token} at /signup and logs back in at
-- /login. The password is PBKDF2-hashed (worker/src/tenant.js hashPassword). The dashboard
-- session is still the tenant's dashboard_token (login just hands it back). Tenant #1 (the
-- owner, env-backed) keeps email/password NULL. See docs/09-multi-tenant.md.
ALTER TABLE users ADD COLUMN email         TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;   -- pbkdf2$<iters>$<saltB64>$<hashB64>

-- One account per email; partial so the owner's NULL email doesn't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
