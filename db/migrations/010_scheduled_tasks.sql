-- Migration: Add scheduled_at to tasks for Cron support
SET LOCAL search_path TO localclaw, public;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tasks_status_scheduled
  ON tasks(status, scheduled_at)
  WHERE status = 'pending';

COMMENT ON COLUMN tasks.scheduled_at IS 'The earliest time this task should be eligible for leasing.';
