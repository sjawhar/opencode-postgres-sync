import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database as SQLite } from "bun:sqlite"
import { pullSession, remoteStatus, syncMetadata } from "./local.js"

function norm(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function root(dir: string) {
  return path.join(dir, ".local", "share", "opencode")
}

function meta(dir: string) {
  return path.join(root(dir), "opencode-local.db")
}

function shard(dir: string, id: string) {
  return path.join(root(dir), "sessions", `${id}.db`)
}

function prep(file: string) {
  const db = new SQLite(file, { create: true })
  db.query(
    `
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    )
  `,
  ).run()
  return db
}

function sql(map: Record<string, Array<Record<string, unknown>>>) {
  const fn = ((first: unknown, ...rest: unknown[]) => {
    if (!Array.isArray(first) || typeof first[0] !== "string") return { kind: "values", rows: first, cols: rest[0] }
    const text = norm(first.join("?"))
    if (text === "NULL") return null
    if (text === "?::jsonb") return rest[0]
    for (const [key, rows] of Object.entries(map)) {
      if (text.includes(key)) return Promise.resolve(rows)
    }
    return Promise.resolve([])
  }) as unknown as {
    (first: unknown, ...rest: unknown[]): Promise<Array<Record<string, unknown>>>
  }
  return fn
}

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "opencode-postgres-sync-local-"))
  mkdirSync(root(dir), { recursive: true })
  process.env.OPENCODE_TEST_HOME = dir
  delete process.env.XDG_DATA_HOME
})

afterEach(() => {
  delete process.env.OPENCODE_TEST_HOME
  delete process.env.XDG_DATA_HOME
  if (dir) rmSync(dir, { force: true, recursive: true })
})

describe("local sync", () => {
  test("syncMetadata only copies sessions missing from local sqlite", async () => {
    const db = prep(meta(dir))
    db.query(
      "INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "ses_local",
      "p1",
      null,
      null,
      "local",
      "/tmp",
      "local",
      "1",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
      1,
      null,
      null,
    )
    db.close()

    const pg = sql({
      "FROM session s": [
        {
          id: "ses_local",
          project_id: "p1",
          workspace_id: null,
          parent_id: null,
          slug: "local",
          directory: "/tmp/local",
          title: "local remote copy",
          version: "1",
          share_url: null,
          summary_additions: null,
          summary_deletions: null,
          summary_files: null,
          summary_diffs_raw: null,
          revert_raw: null,
          permission_raw: null,
          time_created: 10,
          time_updated: 10,
          time_compacting: null,
          time_archived: null,
        },
        {
          id: "ses_remote",
          project_id: "p2",
          workspace_id: null,
          parent_id: null,
          slug: "remote",
          directory: "/tmp/remote",
          title: "remote",
          version: "1",
          share_url: null,
          summary_additions: null,
          summary_deletions: null,
          summary_files: null,
          summary_diffs_raw: null,
          revert_raw: null,
          permission_raw: null,
          time_created: 20,
          time_updated: 20,
          time_compacting: null,
          time_archived: null,
        },
      ],
    })

    await syncMetadata(pg as never, meta(dir))

    const out = prep(meta(dir))
    const rows = out.query("SELECT id, title FROM session ORDER BY id").all() as Array<{ id: string; title: string }>
    out.close()

    expect(rows).toEqual([
      { id: "ses_local", title: "local" },
      { id: "ses_remote", title: "remote" },
    ])
  })

  test("remoteStatus only reports postgres sessions missing locally", async () => {
    const db = prep(meta(dir))
    db.query(
      "INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "ses_local",
      "p1",
      null,
      null,
      "local",
      "/tmp",
      "local",
      "1",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
      1,
      null,
      null,
    )
    db.close()

    const pg = sql({
      "SELECT id, time_updated FROM session": [
        { id: "ses_local", time_updated: 10 },
        { id: "ses_remote", time_updated: 20 },
      ],
      "FROM resumable_checkpoint": [{ session_id: "ses_remote", checkpoint_time: 20 }],
    })

    expect(await remoteStatus(pg as never, meta(dir))).toEqual({
      ses_remote: { type: "idle" },
    })
  })

  test("pullSession pulls any postgres session missing locally", async () => {
    prep(meta(dir)).close()

    const pg = sql({
      "SELECT id FROM session WHERE id = ? LIMIT 1": [{ id: "ses_remote" }],
      "SELECT * FROM session WHERE id IN (SELECT id FROM tree)": [
        {
          id: "ses_remote",
          project_id: "p1",
          workspace_id: null,
          parent_id: null,
          slug: "remote",
          directory: "/tmp/remote",
          title: "remote",
          version: "1",
          share_url: null,
          summary_additions: null,
          summary_deletions: null,
          summary_files: null,
          summary_diffs_raw: null,
          revert_raw: null,
          permission_raw: null,
          time_created: 10,
          time_updated: 20,
          time_compacting: null,
          time_archived: null,
        },
      ],
      "WITH RECURSIVE tree AS ( SELECT id, parent_id FROM session WHERE id = ?": [{ id: "ses_remote" }],
      "FROM message": [],
      "FROM part": [],
      "FROM todo": [],
    })

    expect(await pullSession(pg as never, meta(dir), "ses_remote")).toBe(true)

    const db = prep(meta(dir))
    const row = db.query("SELECT id, title FROM session WHERE id = ?").get("ses_remote") as {
      id: string
      title: string
    } | null
    db.close()

    expect(row).toEqual({ id: "ses_remote", title: "remote" })
    expect(Bun.file(shard(dir, "ses_remote")).size).toBeGreaterThan(0)
  })
})
