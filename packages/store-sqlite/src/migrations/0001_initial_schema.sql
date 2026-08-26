-- Initial business schema. See meidoya-design/schema-outline.sql for the source of truth.

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  kind TEXT NOT NULL CHECK (kind IN ('execution', 'coordination')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'retired')),
  policy_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  workspace_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, workspace_ref)
);

CREATE TABLE ingress_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL CHECK (source IN ('slack', 'discord', 'cli', 'http')),
  account_ref TEXT,
  channel_ref TEXT,
  profile_ref TEXT,
  scope_lock INTEGER NOT NULL DEFAULT 1 CHECK (scope_lock = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source, account_ref, channel_ref, profile_ref)
);

CREATE TABLE delegation_grants (
  id TEXT PRIMARY KEY,
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  capabilities_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (source_workspace_id, target_workspace_id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  ingress_binding_id TEXT REFERENCES ingress_bindings(id),
  external_thread_ref TEXT,
  root_message_ref TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (ingress_binding_id, external_thread_ref)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT REFERENCES conversations(id),
  parent_task_id TEXT REFERENCES tasks(id),
  origin TEXT NOT NULL CHECK (origin IN ('chat', 'cli', 'schedule', 'delegation', 'agent')),
  pipeline TEXT NOT NULL,
  title TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  status TEXT NOT NULL,
  temporal_workflow_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX tasks_workspace_status_idx ON tasks(workspace_id, status);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_key TEXT NOT NULL,
  step_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  output_json TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_id, step_key)
);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL,
  answer_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id TEXT REFERENCES task_steps(id),
  role TEXT NOT NULL CHECK (role IN ('head-maid', 'maid', 'manager', 'worker')),
  worker_profile TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
  model_profile TEXT NOT NULL CHECK (model_profile IN ('high', 'standard', 'economy')),
  execution_node_id TEXT,
  external_session_id TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id TEXT REFERENCES task_steps(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'summary', 'user')),
  created_at INTEGER NOT NULL
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  temporal_schedule_id TEXT NOT NULL UNIQUE,
  spec_json TEXT NOT NULL,
  task_template_json TEXT NOT NULL,
  delivery_policy TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE execution_nodes (
  id TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL,
  platform TEXT NOT NULL,
  architecture TEXT NOT NULL,
  profile TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE node_workspace_bindings (
  node_id TEXT NOT NULL REFERENCES execution_nodes(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  PRIMARY KEY (node_id, workspace_id)
);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT REFERENCES conversations(id),
  event_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX outbox_pending_idx
  ON notification_outbox(status, available_at);
