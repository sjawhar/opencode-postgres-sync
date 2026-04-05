import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database as SQLite } from "bun:sqlite"

const hit = {
  todo: [] as Array<{ sid: string; list: Array<{ content: string; status: string; priority: string }>; time?: number }>,
  save: [] as Array<{ machine: string; root: string; id: string; seq: number }>,
  warn: [] as unknown[][],
}

function txt(v: unknown) {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown) {
  return typeof v === "number" ? v : undefined
}

function obj(v: unknown) {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined
}

async function load() {
  mock.module("./projectors.js", () => ({
    message(v: Record<string, unknown>) {
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
    },
    part(v: Record<string, unknown>, time?: number) {
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
    },
    routeBus(evt: { type: string; properties: Record<string, unknown> }) {
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
        const part = obj(evt.properties.part)
        if (part) return { type: "message.part.updated", part, time: num(evt.properties.time) }
        return
      }

      if (evt.type === "message.part.removed") {
        const partID = txt(evt.properties.partID)
        if (partID) return { type: "message.part.removed", partID }
        return
      }
    },
    session(v: Record<string, unknown>) {
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
    },
    async syncTodos(
      _: unknown,
      sid: string,
      list: Array<{ content: string; status: string; priority: string }>,
      time?: number,
    ) {
      hit.todo.push({ sid, list, time })
    },
  }))

  mock.module("./replication.js", () => ({
    async fresh() {
      return true
    },
    async save(_: unknown, machine: string, root: string, id: string, seq: number) {
      hit.save.push({ machine, root, id, seq })
    },
  }))

  mock.module("./log.js", () => ({
    info() {},
    warn(...args: unknown[]) {
      hit.warn.push(args)
    },
  }))

  const mod = await import(`./backfill.js?${Date.now()}-${Math.random()}`)
  mock.restore()
  return mod
}

function file() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-postgres-sync-"))
  return { dir, file: path.join(dir, "main.db") }
}

function seed(file: string, now: number) {
  const db = new SQLite(file)
  db.run(`
    CREATE TABLE project (id TEXT, worktree TEXT, vcs TEXT, name TEXT, icon_url TEXT, icon_color TEXT, time_created INTEGER, time_updated INTEGER, time_initialized INTEGER, sandboxes TEXT, commands TEXT);
    CREATE TABLE workspace (id TEXT, branch TEXT, project_id TEXT, type TEXT, name TEXT, directory TEXT, extra TEXT);
    CREATE TABLE account (id TEXT, email TEXT, url TEXT, access_token TEXT, refresh_token TEXT, token_expiry INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE account_state (id INTEGER, active_account_id TEXT, active_org_id TEXT);
    CREATE TABLE control_account (email TEXT, url TEXT, access_token TEXT, refresh_token TEXT, token_expiry INTEGER, active INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session (id TEXT, project_id TEXT, workspace_id TEXT, parent_id TEXT, root_session_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE session_share (session_id TEXT, id TEXT, secret TEXT, url TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE permission (project_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE todo (session_id TEXT, position INTEGER, content TEXT, status TEXT, priority TEXT, time_updated INTEGER);
    CREATE TABLE event_sequence (aggregate_id TEXT, seq INTEGER);
    CREATE TABLE event (id TEXT, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT, origin TEXT);
  `)

  db.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "p_bad",
    "/bad",
    null,
    "bad",
    null,
    null,
    now,
    now,
    null,
    "[]",
    null,
  )
  db.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "p_good",
    "/good",
    null,
    "good",
    null,
    null,
    now,
    now,
    null,
    "[]",
    null,
  )

  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ses_old",
    "p_good",
    null,
    null,
    null,
    "old",
    "/tmp",
    "old",
    "1",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    now - 10 * 86400000,
    now - 10 * 86400000,
    null,
    null,
  )
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ses_new",
    "p_good",
    null,
    null,
    null,
    "new",
    "/tmp",
    "new",
    "1",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    now - 2 * 86400000,
    now - 2 * 86400000,
    null,
    null,
  )

  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_old",
    "ses_old",
    now - 10 * 86400000,
    now - 10 * 86400000,
    '{"role":"user"}',
  )
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_new",
    "ses_new",
    now - 2 * 86400000,
    now - 2 * 86400000,
    '{"role":"assistant"}',
  )
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_old",
    "msg_old",
    "ses_old",
    now - 10 * 86400000,
    now - 10 * 86400000,
    '{"type":"text","text":"old"}',
  )
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_new",
    "msg_new",
    "ses_new",
    now - 2 * 86400000,
    now - 2 * 86400000,
    '{"type":"text","text":"new"}',
  )
  db.prepare("INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?)").run("ses_old", 0, "old", "open", "low", now - 10 * 86400000)
  db.prepare("INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?)").run("ses_new", 0, "new", "done", "high", now - 2 * 86400000)
  db.prepare("INSERT INTO event_sequence VALUES (?, ?)").run("ses_old", 1)
  db.prepare("INSERT INTO event_sequence VALUES (?, ?)").run("ses_new", 2)
  db.prepare("INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)").run(
    "evt_old",
    "ses_old",
    1,
    "message.updated.1",
    "{}",
    '{"machine":"m2"}',
  )
  db.prepare("INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)").run(
    "evt_new",
    "ses_new",
    2,
    "message.updated.1",
    "{}",
    '{"machine":"m3"}',
  )
  db.close()
}

function sql(opts?: { fail?: string }) {
  const out = new Map<string, Array<Record<string, unknown>>>()
  const fn = ((first: unknown, ...rest: unknown[]) => {
    if (!Array.isArray(first) || typeof first[0] !== "string") return { kind: "values", rows: first, cols: rest[0] }

    const text = first.join("?").replace(/\s+/g, " ").trim()
    if (text === "NULL") return null
    if (text === "?::jsonb") return rest[0]

    const m = text.match(/^INSERT INTO ([a-z_]+)/i)
    if (!m) return []

    const table = m[1] ?? ""
    const data = rest.find((item) => typeof item === "object" && item !== null && "kind" in item) as
      | { kind: string; rows: Record<string, unknown> | Array<Record<string, unknown>> }
      | undefined
    const rows = Array.isArray(data?.rows) ? data.rows : data?.rows ? [data.rows] : []
    if (table === "project" && opts?.fail && rows[0]?.id === opts.fail) throw new Error("boom")
    out.set(table, [...(out.get(table) ?? []), ...rows])
    return Promise.resolve([])
  }) as unknown as {
    (first: unknown, ...rest: unknown[]): Promise<unknown>
    begin<T>(cb: (tx: typeof fn) => Promise<T>): Promise<T>
    out: Map<string, Array<Record<string, unknown>>>
  }

  fn.begin = async (cb) => cb(fn)
  fn.out = out
  return fn
}

let dir = ""

beforeEach(() => {
  hit.todo.length = 0
  hit.save.length = 0
  hit.warn.length = 0
  dir = mkdtempSync(path.join(os.tmpdir(), "opencode-home-"))
  mkdirSync(path.join(dir, ".local", "share", "opencode"), { recursive: true })
  process.env.OPENCODE_TEST_HOME = dir
  delete process.env.XDG_DATA_HOME
})

afterEach(() => {
  delete process.env.OPENCODE_TEST_HOME
  delete process.env.XDG_DATA_HOME
  if (dir) rmSync(dir, { force: true, recursive: true })
})

describe("backfill", () => {
  test("scopes session data by maxDays", async () => {
    const now = Date.now()
    const tmp = file()
    seed(tmp.file, now)
    const db = sql()
    const mod = await load()

    await mod.backfill(db as never, "m1", tmp.file, 7)

    expect(db.out.get("session")?.map((row) => row.id)).toEqual(["ses_new"])
    expect(db.out.get("message")?.map((row) => row.id)).toEqual(["msg_new"])
    expect(db.out.get("part")?.map((row) => row.id)).toEqual(["part_new"])
    expect(db.out.get("event_sequence")?.map((row) => row.aggregate_id)).toEqual(["ses_new"])
    expect(db.out.get("event")?.map((row) => row.id)).toEqual(["evt_new"])
    expect(hit.todo.map((row) => row.sid)).toEqual(["ses_new"])
    expect(hit.save).toEqual([])

    rmSync(tmp.dir, { force: true, recursive: true })
  })

  test("continues project inserts after one row fails", async () => {
    const now = Date.now()
    const tmp = file()
    seed(tmp.file, now)
    const db = sql({ fail: "p_bad" })
    const mod = await load()

    await mod.backfill(db as never, "m1", tmp.file, -1)

    expect(db.out.get("project")?.map((row) => row.id)).toEqual(["p_good"])
    expect(String(hit.warn[0]?.[0])).toContain("project p_bad insert failed")

    rmSync(tmp.dir, { force: true, recursive: true })
  })
})
