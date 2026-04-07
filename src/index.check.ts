import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

type Hooks = {
  event?: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
  "session.list.before"?: (input: {}, output: {}) => Promise<void>
  "session.status.before"?: (input: {}, output: { status: Record<string, unknown> }) => Promise<void>
  "session.ensure.before"?: (input: { mode: string; sessionID: string }, output: {}) => Promise<void>
}

const sql = {} as never
const hit = {
  backfill: [] as Array<{ machine: string; file: string; maxDays: number }>,
  replay: [] as Array<{ evt: { type: string }; argc: number }>,
  todo: [] as Array<{ sid: string; todos: Array<{ content: string; status: string; priority: string }> }>,
  pull: [] as string[],
  save: [] as Array<{ sessionID: string; machine: string; checkpointTime: number; lastMessageID: string | null }>,
  warn: [] as unknown[][],
  tick: [] as number[],
  unref: 0,
  meta: 0,
  fresh: 0,
  remote: 0,
}
let fail = false

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
  mock.module("postgres", () => ({
    default() {
      return sql
    },
  }))

  mock.module("./backfill.js", () => ({
    async backfill(_: unknown, machine: string, file: string, maxDays: number) {
      hit.backfill.push({ machine, file, maxDays })
    },
  }))

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
    async replayBus(...args: [unknown, { type: string }] | [unknown, { type: string }, string]) {
      if (fail) throw new Error("boom")
      hit.replay.push({ evt: args[1], argc: args.length })
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
    async syncTodos(_: unknown, sid: string, todos: Array<{ content: string; status: string; priority: string }>) {
      hit.todo.push({ sid, todos })
    },
  }))

  mock.module("./local.js", () => ({
    checkpointState(_: unknown, sid: string) {
      return {
        safe: true,
        checkpointTime: 123,
        lastMessageID: "msg_1",
      }
    },
    async pullSession(_: unknown, db: string, sid: string) {
      hit.pull.push(sid)
    },
    async refreshCheckpoints(_: unknown, db: string) {
      hit.fresh += 1
    },
    async remoteStatus(_: unknown, db: string) {
      hit.remote += 1
      return { ses_remote: { type: "idle" as const } }
    },
    async saveCheckpoint(
      _: unknown,
      input: { sessionID: string; machine: string; checkpointTime: number; lastMessageID: string | null },
    ) {
      hit.save.push(input)
    },
    async syncMetadata(_: unknown, db: string) {
      hit.meta += 1
    },
  }))

  mock.module("./log.js", () => ({
    warn(...args: unknown[]) {
      hit.warn.push(args)
    },
    info() {},
  }))

  mock.module("./tools.js", () => ({
    tools() {
      return "tool"
    },
  }))

  const mod = await import(`./index.js?${Date.now()}-${Math.random()}`)
  mock.restore()
  return mod
}

const real = globalThis.setInterval

beforeEach(() => {
  hit.backfill.length = 0
  hit.replay.length = 0
  hit.todo.length = 0
  hit.pull.length = 0
  hit.save.length = 0
  hit.warn.length = 0
  hit.tick.length = 0
  hit.unref = 0
  hit.meta = 0
  hit.fresh = 0
  hit.remote = 0
  fail = false
  globalThis.setInterval = ((_: TimerHandler, ms?: number) => {
    hit.tick.push(ms ?? 0)
    return {
      unref() {
        hit.unref += 1
      },
    } as never
  }) as unknown as typeof setInterval
})

afterEach(() => {
  globalThis.setInterval = real
})

describe("postgres sync plugin", () => {
  test("starts without the SSE consumer and primes metadata sync", async () => {
    const mod = await load()
    const hooks = (await mod.default.server(
      {} as never,
      { machine: "m1", url: "postgres://db", db: "/tmp/opencode.db", backfill: -1 } as never,
    )) as Hooks

    await Promise.resolve()

    expect(hooks.event).toBeFunction()
    expect(hit.meta).toBe(1)
    expect(hit.fresh).toBe(1)
    expect(hit.tick).toEqual([30000])
    expect(hit.unref).toBe(1)
    expect(hit.backfill).toEqual([{ machine: "m1", file: "/tmp/opencode.db", maxDays: -1 }])
    expect(hit.warn).toHaveLength(0)
  })

  test("skips backfill when backfill is zero", async () => {
    const mod = await load()
    await (mod.default.server(
      {} as never,
      { machine: "m1", url: "postgres://db", backfill: 0 } as never,
    ) as Promise<Hooks>)
    await Promise.resolve()
    expect(hit.backfill).toEqual([])
    expect(hit.warn).toHaveLength(0)
  })

  test("routes bus events and inlines sync helpers", async () => {
    const mod = await load()
    const hooks = (await mod.default.server({} as never, { machine: "m1", url: "postgres://db" } as never)) as Hooks

    await hooks.event?.({
      event: { type: "message.updated", properties: { info: { id: "msg_1" } } },
    } as never)
    await hooks.event?.({
      event: {
        type: "todo.updated",
        properties: {
          sessionID: "ses_1",
          todos: [{ id: "todo_1", content: "ship it", status: "done", priority: "high" }],
        },
      },
    } as never)
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      },
    } as never)
    await hooks["session.list.before"]?.({}, {})

    const out = { status: {} }
    await hooks["session.status.before"]?.({}, out)
    await hooks["session.ensure.before"]?.({ mode: "get", sessionID: "ses_1" }, {})

    expect(hit.replay.map((item) => item.evt.type)).toEqual(["message.updated", "todo.updated", "session.status"])
    expect(hit.replay.map((item) => item.argc)).toEqual([2, 2, 2])
    expect(hit.todo).toEqual([
      {
        sid: "ses_1",
        todos: [{ content: "ship it", status: "done", priority: "high" }],
      },
    ])
    expect(hit.save).toEqual([
      {
        sessionID: "ses_1",
        machine: "m1",
        checkpointTime: 123,
        lastMessageID: "msg_1",
      },
    ])
    expect(hit.meta).toBe(2)
    expect(hit.fresh).toBe(2)
    expect(out.status).toEqual({ ses_remote: { type: "idle" } })
    expect(hit.remote).toBe(1)
    expect(hit.pull).toEqual(["ses_1"])
  })

  test("logs replay failures without crashing the host", async () => {
    const mod = await load()
    const hooks = (await mod.default.server(
      {} as never,
      { machine: "m1", url: "postgres://db", db: "/tmp/opencode.db", backfill: -1 } as never,
    )) as Hooks
    fail = true

    await hooks.event?.({
      event: { type: "message.updated", properties: { info: { id: "msg_1" } } },
    } as never)

    expect(hit.warn).toHaveLength(1)
    expect(String(hit.warn[0]?.[0])).toContain("replay failed")
  })
})
