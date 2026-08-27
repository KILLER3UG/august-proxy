-- 024_drop_verifier_gate_log.sql
-- The verifier gate was removed 2026-08-24; its log table lost its last
-- writer then and was unlisted from the privacy purge + session child-table
-- cleanup in the 023 audit batch. Existing installs still carry the orphan
-- (and its rows escape retention cleanup forever), so drop it here.
-- Separate migration because 023 already ran on those installs and the
-- runner never re-executes applied versions.

DROP TABLE IF EXISTS verifier_gate_log;
