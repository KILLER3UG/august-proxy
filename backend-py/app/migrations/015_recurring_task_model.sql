-- 015_recurring_task_model.sql
-- Recurring tasks may pin a custom model for their sub-agent dispatch
-- (structured alternative to the [agent:ID model:MODEL] text directive).
ALTER TABLE recurring_tasks ADD COLUMN model TEXT;
