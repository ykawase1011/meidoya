-- 0002: indexes for the hot read paths that previously full-scanned
-- unbounded tables (task_events, checkpoints, artifacts).

-- listTaskEvents(taskId) reads in (created_at, id) order.
CREATE INDEX IF NOT EXISTS task_events_task_created_idx
  ON task_events(task_id, created_at, id);

-- openCheckpointFor(taskId): newest pending checkpoint of one task.
CREATE INDEX IF NOT EXISTS checkpoints_task_created_idx
  ON checkpoints(task_id, created_at);

-- The STATUS.md projector polls "all pending checkpoints" every few seconds.
-- A partial index keeps that touching only the (small) open set instead of
-- scanning every checkpoint ever created.
CREATE INDEX IF NOT EXISTS checkpoints_pending_idx
  ON checkpoints(task_id, created_at)
  WHERE status = 'pending';

-- listArtifacts(taskId).
CREATE INDEX IF NOT EXISTS artifacts_task_idx
  ON artifacts(task_id, id);
