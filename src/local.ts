import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Database as SQLite } from "bun:sqlite"
import type { Db } from "./schema.js"
import { normalize, checkpoint } from "./resume.js"

type Obj = Record<string, unknown>

const dec = new TextDecoder()

function open(path: string, opts?: { readonly?: boolean; create?: boolean }) {
  const db = new SQLite(path, opts)
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

function txt(v: unknown) {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown) {
  if (typeof v === "number") return v
  if (typeof v === "string" && v.trim()) {
    const value = Number(v)
    if (!Number.isNaN(value)) return value
  }
  return undefined
}

function text(v: unknown) {
  if (typeof v === "string") return v
  if (v instanceof Uint8Array) return dec.decode(v)
  if (Buffer.isBuffer(v)) return dec.decode(v)
  return ""
}

function parse(textData: string) {
  try {
    return JSON.parse(textData) as Obj
  } catch {
    return {} as Obj
  }
}

function home() {
  return process.env.OPENCODE_TEST_HOME || os.homedir()
}

function data() {
  return path.join(process.env.XDG_DATA_HOME || path.join(home(), ".local", "share"), "opencode")
}

function sessionDir() {
  const dir = path.join(data(), "sessions")
  mkdirSync(dir, { recursive: true })
  return dir
}

function ensureShard(db: SQLite) {
  for (const stmt of [
    `CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS message_session_time_created_id_idx ON message (session_id, time_created, id)`,
    `CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS part_message_id_id_idx ON part (message_id, id)`,
    `CREATE INDEX IF NOT EXISTS part_session_idx ON part (session_id)`,
    `CREATE TABLE IF NOT EXISTS todo (
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      position INTEGER NOT NULL,
      time_created INTEGER,
      time_updated INTEGER,
      PRIMARY KEY (session_id, position)
    )`,
    `CREATE INDEX IF NOT EXISTS todo_session_idx ON todo (session_id)`,
    `CREATE TABLE IF NOT EXISTS event_sequence (
      aggregate_id TEXT NOT NULL PRIMARY KEY,
      seq INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      origin TEXT
    )`,
  ]) {
    db.query(stmt).run()
  }
}

async function remoteRoot(sql: Db, id: string) {
  const rows = await sql<Array<{ id: string }>>`
    WITH RECURSIVE tree AS (
      SELECT id, parent_id
      FROM session
      WHERE id = ${id}
      UNION ALL
      SELECT s.id, s.parent_id
      FROM session s
      JOIN tree t ON t.parent_id = s.id
    )
    SELECT id
    FROM tree
    WHERE parent_id IS NULL
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

function localRoot(db: SQLite, id: string) {
  const row = db
    .query(
      `WITH RECURSIVE tree AS (
      SELECT id, parent_id
      FROM session
      WHERE id = ?
      UNION ALL
      SELECT s.id, s.parent_id
      FROM session s
      JOIN tree t ON t.parent_id = s.id
    )
    SELECT id
    FROM tree
    WHERE parent_id IS NULL
    LIMIT 1`,
    )
    .get(id) as { id: string } | null
  return row?.id ?? id
}

function localIDs(path: string) {
  const db = open(path, { create: true })
  try {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session' LIMIT 1").get() as {
      name: string
    } | null
    if (!row) return new Set<string>()
    return new Set((db.query("SELECT id FROM session").all() as Array<{ id: string }>).map((item) => item.id))
  } finally {
    db.close()
  }
}

export async function syncMetadata(sql: Db, db: string) {
  mkdirSync(path.dirname(db), { recursive: true })
  const file = open(db, { create: true })
  try {
    const ids = localIDs(db)
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT
        s.id,
        s.project_id,
        s.workspace_id,
        s.origin_machine,
        s.parent_id,
        s.slug,
        s.directory,
        s.title,
        s.version,
        s.share_url,
        s.summary_additions,
        s.summary_deletions,
        s.summary_files,
        s.summary_diffs_raw,
        s.revert_raw,
        s.permission_raw,
        s.time_created,
        s.time_updated,
        s.time_compacting,
        s.time_archived
      FROM session s
      ORDER BY s.time_updated DESC
      LIMIT 5000
    `

    const upsert = file.query(`
      INSERT INTO session (
        id, project_id, workspace_id, origin_machine, parent_id, slug, directory, title, version, share_url,
        summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
        time_created, time_updated, time_compacting, time_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        origin_machine = excluded.origin_machine,
        parent_id = excluded.parent_id,
        slug = excluded.slug,
        directory = excluded.directory,
        title = excluded.title,
        version = excluded.version,
        share_url = excluded.share_url,
        summary_additions = excluded.summary_additions,
        summary_deletions = excluded.summary_deletions,
        summary_files = excluded.summary_files,
        summary_diffs = excluded.summary_diffs,
        revert = excluded.revert,
        permission = excluded.permission,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated,
        time_compacting = excluded.time_compacting,
        time_archived = excluded.time_archived
    `)

    const pending = rows.filter((row) => !ids.has(txt(row.id) ?? ""))
    for (let i = 0; i < pending.length; i++) {
      const row = pending[i]
      upsert.run(
        txt(row.id) ?? "",
        txt(row.project_id) ?? "",
        txt(row.workspace_id) ?? null,
        txt(row.origin_machine) ?? "unknown",
        txt(row.parent_id) ?? null,
        txt(row.slug) ?? "",
        txt(row.directory) ?? "",
        txt(row.title) ?? "",
        txt(row.version) ?? "",
        txt(row.share_url) ?? null,
        num(row.summary_additions) ?? null,
        num(row.summary_deletions) ?? null,
        num(row.summary_files) ?? null,
        row.summary_diffs_raw ? text(row.summary_diffs_raw) : null,
        row.revert_raw ? text(row.revert_raw) : null,
        row.permission_raw ? text(row.permission_raw) : null,
        num(row.time_created) ?? 0,
        num(row.time_updated) ?? 0,
        num(row.time_compacting) ?? null,
        num(row.time_archived) ?? null,
      )
      if (i % 500 === 499) await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    file.close()
  }
}

export async function refreshCheckpoints(sql: Db, db: string, machine: string) {
  const file = open(db, { readonly: true })
  try {
    const sessions = file.query("SELECT id FROM session ORDER BY time_updated DESC LIMIT 200").all() as Array<{
      id: string
    }>
    for (const item of sessions) {
      const state = checkpointState(db, item.id)
      if (!state?.safe) continue
      await saveCheckpoint(sql, {
        sessionID: item.id,
        machine,
        checkpointTime: state.checkpointTime,
        lastMessageID: state.lastMessageID,
      })
    }
  } finally {
    file.close()
  }
}

export async function remoteStatus(sql: Db, db: string) {
  const local = localIDs(db)
  const sessions = (
    await sql<Array<{ id: string; time_updated: number }>>`
    SELECT id, time_updated
    FROM session
    ORDER BY time_updated DESC
    LIMIT 5000
  `
  ).filter((item) => !local.has(item.id))
  if (!sessions.length) return {} as Record<string, { type: "idle" | "busy" }>

  const ids = sessions.map((item) => item.id)
  const marks = await sql<Array<{ session_id: string; checkpoint_time: number }>>`
    SELECT session_id, checkpoint_time
    FROM resumable_checkpoint
    WHERE session_id IN ${sql(ids)}
  `
  const by = new Map(marks.map((item) => [item.session_id, item.checkpoint_time]))
  return Object.fromEntries(
    sessions.map((item) => [
      item.id,
      { type: by.has(item.id) && (by.get(item.id) ?? 0) >= item.time_updated ? "idle" : ("busy" as const) },
    ]),
  ) as Record<string, { type: "idle" | "busy" }>
}

export async function pullSession(sql: Db, db: string, sessionID: string) {
  const meta = open(db, { create: true })
  try {
    const row = await sql<Array<{ id: string }>>`
      SELECT id
      FROM session
      WHERE id = ${sessionID}
      LIMIT 1
    `
    if (!row[0]?.id) return false

    const rid = await remoteRoot(sql, sessionID)
    const root = rid ?? sessionID
    const file = path.join(sessionDir(), `${root}.db`)
    const tmp = path.join(sessionDir(), `${root}.db.tmp`)
    const existed = existsSync(file)

    const sessions = await sql<Array<Record<string, unknown>>>`
      WITH RECURSIVE tree AS (
        SELECT id
        FROM session
        WHERE id = ${root}
        UNION ALL
        SELECT s.id
        FROM session s
        JOIN tree t ON s.parent_id = t.id
      )
      SELECT *
      FROM session
      WHERE id IN (SELECT id FROM tree)
      ORDER BY time_created, id
    `
    const ids = sessions.map((item) => txt(item.id)).filter((item): item is string => !!item)
    if (!ids.length) return false

    const messages = await sql<Array<Record<string, unknown>>>`
      SELECT id, session_id, time_created, time_updated, data_raw
      FROM message
      WHERE session_id IN ${sql(ids)}
      ORDER BY time_created, id
    `
    const parts = await sql<Array<Record<string, unknown>>>`
      SELECT id, message_id, session_id, time_created, time_updated, data_raw
      FROM part
      WHERE session_id IN ${sql(ids)}
      ORDER BY time_created, id
    `
    const todos = await sql<Array<Record<string, unknown>>>`
      SELECT session_id, content, status, priority, position, time_created, time_updated
      FROM todo
      WHERE session_id IN ${sql(ids)}
      ORDER BY session_id, position
    `
    const seqs = await sql<Array<Record<string, unknown>>>`
      SELECT aggregate_id, seq
      FROM event_sequence
      WHERE aggregate_id IN ${sql(ids)}
      ORDER BY aggregate_id
    `
    const evts = await sql<Array<Record<string, unknown>>>`
      SELECT id, aggregate_id, seq, type, data
      FROM event
      WHERE aggregate_id IN ${sql(ids)}
      ORDER BY aggregate_id, seq, id
    `
    const upsert = meta.query(`
      INSERT INTO session (
        id, project_id, workspace_id, origin_machine, parent_id, slug, directory, title, version, share_url,
        summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
        time_created, time_updated, time_compacting, time_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        origin_machine = excluded.origin_machine,
        parent_id = excluded.parent_id,
        slug = excluded.slug,
        directory = excluded.directory,
        title = excluded.title,
        version = excluded.version,
        share_url = excluded.share_url,
        summary_additions = excluded.summary_additions,
        summary_deletions = excluded.summary_deletions,
        summary_files = excluded.summary_files,
        summary_diffs = excluded.summary_diffs,
        revert = excluded.revert,
        permission = excluded.permission,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated,
        time_compacting = excluded.time_compacting,
        time_archived = excluded.time_archived
    `)
    for (const item of sessions) {
      upsert.run(
        txt(item.id) ?? "",
        txt(item.project_id) ?? "",
        txt(item.workspace_id) ?? null,
        txt(item.origin_machine) ?? "unknown",
        txt(item.parent_id) ?? null,
        txt(item.slug) ?? "",
        txt(item.directory) ?? "",
        txt(item.title) ?? "",
        txt(item.version) ?? "",
        txt(item.share_url) ?? null,
        num(item.summary_additions) ?? null,
        num(item.summary_deletions) ?? null,
        num(item.summary_files) ?? null,
        item.summary_diffs_raw ? text(item.summary_diffs_raw) : null,
        item.revert_raw ? text(item.revert_raw) : null,
        item.permission_raw ? text(item.permission_raw) : null,
        num(item.time_created) ?? 0,
        num(item.time_updated) ?? 0,
        num(item.time_compacting) ?? null,
        num(item.time_archived) ?? null,
      )
    }

    const shard = open(existed ? file : tmp, { create: true })
    try {
      ensureShard(shard)
      const msgInsert = shard.query(
        "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      )
      const partInsert = shard.query(
        "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      const todoInsert = shard.query(
        "INSERT OR REPLACE INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      const seqInsert = shard.query("INSERT OR REPLACE INTO event_sequence (aggregate_id, seq) VALUES (?, ?)")
      const evtInsert = shard.query(
        "INSERT OR REPLACE INTO event (id, aggregate_id, seq, type, data, origin) VALUES (?, ?, ?, ?, ?, ?)",
      )
      shard.transaction(() => {
        for (const item of messages) {
          // Strip id and sessionID from data — native shards don't include them in the JSON
          const raw = text(item.data_raw)
          const parsed = parse(raw)
          delete parsed.id
          delete parsed.sessionID
          msgInsert.run(
            txt(item.id) ?? "",
            txt(item.session_id) ?? "",
            num(item.time_created) ?? null,
            num(item.time_updated) ?? null,
            JSON.stringify(parsed),
          )
        }

        for (const item of parts) {
          const raw = text(item.data_raw)
          const data = normalize(parse(raw), Date.now())
          // Strip id, sessionID, messageID — native shards don't include them in the JSON
          delete data.id
          delete data.sessionID
          delete data.messageID
          partInsert.run(
            txt(item.id) ?? "",
            txt(item.message_id) ?? "",
            txt(item.session_id) ?? "",
            num(item.time_created) ?? null,
            num(item.time_updated) ?? null,
            JSON.stringify(data),
          )
        }

        for (const item of todos) {
          todoInsert.run(
            txt(item.session_id) ?? "",
            txt(item.content) ?? "",
            txt(item.status) ?? "",
            txt(item.priority) ?? "",
            num(item.position) ?? 0,
            num(item.time_created) ?? null,
            num(item.time_updated) ?? null,
          )
        }

        for (const item of seqs) {
          seqInsert.run(txt(item.aggregate_id) ?? "", num(item.seq) ?? 0)
        }

        for (const item of evts) {
          const data = typeof item.data === "string" ? item.data : JSON.stringify(item.data ?? {})
          evtInsert.run(
            txt(item.id) ?? "",
            txt(item.aggregate_id) ?? "",
            num(item.seq) ?? 0,
            txt(item.type) ?? "",
            data,
            null,
          )
        }

        const sq = ids.map(() => "?").join(", ")

        const mids = messages.map((item) => txt(item.id) ?? "")
        if (mids.length) {
          const qs = mids.map(() => "?").join(", ")
          shard.query(`DELETE FROM message WHERE id NOT IN (${qs})`).run(...mids)
        } else {
          shard.query(`DELETE FROM message WHERE session_id IN (${sq})`).run(...ids)
        }

        const pids = parts.map((item) => txt(item.id) ?? "")
        if (pids.length) {
          const qs = pids.map(() => "?").join(", ")
          shard.query(`DELETE FROM part WHERE id NOT IN (${qs})`).run(...pids)
        } else {
          shard.query(`DELETE FROM part WHERE session_id IN (${sq})`).run(...ids)
        }

        const keys = todos.map((item) => `${txt(item.session_id) ?? ""}:${num(item.position) ?? 0}`)
        if (keys.length) {
          const qs = keys.map(() => "?").join(", ")
          shard.query(`DELETE FROM todo WHERE session_id || ':' || position NOT IN (${qs})`).run(...keys)
        } else {
          shard.query(`DELETE FROM todo WHERE session_id IN (${sq})`).run(...ids)
        }

        const aids = seqs.map((item) => txt(item.aggregate_id) ?? "")
        if (aids.length) {
          const qs = aids.map(() => "?").join(", ")
          shard.query(`DELETE FROM event_sequence WHERE aggregate_id NOT IN (${qs})`).run(...aids)
        } else {
          shard.query(`DELETE FROM event_sequence WHERE aggregate_id IN (${sq})`).run(...ids)
        }

        const eids = evts.map((item) => txt(item.id) ?? "")
        if (eids.length) {
          const qs = eids.map(() => "?").join(", ")
          shard.query(`DELETE FROM event WHERE id NOT IN (${qs})`).run(...eids)
        } else {
          shard.query(`DELETE FROM event WHERE aggregate_id IN (${sq})`).run(...ids)
        }
      })
    } finally {
      shard.close()
    }
    if (!existed) {
      try {
        renameSync(tmp, file)
      } catch {
        try {
          unlinkSync(tmp)
        } catch {}
      }
    }
    return !existed
  } finally {
    meta.close()
  }
}

export async function saveCheckpoint(
  sql: Db,
  input: {
    sessionID: string
    machine: string
    checkpointTime: number
    lastEventID?: string | null
    lastMessageID?: string | null
  },
) {
  await sql`
    INSERT INTO resumable_checkpoint (session_id, machine, checkpoint_time, last_event_id, last_message_id, updated_at)
    VALUES (${input.sessionID}, ${input.machine}, ${input.checkpointTime}, ${input.lastEventID ?? null}, ${input.lastMessageID ?? null}, NOW())
    ON CONFLICT (session_id) DO UPDATE
    SET machine = ${input.machine},
        checkpoint_time = ${input.checkpointTime},
        last_event_id = ${input.lastEventID ?? null},
        last_message_id = ${input.lastMessageID ?? null},
        updated_at = NOW()
  `
}

export function checkpointState(db: string, sessionID: string) {
  const meta = open(db, { readonly: true })
  try {
    const root = localRoot(meta, sessionID)
    const file = path.join(sessionDir(), `${root}.db`)
    if (!existsSync(file)) return null

    const shard = open(file, { readonly: true })
    try {
      const msg = shard
        .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1")
        .get(sessionID) as { id: string; data: string } | null
      const assistant = shard
        .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 20")
        .all(sessionID) as Array<{ id: string; data: string }>
      const last = assistant
        .map((item) => ({ id: item.id, data: parse(item.data) }))
        .find((item) => item.data.role === "assistant")
      const parts = last
        ? (
            shard.query("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id").all(last.id) as Array<{
              data: string
            }>
          ).map((item) => parse(item.data))
        : []
      return {
        lastMessageID: msg?.id ?? null,
        checkpointTime: Date.now(),
        safe: checkpoint({
          status: { type: "idle" },
          finish: txt(last?.data.finish),
          parts,
        }),
      }
    } finally {
      shard.close()
    }
  } finally {
    meta.close()
  }
}
