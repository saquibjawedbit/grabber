-- 006: concrete steps per milestone.
-- Milestones were labels ("Caloric Surplus & Meal-Prep Engine"); quest generation had
-- nothing specific to draw from. Each milestone now carries a JSON array of concrete,
-- day-sized steps the planner writes — the raw material for daily quests and side quests.
ALTER TABLE milestones ADD COLUMN steps TEXT;   -- JSON: ["step", ...]
