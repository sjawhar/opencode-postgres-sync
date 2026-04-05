import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { Database as SQLite } from "bun:sqlite"
import type { Db, Tx } from "./schema.js"
import { syncTodos } from "./projectors.js"
import { fresh, save } from "./replication.js"

type Obj = Record<string, unknown>

type EventRow = {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: string | Record<string, unknown>
  origin: string | Record<string, unknown> | null
}

type TodoRow = {
  session_id: string
  position: number
  content: string
  status: string
  priority: string
  time_updated: number | null
}

const enc = new TextEncoder()

import { warn, info } from "./log.js"

function base() {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME
  return path.join(process.env.OPENCODE_TEST_HOME || process.env.HOME || "", ".local", "share")
}

function data() {
  return path.join(base(), "opencode")
}

function sessions() {
  return path.join(data(), "sessions")
}

function txt(v: unknown) {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown) {
  return typeof v === "number" ? v : undefined
}

function bool(v: unknown) {
  return typeof v === "boolean" ? v : undefined
}

function obj(v: unknown) {
  return typeof v === "object" && v !== null ? (v as Obj) : undefined
}

function sanitize(text: string) {
  return text.replaceAll("\u0000", "").replaceAll("\\u0000", "")
}

function pack(v: unknown) {
  const text = typeof v === "string" ? v : JSON.stringify(v)
  const raw = enc.encode(text)
  const next = sanitize(text)

  try {
    const json = JSON.parse(next)
    if (typeof json === "object" && json !== null) return { raw, json: json as Obj }
    return { raw, json: null as Obj | null }
  } catch {
    return { raw, json: null as Obj | null }
  }
}

function run(sql: Tx | Db) {
  return sql as unknown as Db
}

function partMeta(v: Obj) {
  const tokens = obj(v.tokens)
  return {
    part_type: txt(v.type) ?? null,
    text: txt(v.text) ?? null,
    model: txt(v.model) ?? txt(tokens?.model) ?? null,
    input_tokens: num(tokens?.input) ?? null,
    output_tokens: num(tokens?.output) ?? null,
    cost: num(v.cost) ?? num(tokens?.cost) ?? null,
  }
}

async function copyProjects(sql: Db, db: SQLite) {
  const rows = db
    .query(
      "SELECT id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands FROM project ORDER BY id",
    )
    .all() as Array<Record<string, unknown>>
  if (!rows.length) return

  const values = rows.map((row) => {
    const sandboxes = pack(row.sandboxes ?? [])
    const commands = pack(row.commands ?? null)
    return {
      id: txt(row.id) ?? "",
      worktree: txt(row.worktree) ?? "",
      vcs: txt(row.vcs) ?? null,
      name: txt(row.name) ?? null,
      icon_url: txt(row.icon_url) ?? null,
      icon_color: txt(row.icon_color) ?? null,
      sandboxes: sandboxes.json,
      sandboxes_raw: sandboxes.raw,
      commands: commands.json,
      commands_raw: row.commands == null ? null : commands.raw,
      time_created: num(row.time_created) ?? 0,
      time_updated: num(row.time_updated) ?? 0,
      time_initialized: num(row.time_initialized) ?? null,
    }
  })

  for (const value of values) {
    try {
      await sql.begin(async (tx) => {
        const db = run(tx)
        await db`INSERT INTO project ${db(value, ["id", "worktree", "vcs", "name", "icon_url", "icon_color", "sandboxes", "sandboxes_raw", "commands", "commands_raw", "time_created", "time_updated", "time_initialized"])} ON CONFLICT (id) DO NOTHING`
      })
    } catch (err) {
      warn(`project ${value.id} insert failed`, err)
    }
  }
}

async function copyWorkspaces(sql: Db, db: SQLite) {
  const rows = db
    .query("SELECT id, branch, project_id, type, name, directory, extra FROM workspace ORDER BY id")
    .all() as Array<Record<string, unknown>>
  if (!rows.length) return

  const values = rows.map((row) => {
    const extra = pack(row.extra ?? null)
    return {
      id: txt(row.id) ?? "",
      branch: txt(row.branch) ?? null,
      project_id: txt(row.project_id) ?? "",
      type: txt(row.type) ?? "",
      name: txt(row.name) ?? null,
      directory: txt(row.directory) ?? null,
      extra: extra.json,
      extra_raw: row.extra == null ? null : extra.raw,
    }
  })

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO workspace ${db(values, ["id", "branch", "project_id", "type", "name", "directory", "extra", "extra_raw"])} ON CONFLICT (id) DO NOTHING`
  })
}

async function copyAccounts(sql: Db, db: SQLite) {
  const accounts = db
    .query(
      "SELECT id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated FROM account ORDER BY id",
    )
    .all() as Array<Record<string, unknown>>
  if (accounts.length) {
    await sql.begin(async (tx) => {
      const db = run(tx)
      await db`INSERT INTO account ${db(
        accounts.map((row) => ({
          id: txt(row.id) ?? "",
          email: txt(row.email) ?? "",
          url: txt(row.url) ?? "",
          access_token: txt(row.access_token) ?? "",
          refresh_token: txt(row.refresh_token) ?? "",
          token_expiry: num(row.token_expiry) ?? null,
          time_created: num(row.time_created) ?? 0,
          time_updated: num(row.time_updated) ?? 0,
        })),
        ["id", "email", "url", "access_token", "refresh_token", "token_expiry", "time_created", "time_updated"],
      )} ON CONFLICT (id) DO NOTHING`
    })
  }

  const state = db.query("SELECT id, active_account_id, active_org_id FROM account_state ORDER BY id").all() as Array<
    Record<string, unknown>
  >
  if (state.length) {
    await sql.begin(async (tx) => {
      const db = run(tx)
      await db`INSERT INTO account_state ${db(
        state.map((row) => ({
          id: num(row.id) ?? 0,
          active_account_id: txt(row.active_account_id) ?? null,
          active_org_id: txt(row.active_org_id) ?? null,
        })),
        ["id", "active_account_id", "active_org_id"],
      )} ON CONFLICT (id) DO NOTHING`
    })
  }

  const legacy = db
    .query(
      "SELECT email, url, access_token, refresh_token, token_expiry, active, time_created, time_updated FROM control_account ORDER BY email, url",
    )
    .all() as Array<Record<string, unknown>>
  if (!legacy.length) return

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO control_account ${db(
      legacy.map((row) => ({
        email: txt(row.email) ?? "",
        url: txt(row.url) ?? "",
        access_token: txt(row.access_token) ?? "",
        refresh_token: txt(row.refresh_token) ?? "",
        token_expiry: num(row.token_expiry) ?? null,
        active: bool(row.active) ?? num(row.active) === 1,
        time_created: num(row.time_created) ?? 0,
        time_updated: num(row.time_updated) ?? 0,
      })),
      ["email", "url", "access_token", "refresh_token", "token_expiry", "active", "time_created", "time_updated"],
    )} ON CONFLICT (email, url) DO NOTHING`
  })
}

async function copySessions(sql: Db, db: SQLite, maxDays: number) {
  const cut = maxDays > 0 ? Date.now() - maxDays * 86400000 : undefined
  const rows = (
    cut == null
      ? db
          .query(
            "SELECT id, project_id, workspace_id, parent_id, root_session_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived FROM session ORDER BY time_created, id",
          )
          .all()
      : db
          .query(
            "SELECT id, project_id, workspace_id, parent_id, root_session_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived FROM session WHERE time_created >= ? ORDER BY time_created, id",
          )
          .all(cut)
  ) as Array<Record<string, unknown>>
  if (!rows.length) return new Set<string>()

  const map = new Map(rows.map((row) => [txt(row.id) ?? "", row]))
  const memo = new Map<string, string>()
  const resolve = (id: string): string => {
    const hit = memo.get(id)
    if (hit) return hit
    const row = map.get(id)
    if (!row) return id
    const root_session_id = txt(row.root_session_id)
    if (root_session_id) {
      memo.set(id, root_session_id)
      return root_session_id
    }
    const parent_id = txt(row.parent_id)
    const next = parent_id ? resolve(parent_id) : id
    memo.set(id, next)
    return next
  }

  const values = rows.map((row) => {
    const diffs = pack(row.summary_diffs ?? null)
    const revert = pack(row.revert ?? null)
    const permission = pack(row.permission ?? null)
    const data = pack(row)
    const id = txt(row.id) ?? ""
    return {
      id,
      project_id: txt(row.project_id) ?? "global",
      workspace_id: txt(row.workspace_id) ?? null,
      parent_id: txt(row.parent_id) ?? null,
      root_session_id: resolve(id),
      slug: txt(row.slug) ?? "",
      directory: txt(row.directory) ?? "",
      title: txt(row.title) ?? "",
      version: txt(row.version) ?? "",
      share_url: txt(row.share_url) ?? null,
      summary_additions: num(row.summary_additions) ?? null,
      summary_deletions: num(row.summary_deletions) ?? null,
      summary_files: num(row.summary_files) ?? null,
      summary_diffs: diffs.json,
      summary_diffs_raw: row.summary_diffs == null ? null : diffs.raw,
      revert: revert.json,
      revert_raw: row.revert == null ? null : revert.raw,
      permission: permission.json,
      permission_raw: row.permission == null ? null : permission.raw,
      time_created: num(row.time_created) ?? 0,
      time_updated: num(row.time_updated) ?? 0,
      time_compacting: num(row.time_compacting) ?? null,
      time_archived: num(row.time_archived) ?? null,
      data: data.json,
      data_raw: data.raw,
      origin_machine: null,
    }
  })

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO session ${db(values, ["id", "project_id", "workspace_id", "parent_id", "root_session_id", "slug", "directory", "title", "version", "share_url", "summary_additions", "summary_deletions", "summary_files", "summary_diffs", "summary_diffs_raw", "revert", "revert_raw", "permission", "permission_raw", "time_created", "time_updated", "time_compacting", "time_archived", "data", "data_raw", "origin_machine"])} ON CONFLICT (id) DO NOTHING`
  })

  return new Set(values.map((row) => row.id))
}

function keep<T extends Record<string, unknown>>(rows: T[], ids?: Set<string>, key = "session_id") {
  if (!ids) return rows
  if (!ids.size) return []
  return rows.filter((row) => ids.has(txt(row[key]) ?? ""))
}

async function copySessionShares(sql: Db, db: SQLite, ids?: Set<string>) {
  const rows = db
    .query("SELECT session_id, id, secret, url, time_created, time_updated FROM session_share ORDER BY session_id")
    .all() as Array<Record<string, unknown>>
  const list = keep(rows, ids)
  if (!list.length) return

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO session_share ${db(
      list.map((row) => ({
        session_id: txt(row.session_id) ?? "",
        id: txt(row.id) ?? "",
        secret: txt(row.secret) ?? "",
        url: txt(row.url) ?? "",
        time_created: num(row.time_created) ?? 0,
        time_updated: num(row.time_updated) ?? 0,
      })),
      ["session_id", "id", "secret", "url", "time_created", "time_updated"],
    )} ON CONFLICT (session_id) DO NOTHING`
  })
}

async function copyPermissions(sql: Db, db: SQLite) {
  const rows = db
    .query("SELECT project_id, time_created, time_updated, data FROM permission ORDER BY project_id")
    .all() as Array<Record<string, unknown>>
  if (!rows.length) return

  const values = rows.map((row) => {
    const data = pack(row.data)
    return {
      project_id: txt(row.project_id) ?? "",
      time_created: num(row.time_created) ?? 0,
      time_updated: num(row.time_updated) ?? 0,
      data: data.json,
      data_raw: data.raw,
    }
  })

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO permission ${db(values, ["project_id", "time_created", "time_updated", "data", "data_raw"])} ON CONFLICT (project_id) DO NOTHING`
  })
}

async function copyMessages(sql: Db, db: SQLite, ids?: Set<string>) {
  const rows = db
    .query("SELECT id, session_id, time_created, time_updated, data FROM message ORDER BY rowid ASC")
    .all() as Array<Record<string, unknown>>
  const list = keep(rows, ids)
  if (!list.length) return

  const values = list.map((row) => {
    const data = pack(row.data)
    const info = data.json ?? {}
    return {
      id: txt(row.id) ?? "",
      session_id: txt(row.session_id) ?? "",
      time_created: num(row.time_created) ?? null,
      time_updated: num(row.time_updated) ?? null,
      role: txt(obj(info)?.role) ?? null,
      agent: txt(obj(info)?.agent) ?? null,
      model_provider_id: txt(obj(obj(info)?.model)?.providerID) ?? null,
      model_id: txt(obj(obj(info)?.model)?.modelID) ?? null,
      data: data.json,
      data_raw: data.raw,
    }
  })

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO message ${db(values, ["id", "session_id", "time_created", "time_updated", "role", "agent", "model_provider_id", "model_id", "data", "data_raw"])} ON CONFLICT (id) DO NOTHING`
  })
}

async function copyParts(sql: Db, db: SQLite, ids?: Set<string>) {
  const rows = db
    .query("SELECT id, message_id, session_id, time_created, time_updated, data FROM part ORDER BY rowid ASC")
    .all() as Array<Record<string, unknown>>
  const list = keep(rows, ids)
  if (!list.length) return

  const values = list.map((row) => {
    const data = pack(row.data)
    const meta = partMeta(data.json ?? {})
    return {
      id: txt(row.id) ?? "",
      message_id: txt(row.message_id) ?? "",
      session_id: txt(row.session_id) ?? "",
      time_created: num(row.time_created) ?? null,
      time_updated: num(row.time_updated) ?? null,
      part_type: meta.part_type,
      text: meta.text,
      model: meta.model,
      input_tokens: meta.input_tokens,
      output_tokens: meta.output_tokens,
      cost: meta.cost,
      data: data.json,
      data_raw: data.raw,
    }
  })

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO part ${db(values, ["id", "message_id", "session_id", "time_created", "time_updated", "part_type", "text", "model", "input_tokens", "output_tokens", "cost", "data", "data_raw"])} ON CONFLICT (id) DO NOTHING`
  })
}

async function copyTodos(sql: Db, db: SQLite, ids?: Set<string>) {
  const rows = db
    .query<
      TodoRow,
      []
    >("SELECT session_id, position, content, status, priority, time_updated FROM todo ORDER BY session_id ASC, position ASC")
    .all()
  const list = keep(rows, ids)
  if (!list.length) return

  const map = new Map<
    string,
    {
      list: Array<{ content: string; status: string; priority: string }>
      time?: number
    }
  >()
  for (const row of list) {
    const item = map.get(row.session_id) ?? {
      list: [],
      time: row.time_updated ?? undefined,
    }
    item.list.push({
      content: row.content,
      status: row.status,
      priority: row.priority,
    })
    item.time = row.time_updated ?? item.time
    map.set(row.session_id, item)
  }

  for (const [sid, item] of map.entries()) {
    await syncTodos(sql, sid, item.list, item.time)
  }
}

async function copyEventSequence(sql: Db, db: SQLite, ids?: Set<string>) {
  const rows = db.query("SELECT aggregate_id, seq FROM event_sequence ORDER BY aggregate_id").all() as Array<
    Record<string, unknown>
  >
  const list = keep(rows, ids, "aggregate_id")
  if (!list.length) return

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO event_sequence ${db(
      list.map((row) => ({
        aggregate_id: txt(row.aggregate_id) ?? "",
        seq: num(row.seq) ?? 0,
      })),
      ["aggregate_id", "seq"],
    )} ON CONFLICT (aggregate_id) DO NOTHING`
  })
}

async function copyEvents(sql: Db, db: SQLite, ids?: Set<string>) {
  const rows = db
    .query<EventRow, []>("SELECT id, aggregate_id, seq, type, data, origin FROM event ORDER BY rowid ASC")
    .all()
  const list = keep(rows, ids, "aggregate_id") as EventRow[]
  if (!list.length) return [] as EventRow[]

  const values = list.map((row) => {
    const data = pack(row.data)
    const origin = pack(row.origin ?? null)
    return {
      id: row.id,
      aggregate_id: row.aggregate_id,
      seq: row.seq,
      type: row.type,
      data: data.json,
      data_raw: data.raw,
      origin: origin.json,
      origin_raw: row.origin == null ? null : origin.raw,
    }
  })

  await sql.begin(async (tx) => {
    const db = run(tx)
    await db`INSERT INTO event ${db(values, ["id", "aggregate_id", "seq", "type", "data", "data_raw", "origin", "origin_raw"])} ON CONFLICT (id) DO NOTHING`
  })

  return list
}

async function checkpoint(sql: Db, sid: string, rows: EventRow[], machine: string) {
  const last = rows.at(-1)
  if (!last) return
  const info = typeof last.origin === "string" ? JSON.parse(sanitize(last.origin)) : last.origin
  const mid = txt(obj(info)?.machine) ?? machine
  await save(sql, mid, sid, last.id, last.seq)
}

export async function backfill(sql: Db, machine: string, file: string, maxDays: number) {
  if (maxDays === 0) return

  const initial = await fresh(sql, machine)
  let ids: Set<string> | undefined

  if (initial) {
    if (file && existsSync(file)) {
      const db = new SQLite(file, { readonly: true })
      try {
        await copyProjects(sql, db)
        await copyWorkspaces(sql, db)
        await copyAccounts(sql, db)
        ids = await copySessions(sql, db, maxDays)
        await copySessionShares(sql, db, ids)
        await copyPermissions(sql, db)
        await copyMessages(sql, db, ids)
        await copyParts(sql, db, ids)
        await copyTodos(sql, db, ids)
        await copyEventSequence(sql, db, ids)
        await copyEvents(sql, db, ids)
      } finally {
        db.close()
      }
    }
  }

  // Always sync per-tree shard DBs (catches events missed while the plugin was not running)
  const root = sessions()
  if (!existsSync(root)) return

  const files = readdirSync(root)
    .filter((item) => item.endsWith(".db"))
    .sort()

  for (const file of files) {
    const sid = file.slice(0, -3)
    if (ids && !ids.has(sid)) continue
    const db = new SQLite(path.join(root, file), { readonly: true })
    try {
      await copyMessages(sql, db, ids)
      await copyParts(sql, db, ids)
      await copyTodos(sql, db, ids)
      await copyEventSequence(sql, db, ids)
      const rows = await copyEvents(sql, db, ids)
      await checkpoint(sql, sid, rows, machine)
      if (rows.length) info(`Synced session ${sid} (${rows.length} events)`)
    } catch (err) {
      warn(`backfill failed for ${sid}`, err)
      throw err
    } finally {
      db.close()
    }
  }
}
