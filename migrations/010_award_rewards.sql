-- Tangible rewards on awards: every earned badge also carries a real-world treat
-- (a dinner, something fun, "spend ₹5000 on yourself"), generated from the owner's
-- memories and scaled to the achievement's weight. `reward_claimed_at` records when
-- the owner marked it redeemed — so the dashboard tracks treats owed vs taken.
ALTER TABLE awards ADD COLUMN reward TEXT;
ALTER TABLE awards ADD COLUMN reward_claimed_at TEXT;
