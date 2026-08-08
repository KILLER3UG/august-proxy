-- 011_routing_evidence_prompt.sql
-- Arena/debate verdicts now carry the original prompt so the archive can
-- offer replay (re-run the same lanes on the same prompt). Normal turns
-- leave it empty.
ALTER TABLE routing_evidence ADD COLUMN prompt TEXT DEFAULT '';
