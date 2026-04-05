import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

type Hooks = {
  event?: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
  "session.list.before"?: (input: {}, output: {}) => Promise<void>
  "session.status.before"?: (input: {}, output: { status: Record<string, unknown> }) => Promise<void>
  "session.ensure.before"?: (input: { mode: string; sessionID: string }, output: {}) => Promise<void>
}

const sql = {} as never
const hit = {
  replay: [] as Array<{ evt: { type: string }; machine: string }>,
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

mock.module("postgres", () => ({
  default() {
    return sql
  },
}))

mock.module("./backfill.js", () => ({
  async backfill() {},
}))

mock.module("./projectors.js", () => ({
  async replayBus(_: unknown, evt: { type: string }, machine: string) {
    if (fail) throw new Error("boom")
    hit.replay.push({ evt, machine })
  },
  async syncTodos(_: unknown, sid: string, todos: Array<{ content: string; status: string; priority: string }>) {
    hit.todo.push({ sid, todos })
  },
}))

mock.module("./local.js", () => ({
  checkpointState() {
    return {
      safe: true,
      checkpointTime: 123,
      lastMessageID: "msg_1",
    }
  },
  async pullSession(_: unknown, sid: string) {
    hit.pull.push(sid)
  },
  async refreshCheckpoints() {
    hit.fresh += 1
  },
  async remoteStatus() {
    hit.remote += 1
    return { ses_remote: { type: "idle" as const } }
  },
  async saveCheckpoint(
    _: unknown,
    input: { sessionID: string; machine: string; checkpointTime: number; lastMessageID: string | null },
  ) {
    hit.save.push(input)
  },
  async syncMetadata() {
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

const mod = await import("./index.js")

const real = globalThis.setInterval

beforeEach(() => {
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
    const hooks = (await mod.default.server({} as never, { machine: "m1", url: "postgres://db" } as never)) as Hooks

    await Promise.resolve()

    expect(hooks.event).toBeFunction()
    expect(hit.meta).toBe(1)
    expect(hit.fresh).toBe(1)
    expect(hit.tick).toEqual([30000])
    expect(hit.unref).toBe(1)
    expect(hit.warn).toHaveLength(0)
  })

  test("routes bus events and inlines sync helpers", async () => {
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
    expect(hit.replay.map((item) => item.machine)).toEqual(["m1", "m1", "m1"])
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
    const hooks = (await mod.default.server({} as never, { machine: "m1", url: "postgres://db" } as never)) as Hooks
    fail = true

    await hooks.event?.({
      event: { type: "message.updated", properties: { info: { id: "msg_1" } } },
    } as never)

    expect(hit.warn).toHaveLength(1)
    expect(String(hit.warn[0]?.[0])).toContain("replay failed")
  })
})
