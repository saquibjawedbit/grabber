# Proposal — Analytics & feedback (owner-only admin view)

> **Status: DESIGN / NOT YET BUILT.** This is a roadmap, not a description of current
> behavior. The numbered `docs/01`–`09` describe what's live; this proposal does not.

## Goal

Now that The System is multi-tenant, give the **owner** (super-admin, tenant #1) a way to
see what users are doing, where they drop off, which features matter, and what to improve —
plus a channel for users to file **feature requests / bugs**. Cheap, privacy-respecting, and
mostly derived from data we already store.

## Principle: derive first, instrument the gaps

Most engagement data already exists in D1, keyed by `user_id`. Prefer aggregate queries over
new writes:

| Question | Source (existing) |
|---|---|
| Signups, "never sent /start" drop-off | `users.created_at`, `users.owner_chat_id IS NULL` |
| Last active / message volume | `chat_history` (max `at`, counts) |
| Quests issued / done / failed, completion rate, time-to-done | `quests`, `activity` |
| Progress: level / XP / streak | `state` |
| Goals set, milestones, plan questions | `goals`, `milestones`, `plan_questions` |
| Feature adoption (money/health/food/research) | `transactions`, `health`, `meals`, `research` |
| Awards earned | `awards` |

Only add instrumentation for what these can't answer: **per-tool usage frequency, errors,
guard trips, and explicit funnel marks.**

## New tables (migration `014_analytics.sql`)

```sql
-- Append-only usage events. METADATA ONLY — never message/memory/money content.
CREATE TABLE usage_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind    TEXT NOT NULL,      -- signup | started | goal_created | quest_done | tool:<name>
                              -- | research_spawned | error | guard_unscoped | feedback
  meta    TEXT,               -- small JSON: {tool, ok, ms, code} — NO content
  at      TEXT NOT NULL
);
CREATE INDEX idx_usage_user_at ON usage_events(user_id, at);
CREATE INDEX idx_usage_kind_at ON usage_events(kind, at);

-- User-submitted feedback / feature requests.
CREATE TABLE feedback (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'idea',   -- bug | feature | idea | other
  text    TEXT NOT NULL,
  status  TEXT NOT NULL DEFAULT 'open',   -- open | planned | shipped | declined
  at      TEXT NOT NULL,
  handled_at TEXT
);
```

Both are `user_id`-scoped → add to the guard's `SCOPED` set in `worker/src/tenant.js`, so
per-tenant reads/writes stay isolated (the admin view deliberately bypasses this — below).

## `track()` — one helper, few call sites (`worker/src/analytics.js`, new)

```js
export function track(env, kind, meta) {
  // fire-and-forget; never throws into the caller
  try {
    return env.DB.prepare("INSERT INTO usage_events (user_id, kind, meta, at) VALUES (?,?,?,?)")
      .bind(uid(env), kind, meta ? JSON.stringify(meta).slice(0, 300) : null, new Date().toISOString()).run();
  } catch { /* analytics must never break a turn */ }
}
```

Instrument the handful of spots that matter:
- `handleRegister` → `signup`; first `/start` → `started` (in `handleCommand`).
- The agent tool loop (`agent.js runAgent`) → `tool:<name>` with `{ok, ms}` per tool call.
- `spawn_research` → `research_spawned`.
- Central error/catch points + the guard's `throw`/`warn` → `error` / `guard_unscoped`.
- `createGoal` → `goal_created`; quest resolution already logs to `activity` (no dup).

**Free-tier note:** a handful of beta users → tens of events/day, negligible vs D1's 100k
writes/day. If it ever grows, sample `tool:*` events (e.g. 1-in-N) and keep funnel/error
events unsampled. Add a nightly prune (`DELETE FROM usage_events WHERE at < now-90d`).

## Feedback channel

- **Bot command** `/feedback <text>` (in `handleCommand`) → inserts `feedback` (kind auto:
  "bug" if text starts with bug/broken/error, else "idea"). Confirms receipt.
- **Agent tool** `submit_feedback {kind, text}` (in `SYSTEM_TOOLS` or a small module) so the
  model can file it mid-conversation when a user says "I wish it could…".
- Users see their own submitted feedback + status on their dashboard (scoped read).

## Admin view (owner-only, cross-tenant)

**Auth:** `/api/admin/*` gated by an **exact** `t === env.DASH_TOKEN` check (the owner's
token only — NOT the per-tenant `resolveTenant` path, which would scope to one tenant).
Uses the **raw, unscoped `env.DB`** because it aggregates across all tenants. This is the one
deliberate exception to the tenant guard, and it must be owner-only.

Endpoints:
- `GET /api/admin/overview` — cohort metrics (below).
- `GET /api/admin/tenants` — per-tenant table.
- `GET /api/admin/feedback` — inbox; `POST /api/admin/feedback` to set status.

### Cohort metrics (overview)
- **Funnel**: signed up → sent /start → created a goal → cleared ≥1 quest → active in last 7d.
- **Retention**: DAU / WAU, % active at day 1 / 7 / 30 after signup.
- **Engagement**: median quests/day, median chat turns/day, quest completion rate distribution.
- **Adoption**: % of tenants who logged money / food / health / ran research.
- **Reliability**: errors and `guard_unscoped` events per day; top failing tools.

### Per-tenant row (privacy: metadata + goal titles)
`bot_username`, signup date, last-active, level / XP / streak, quests issued/done/failed (+
completion %), awards, research count, feature flags, error count — **plus their goal titles
and current quest text** (owner opted in). **Never** exposed: memories, transactions/amounts,
chat message content, health values. Keep that boundary in the query itself (select only the
allowed columns).

### Dashboard
A new **Admin** tab in `worker/public/index.html`, shown only when the loaded token equals the
owner token (the API 403s otherwise). Cards for the funnel + retention, a sortable tenant
table, and a feedback inbox with status buttons. Reuse the existing dashboard's chart/table
styles.

## Implementation phases (when built)
1. `014_analytics.sql` + `schema.sql` sync; add `usage_events`/`feedback` to `SCOPED`.
2. `analytics.js` `track()` + instrument the ~6 call sites; `/feedback` command +
   `submit_feedback` tool.
3. `/api/admin/*` (owner-gated, unscoped) + the aggregate queries.
4. Admin dashboard tab.
5. Nightly prune + optional sampling.

## Files
- **New:** `worker/src/analytics.js`, `migrations/014_analytics.sql`.
- `worker/src/index.js` — `/api/admin/*` routes, `/feedback` command, `track()` calls, admin gate.
- `worker/src/agent.js` — per-tool `track()`; `submit_feedback` tool.
- `worker/src/tenant.js` — add `usage_events`, `feedback` to `SCOPED`.
- `worker/public/index.html` — Admin tab.
- `schema.sql` + `docs/` (promote to `docs/10-analytics.md` once live).

## Risks / notes
- The admin endpoint is the single place that reads across tenants — guard it with the exact
  owner-token check and unit-test that a per-tenant `dashboard_token` gets 403.
- Keep `meta` strictly non-content; a stray message/amount in analytics would defeat the
  privacy model.
- Don't let `track()` failures ever surface to the user (fire-and-forget, swallowed).
