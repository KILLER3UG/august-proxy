-- P6 (harness hygiene): retire pending_skills.
--
-- The table had a schema, a session-cascade delete, a rename-map entry — and
-- no writer, no reader, no router, and no UI consumer anywhere in the repo
-- (audited 2026-09-10: only the privacy/session plumbing and this table's
-- own schema referenced it; live installs carry nothing but a demo row).
-- Skill drafts that wait for a human decision go through the harness
-- proposals queue (harness_proposals / distiller, origin='distilled') and
-- surface in the Review Inbox; this second, orphaned queue is dead weight
-- with rows that escape retention cleanup forever. Drop it like 024 dropped
-- verifier_gate_log. Legacy camelCase 'pendingSkills' is still renamed in
-- first (migrate_camel_to_snake runs before migrations), so old installs
-- converge too. The data/skills/.pending_*.md draft files it pointed at
-- stay on disk for manual recovery; nothing reads them.

DROP TABLE IF EXISTS pending_skills;
