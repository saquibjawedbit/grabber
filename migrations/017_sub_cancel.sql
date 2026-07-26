-- Subscription cancellation UX. cancelSubscription() uses Razorpay's cancel_at_cycle_end,
-- so a cancelled subscription stays active (and billable-looking) until the period ends —
-- the subscription.cancelled webhook only fires then. Without a local marker the dashboard
-- can't tell "active" from "cancelling", so the Cancel button kept showing after a cancel.
-- This column records the period-end at which a scheduled cancel takes effect; the
-- Subscription tab shows "cancelling, access until <date>" and hides Cancel while it's set.
-- Cleared on renewal/resume (subscription.charged/.activated/.resumed) and when the sub
-- actually ends (subscription.cancelled/.completed clears rzp_sub_id + sub_cancel_at).
ALTER TABLE users ADD COLUMN sub_cancel_at TEXT;   -- ISO period-end of a scheduled cancel; NULL = active/none
