import postgres from "postgres"

export type Db = ReturnType<typeof postgres>
export type Tx = postgres.TransactionSql<Record<string, never>>

export const ddl = [
  `CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,
    worktree TEXT NOT NULL,
    vcs TEXT,
    name TEXT,
    icon_url TEXT,
    icon_color TEXT,
    sandboxes JSONB,
    sandboxes_raw BYTEA NOT NULL,
    commands JSONB,
    commands_raw BYTEA,
    time_created BIGINT NOT NULL,
    time_updated BIGINT NOT NULL,
    time_initialized BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    branch TEXT,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT,
    directory TEXT,
    extra JSONB,
    extra_raw BYTEA,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    url TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expiry BIGINT,
    time_created BIGINT NOT NULL,
    time_updated BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS account_state (
    id BIGINT PRIMARY KEY,
    active_account_id TEXT,
    active_org_id TEXT,
    FOREIGN KEY (active_account_id) REFERENCES account(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_account (
    email TEXT NOT NULL,
    url TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expiry BIGINT,
    active BOOLEAN NOT NULL,
    time_created BIGINT NOT NULL,
    time_updated BIGINT NOT NULL,
    PRIMARY KEY (email, url)
  )`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    root_session_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions BIGINT,
    summary_deletions BIGINT,
    summary_files BIGINT,
    summary_diffs JSONB,
    summary_diffs_raw BYTEA,
    revert JSONB,
    revert_raw BYTEA,
    permission JSONB,
    permission_raw BYTEA,
    time_created BIGINT NOT NULL,
    time_updated BIGINT NOT NULL,
    time_compacting BIGINT,
    time_archived BIGINT,
    data JSONB,
    data_raw BYTEA NOT NULL,
    origin_machine TEXT,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_share (
    session_id TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    secret TEXT NOT NULL,
    url TEXT NOT NULL,
    time_created BIGINT NOT NULL,
    time_updated BIGINT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS permission (
    project_id TEXT PRIMARY KEY,
    time_created BIGINT NOT NULL,
    time_updated BIGINT NOT NULL,
    data JSONB,
    data_raw BYTEA NOT NULL,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created BIGINT,
    time_updated BIGINT,
    role TEXT,
    agent TEXT,
    model_provider_id TEXT,
    model_id TEXT,
    data JSONB,
    data_raw BYTEA NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created BIGINT,
    time_updated BIGINT,
    part_type TEXT,
    text TEXT,
    model TEXT,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cost DOUBLE PRECISION,
    data JSONB,
    data_raw BYTEA NOT NULL,
    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS todo (
    session_id TEXT NOT NULL,
    position BIGINT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    time_created BIGINT,
    time_updated BIGINT,
    PRIMARY KEY (session_id, position),
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS event_sequence (
    aggregate_id TEXT PRIMARY KEY,
    seq BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event (
    id TEXT PRIMARY KEY,
    aggregate_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    type TEXT NOT NULL,
    data JSONB,
    data_raw BYTEA NOT NULL,
    origin JSONB,
    origin_raw BYTEA
  )`,
  `CREATE TABLE IF NOT EXISTS replication_state (
    source_machine TEXT NOT NULL,
    source_session_root TEXT NOT NULL,
    last_event_id TEXT,
    last_seq BIGINT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (source_machine, source_session_root)
  )`,
  `CREATE TABLE IF NOT EXISTS resumable_checkpoint (
    session_id TEXT PRIMARY KEY,
    machine TEXT NOT NULL,
    checkpoint_time BIGINT NOT NULL,
    last_event_id TEXT,
    last_message_id TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_project ON workspace(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_project ON session(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_parent ON session(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_root ON session(root_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_workspace ON session(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_part_session ON part(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_todo_session ON todo(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_event_aggregate ON event(aggregate_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resumable_checkpoint_machine ON resumable_checkpoint(machine)`,
  `CREATE INDEX IF NOT EXISTS idx_part_text_fts ON part USING GIN (to_tsvector('english', coalesce(text, '')))`,
  `CREATE OR REPLACE VIEW token_usage AS
   SELECT
     model,
     SUM(input_tokens) AS input_tokens,
     SUM(output_tokens) AS output_tokens,
     SUM(cost) AS total_cost,
     COUNT(DISTINCT session_id) AS sessions,
     date_trunc('day', to_timestamp((time_created / 1000.0))) AS day
   FROM part
   WHERE part_type = 'step-start'
     AND input_tokens IS NOT NULL
   GROUP BY model, date_trunc('day', to_timestamp((time_created / 1000.0)))`,
] as const

export async function ensure(sql: Db) {
  for (const item of ddl) {
    await sql.unsafe(item)
  }
}
