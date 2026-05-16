-- v6 → v7: per-report model tracking + selectable chat model
--
-- Adds:
--   reports.chat_model — which model wrote this report (nullable for old rows)
--   settings('chat_model') — admin-editable default, used by all chat calls

ALTER TABLE reports ADD COLUMN chat_model TEXT;

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('chat_model', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 0);
