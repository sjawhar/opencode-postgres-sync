import type { Db, Tx } from "./schema.js"

type Obj = Record<string, unknown>
type Row = Record<string, string | number | null>

const enc = new TextEncoder()

export type Sync = {
  id: string
  seq: number
  aggregateID: string
  type: string
  data: Obj
  origin?: Obj | null
}

export type Bus = {
  type: string
  properties: Obj
}

type BusRoute =
  | { type: "session.created"; info: Obj }
  | { type: "session.updated"; info: Obj; sessionID: string }
  | { type: "session.deleted"; sessionID: string }
  | { type: "message.updated"; info: Obj }
  | { type: "message.removed"; messageID: string }
  | { type: "message.part.updated"; part: Obj; time: number | undefined }
  | { type: "message.part.removed"; partID: string }

export type Todo = {
  content: string
  status: string
  priority: string
}

type Packed = {
  raw: Uint8Array
  json: Obj | null
}

function txt(v: unknown) {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown) {
  return typeof v === "number" ? v : undefined
}

function obj(v: unknown) {
  return typeof v === "object" && v !== null ? (v as Obj) : undefined
}

function sanitize(text: string) {
  return text.replaceAll("\u0000", "").replaceAll("\\u0000", "")
}

function pack(v: unknown): Packed {
  const text = typeof v === "string" ? v : (JSON.stringify(v ?? null) ?? "null")
  const raw = enc.encode(text)
  const next = sanitize(text)

  try {
    const json = JSON.parse(next)
    if (typeof json === "object" && json !== null) return { raw, json: json as Obj }
    return { raw, json: null }
  } catch {
    return { raw, json: null }
  }
}

function json(sql: Db, value: unknown | null) {
  if (value == null) return sql`NULL`
  return sql`${JSON.stringify(value)}::jsonb`
}

function run(sql: Tx | Db) {
  return sql as unknown as Db
}

export function session(v: Obj) {
  const share = obj(v.share)
  const time = obj(v.time)
  return {
    id: txt(v.id) ?? "",
    project_id: txt(v.projectID) ?? "global",
    workspace_id: txt(v.workspaceID) ?? null,
    parent_id: txt(v.parentID) ?? null,
    slug: txt(v.slug) ?? "",
    directory: txt(v.directory) ?? "",
    title: txt(v.title) ?? "",
    version: txt(v.version) ?? "",
    share_url: txt(share?.url) ?? txt(v.share_url) ?? null,
    summary_additions: num(v.summary_additions) ?? null,
    summary_deletions: num(v.summary_deletions) ?? null,
    summary_files: num(v.summary_files) ?? null,
    time_created: num(time?.created) ?? num(v.time_created) ?? null,
    time_updated: num(time?.updated) ?? num(v.time_updated) ?? null,
    time_compacting: num(v.time_compacting) ?? null,
    time_archived: num(v.time_archived) ?? null,
  }
}

function sessionPatch(v: Obj) {
  const time = obj(v.time)
  const row: Row = {}
  if ("projectID" in v) row.project_id = txt(v.projectID) ?? null
  if ("workspaceID" in v) row.workspace_id = txt(v.workspaceID) ?? null
  if ("parentID" in v) row.parent_id = txt(v.parentID) ?? null
  if ("slug" in v) row.slug = txt(v.slug) ?? null
  if ("directory" in v) row.directory = txt(v.directory) ?? null
  if ("title" in v) row.title = txt(v.title) ?? null
  if ("version" in v) row.version = txt(v.version) ?? null
  if ("share" in v) row.share_url = txt(obj(v.share)?.url) ?? null
  if ("summary_additions" in v) row.summary_additions = num(v.summary_additions) ?? null
  if ("summary_deletions" in v) row.summary_deletions = num(v.summary_deletions) ?? null
  if ("summary_files" in v) row.summary_files = num(v.summary_files) ?? null
  if ("time_compacting" in v) row.time_compacting = num(v.time_compacting) ?? null
  if ("time_archived" in v) row.time_archived = num(v.time_archived) ?? null
  if (time && "created" in time) row.time_created = num(time.created) ?? null
  if (time && "updated" in time) row.time_updated = num(time.updated) ?? null
  return row
}

export function message(v: Obj) {
  const time = obj(v.time)
  const model = obj(v.model)
  return {
    id: txt(v.id) ?? "",
    session_id: txt(v.sessionID) ?? "",
    role: txt(v.role) ?? null,
    agent: txt(v.agent) ?? null,
    model_provider_id: txt(model?.providerID) ?? null,
    model_id: txt(model?.modelID) ?? null,
    time_created: num(time?.created) ?? num(v.time_created) ?? null,
    time_updated: num(time?.updated) ?? num(v.time_updated) ?? null,
  }
}

export function part(v: Obj, time: number | undefined) {
  const tokens = obj(v.tokens)
  return {
    id: txt(v.id) ?? "",
    message_id: txt(v.messageID) ?? "",
    session_id: txt(v.sessionID) ?? "",
    part_type: txt(v.type) ?? null,
    text: txt(v.text) ?? null,
    model: txt(v.model) ?? txt(tokens?.model) ?? null,
    input_tokens: num(tokens?.input) ?? null,
    output_tokens: num(tokens?.output) ?? null,
    cost: num(v.cost) ?? num(tokens?.cost) ?? null,
    time_created: time ?? null,
    time_updated: time ?? null,
  }
}

async function ensureProject(sql: Db, id: string) {
  const sandboxes = pack([])
  await sql`
    INSERT INTO project (
      id,
      worktree,
      vcs,
      name,
      icon_url,
      icon_color,
      sandboxes,
      sandboxes_raw,
      commands,
      commands_raw,
      time_created,
      time_updated,
      time_initialized
    ) VALUES (
      ${id},
      ${""},
      ${null},
      ${null},
      ${null},
      ${null},
      ${json(sql, [])},
      ${sandboxes.raw},
      ${null},
      ${null},
      ${0},
      ${0},
      ${null}
    ) ON CONFLICT (id) DO NOTHING
  `
}

async function ensureSession(sql: Db, id: string, time?: number | null) {
  await ensureProject(sql, "global")
  const data = pack({ id })
  await sql`
    INSERT INTO session (
      id,
      project_id,
      workspace_id,
      parent_id,
      slug,
      directory,
      title,
      version,
      share_url,
      summary_additions,
      summary_deletions,
      summary_files,
      summary_diffs,
      summary_diffs_raw,
      revert,
      revert_raw,
      permission,
      permission_raw,
      time_created,
      time_updated,
      time_compacting,
      time_archived,
      data,
      data_raw
    ) VALUES (
      ${id},
      ${"global"},
      ${null},
      ${null},
      ${id},
      ${""},
      ${id},
      ${"unknown"},
      ${null},
      ${null},
      ${null},
      ${null},
      ${null},
      ${null},
      ${null},
      ${null},
      ${null},
      ${null},
      ${time ?? 0},
      ${time ?? 0},
      ${null},
      ${null},
      ${json(sql, data.json)},
      ${data.raw}
    ) ON CONFLICT (id) DO NOTHING
  `
}

async function replaySession(sql: Db, info: Obj) {
  const row = session(info)
  const meta = pack(info)
  const diffs = pack(info.summary_diffs ?? null)
  const revert = pack(info.revert ?? null)
  const permission = pack(info.permission ?? null)

  await ensureProject(sql, row.project_id)

  await sql`
    INSERT INTO session (
      id,
      project_id,
      workspace_id,
      parent_id,
      slug,
      directory,
      title,
      version,
      share_url,
      summary_additions,
      summary_deletions,
      summary_files,
      summary_diffs,
      summary_diffs_raw,
      revert,
      revert_raw,
      permission,
      permission_raw,
      time_created,
      time_updated,
      time_compacting,
      time_archived,
      data,
      data_raw
    ) VALUES (
      ${row.id},
      ${row.project_id},
      ${row.workspace_id},
      ${row.parent_id},
      ${row.slug},
      ${row.directory},
      ${row.title},
      ${row.version},
      ${row.share_url},
      ${row.summary_additions},
      ${row.summary_deletions},
      ${row.summary_files},
      ${json(sql, diffs.json)},
      ${diffs.raw},
      ${json(sql, revert.json)},
      ${revert.raw},
      ${json(sql, permission.json)},
      ${permission.raw},
      ${row.time_created},
      ${row.time_updated},
      ${row.time_compacting},
      ${row.time_archived},
      ${json(sql, meta.json)},
      ${meta.raw}
    )
    ON CONFLICT (id) DO UPDATE SET
      project_id = EXCLUDED.project_id,
      workspace_id = EXCLUDED.workspace_id,
      parent_id = EXCLUDED.parent_id,
      slug = EXCLUDED.slug,
      directory = EXCLUDED.directory,
      title = EXCLUDED.title,
      version = EXCLUDED.version,
      share_url = EXCLUDED.share_url,
      summary_additions = EXCLUDED.summary_additions,
      summary_deletions = EXCLUDED.summary_deletions,
      summary_files = EXCLUDED.summary_files,
      summary_diffs = EXCLUDED.summary_diffs,
      summary_diffs_raw = EXCLUDED.summary_diffs_raw,
      revert = EXCLUDED.revert,
      revert_raw = EXCLUDED.revert_raw,
      permission = EXCLUDED.permission,
      permission_raw = EXCLUDED.permission_raw,
      time_created = EXCLUDED.time_created,
      time_updated = EXCLUDED.time_updated,
      time_compacting = EXCLUDED.time_compacting,
      time_archived = EXCLUDED.time_archived,
      data = EXCLUDED.data,
      data_raw = EXCLUDED.data_raw
  `
}

async function updateSession(sql: Db, sid: string, info: Obj) {
  if (!info || !sid) return

  const meta = pack(info)
  const row = sessionPatch(info)
  const project_id = txt(info.projectID)
  if (project_id) await ensureProject(sql, project_id)

  await sql`
    UPDATE session
    SET data = COALESCE(${json(sql, meta.json)}, data),
        data_raw = ${meta.raw}
    WHERE id = ${sid}
  `

  if (!Object.keys(row).length) return

  await sql`
    UPDATE session
    SET ${sql(row, Object.keys(row) as string[])}
    WHERE id = ${sid}
  `
}

async function upsertMessage(sql: Db, info: Obj) {
  const row = message(info)
  const meta = pack(info)

  await ensureSession(sql, row.session_id, row.time_created)

  await sql`
    INSERT INTO message (
      id,
      session_id,
      time_created,
      time_updated,
      role,
      agent,
      model_provider_id,
      model_id,
      data,
      data_raw
    ) VALUES (
      ${row.id},
      ${row.session_id},
      ${row.time_created},
      ${row.time_updated},
      ${row.role},
      ${row.agent},
      ${row.model_provider_id},
      ${row.model_id},
      ${json(sql, meta.json)},
      ${meta.raw}
    ) ON CONFLICT (id) DO UPDATE SET
      session_id = EXCLUDED.session_id,
      time_created = EXCLUDED.time_created,
      time_updated = EXCLUDED.time_updated,
      role = EXCLUDED.role,
      agent = EXCLUDED.agent,
      model_provider_id = EXCLUDED.model_provider_id,
      model_id = EXCLUDED.model_id,
      data = EXCLUDED.data,
      data_raw = EXCLUDED.data_raw
  `
}

async function upsertPart(sql: Db, item: Obj, time?: number) {
  const row = part(item, time)
  const meta = pack(item)

  await ensureSession(sql, row.session_id, row.time_created)

  await sql`
    INSERT INTO part (
      id,
      message_id,
      session_id,
      time_created,
      time_updated,
      part_type,
      text,
      model,
      input_tokens,
      output_tokens,
      cost,
      data,
      data_raw
    ) VALUES (
      ${row.id},
      ${row.message_id},
      ${row.session_id},
      ${row.time_created},
      ${row.time_updated},
      ${row.part_type},
      ${row.text},
      ${row.model},
      ${row.input_tokens},
      ${row.output_tokens},
      ${row.cost},
      ${json(sql, meta.json)},
      ${meta.raw}
    ) ON CONFLICT (id) DO UPDATE SET
      message_id = EXCLUDED.message_id,
      session_id = EXCLUDED.session_id,
      time_created = EXCLUDED.time_created,
      time_updated = EXCLUDED.time_updated,
      part_type = EXCLUDED.part_type,
      text = EXCLUDED.text,
      model = EXCLUDED.model,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cost = EXCLUDED.cost,
      data = EXCLUDED.data,
      data_raw = EXCLUDED.data_raw
  `
}

export function routeBus(evt: Bus): BusRoute | undefined {
  if (evt.type === "session.created") {
    const info = obj(evt.properties.info)
    if (info) return { type: "session.created", info }
    return
  }

  if (evt.type === "session.updated") {
    const info = obj(evt.properties.info)
    const sessionID = txt(evt.properties.sessionID)
    if (info && sessionID) return { type: "session.updated", info, sessionID }
    return
  }

  if (evt.type === "session.deleted") {
    const sessionID = txt(evt.properties.sessionID) ?? txt(obj(evt.properties.info)?.id)
    if (sessionID) return { type: "session.deleted", sessionID }
    return
  }

  if (evt.type === "message.updated") {
    const info = obj(evt.properties.info)
    if (info) return { type: "message.updated", info }
    return
  }

  if (evt.type === "message.removed") {
    const messageID = txt(evt.properties.messageID)
    if (messageID) return { type: "message.removed", messageID }
    return
  }

  if (evt.type === "message.part.updated") {
    const item = obj(evt.properties.part)
    if (item) return { type: "message.part.updated", part: item, time: num(evt.properties.time) }
    return
  }

  if (evt.type === "message.part.removed") {
    const partID = txt(evt.properties.partID)
    if (partID) return { type: "message.part.removed", partID }
    return
  }
}

export async function replayBus(sql: Db, evt: Bus) {
  return sql.begin(async (tx) => {
    const db = run(tx)
    const next = routeBus(evt)
    if (!next) return true

    if (next.type === "session.created") {
      await replaySession(db, next.info)
      return true
    }

    if (next.type === "session.updated") {
      await replaySession(db, next.info)
      return true
    }

    if (next.type === "session.deleted") {
      await db`DELETE FROM session WHERE id = ${next.sessionID}`
      return true
    }

    if (next.type === "message.updated") {
      await upsertMessage(db, next.info)
      return true
    }

    if (next.type === "message.removed") {
      await db`DELETE FROM message WHERE id = ${next.messageID}`
      return true
    }

    if (next.type === "message.part.updated") {
      await upsertPart(db, next.part, next.time)
      return true
    }

    if (next.type === "message.part.removed") {
      await db`DELETE FROM part WHERE id = ${next.partID}`
      return true
    }

    return true
  })
}

export async function replay(sql: Db, evt: Sync) {
  return sql.begin(async (tx) => {
    const db = run(tx)
    const data = pack(evt.data)
    const seen = await db`
      INSERT INTO event (id, aggregate_id, seq, type, data, data_raw)
      VALUES (
        ${evt.id},
        ${evt.aggregateID},
        ${evt.seq},
        ${evt.type},
        ${json(db, data.json)},
        ${data.raw},
        ${data.raw}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `
    if (!seen.length) return false

    if (evt.type === "session.created.1") {
      const info = obj(evt.data.info)
      if (info) await replaySession(db, info)
      return true
    }
    if (evt.type === "session.updated.1") {
      const info = obj(evt.data.info)
      const sid = txt(evt.data.sessionID)
      if (info && sid) await updateSession(db, sid, info)
      return true
    }
    if (evt.type === "session.deleted.1") {
      const sid = txt(evt.data.sessionID) ?? txt(obj(evt.data.info)?.id)
      if (sid) await db`DELETE FROM session WHERE id = ${sid}`
      return true
    }
    if (evt.type === "message.updated.1") {
      const info = obj(evt.data.info)
      if (info) await upsertMessage(db, info)
      return true
    }
    if (evt.type === "message.removed.1") {
      const id = txt(evt.data.messageID)
      if (id) await db`DELETE FROM message WHERE id = ${id}`
      return true
    }
    if (evt.type === "message.part.updated.1") {
      const item = obj(evt.data.part)
      if (item) await upsertPart(db, item, num(evt.data.time))
      return true
    }
    if (evt.type === "message.part.removed.1") {
      const id = txt(evt.data.partID)
      if (id) await db`DELETE FROM part WHERE id = ${id}`
      return true
    }
    return true
  })
}

export async function syncTodos(sql: Db, sid: string, todos: Todo[], time?: number) {
  await ensureSession(sql, sid, time)
  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`DELETE FROM todo WHERE session_id = ${sid}`
    if (!todos.length) return

    const now = time ?? Date.now()
    const rows = todos.map((todo, position) => ({
      session_id: sid,
      position,
      content: todo.content,
      status: todo.status,
      priority: todo.priority,
      time_created: now,
      time_updated: now,
    }))
    await db`
      INSERT INTO todo ${db(rows, [
        "session_id",
        "position",
        "content",
        "status",
        "priority",
        "time_created",
        "time_updated",
      ])}
      ON CONFLICT (session_id, position) DO UPDATE SET
        content = EXCLUDED.content,
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        time_created = EXCLUDED.time_created,
        time_updated = EXCLUDED.time_updated
    `
  })
}
