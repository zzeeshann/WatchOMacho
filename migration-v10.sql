-- v9 → v10: skills get explicit tool config.
--
-- Before: a skill's tool selection was parsed from markdown headers
-- (**Tavily op:** search, **Search topic:** news, etc.) on every run.
-- That meant the LLM had to author headers the parser would accept, the
-- parser had to recognise five different tool families, and the same
-- info lived in two places (the markdown and the in-memory SkillToolCall).
--
-- After: tool slug / op / params live in their own columns. The markdown
-- body (`procedure_md`) is just the writer instructions — feeds the
-- planner + writer prompts verbatim. Renamed in the UI to "Writer
-- instructions". WYSIWYG, no parsing.
--
-- Backfill happens in code on first admin load (parseLegacySkillTools in
-- agent.ts) so this migration is just the schema change.

ALTER TABLE skills ADD COLUMN tool_slug TEXT;
ALTER TABLE skills ADD COLUMN tool_op TEXT;
ALTER TABLE skills ADD COLUMN tool_params_json TEXT;
ALTER TABLE skills ADD COLUMN tool_sources_json TEXT;
