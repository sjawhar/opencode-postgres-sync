import type { Db } from "./schema.js"
import type { Sync } from "./projectors.js"

type Obj = Record<string, unknown>

function txt(v: unknown) {
  return typeof v === "string" ? v : undefined
}

function obj(v: unknown) {
  return typeof v === "object" && v !== null ? (v as Obj) : undefined
}

async function lookup(sql: Db, sid: string) {
  if (!sid) return undefined
  const rows = await sql<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id, parent_id FROM session WHERE id = ${sid}
      UNION ALL
      SELECT session.id, session.parent_id
      FROM session
      JOIN tree ON session.id = tree.parent_id
    )
    SELECT id FROM tree WHERE parent_id IS NULL LIMIT 1
  `
  return rows[0]?.id
}

export async function latest(sql: Db, machine: string) {
  const rows = await sql<{ last_event_id: string | null; last_seq: number | null }[]>`
    SELECT last_event_id, last_seq
    FROM replication_state
    WHERE source_machine = ${machine}
    ORDER BY updated_at DESC
    LIMIT 1
  `
  return rows[0]
}

export async function fresh(sql: Db, machine: string) {
  const rows = await sql`SELECT 1 FROM replication_state WHERE source_machine = ${machine} LIMIT 1`
  return rows.length === 0
}

export async function save(sql: Db, machine: string, root: string, id: string, seq: number) {
  await sql`
    INSERT INTO replication_state (source_machine, source_session_root, last_event_id, last_seq, updated_at)
    VALUES (${machine}, ${root}, ${id}, ${seq}, NOW())
    ON CONFLICT (source_machine, source_session_root) DO UPDATE
    SET last_event_id = ${id}, last_seq = ${seq}, updated_at = NOW()
  `
}

export async function source(sql: Db, evt: Sync, machine: string) {
  const data = obj(evt.data) ?? {}
  const info = obj(data.info)
  const mid = txt(obj(evt.origin)?.machine) ?? machine
  const agg = txt(evt.aggregateID) ?? txt(data.sessionID) ?? txt(info?.id) ?? "global"

  if (evt.type === "session.created.1") {
    const sid = txt(data.sessionID) ?? txt(info?.id) ?? agg
    const pid = txt(info?.parentID)
    if (!pid) return { machine: mid, root: sid }
    return { machine: mid, root: (await lookup(sql, pid)) ?? pid }
  }

  if (evt.type === "session.updated.1") {
    const sid = txt(data.sessionID) ?? agg
    if ("parentID" in (info ?? {})) {
      const pid = txt(info?.parentID)
      if (!pid) return { machine: mid, root: sid }
      return { machine: mid, root: (await lookup(sql, pid)) ?? pid }
    }
    return { machine: mid, root: (await lookup(sql, sid)) ?? sid }
  }

  if (evt.type === "session.deleted.1") {
    const sid = txt(data.sessionID) ?? txt(info?.id) ?? agg
    const pid = txt(info?.parentID)
    if (!pid) return { machine: mid, root: sid }
    return { machine: mid, root: (await lookup(sql, pid)) ?? pid }
  }

  return { machine: mid, root: (await lookup(sql, agg)) ?? agg }
}
