-- v4 migration: per-exploration single-writer lock.
-- Without this, concurrent pumpers (cron + admin pageload + the dispatcher's
-- own waitUntil chain) can each see the same current_step and write the same
-- sub-step note three times. The advancing_at column is a stale-tolerant lock.

ALTER TABLE explorations ADD COLUMN advancing_at INTEGER;
