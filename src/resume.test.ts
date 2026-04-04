import { describe, expect, test } from "bun:test"
import { checkpoint, normalize } from "./resume.js"

describe("resume normalization", () => {
  test("converts running tool parts to terminal error state", () => {
    const now = 1710000000000
    const part = {
      id: "prt_1",
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: {
        status: "running",
        input: { command: "sleep 30" },
        metadata: { output: "partial" },
        time: { start: 1709999999000 },
      },
    }

    const result = normalize(part, now) as any

    expect(result.type).toBe("tool")
    expect(result.state.status).toBe("error")
    expect(result.state.error).toBe("Interrupted during cross-machine restore")
    expect(result.state.input).toEqual({ command: "sleep 30" })
    expect(result.state.metadata).toEqual({ output: "partial" })
    expect(result.state.time.start).toBe(1709999999000)
    expect(result.state.time.end).toBe(now)
  })

  test("converts pending tool parts to terminal error state", () => {
    const part = {
      id: "prt_2",
      type: "tool",
      tool: "task",
      callID: "call_2",
      state: {
        status: "pending",
        input: { prompt: "do work" },
        raw: "raw call",
      },
    }

    const result = normalize(part, 10) as any

    expect(result.state.status).toBe("error")
    expect(result.state.error).toBe("Interrupted during cross-machine restore")
    expect(result.state.input).toEqual({ prompt: "do work" })
    expect(result.state.time.start).toBe(10)
    expect(result.state.time.end).toBe(10)
  })

  test("leaves completed tool parts untouched", () => {
    const part = {
      id: "prt_3",
      type: "tool",
      tool: "bash",
      callID: "call_3",
      state: {
        status: "completed",
        input: { command: "echo hi" },
        output: "hi",
        title: "bash",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }

    expect(normalize(part, 99)).toEqual(part)
  })
})

describe("checkpoint safety", () => {
  test("is safe only when session idle and no unfinished work exists", () => {
    const safe = checkpoint({
      status: { type: "idle" },
      finish: "stop",
      parts: [{ type: "text" }, { type: "tool", state: { status: "completed" } }],
    })

    expect(safe).toBe(true)
  })

  test("is unsafe when session is busy", () => {
    const safe = checkpoint({
      status: { type: "busy" },
      finish: "stop",
      parts: [],
    })

    expect(safe).toBe(false)
  })

  test("is unsafe when a tool is pending or running", () => {
    const running = checkpoint({
      status: { type: "idle" },
      finish: "stop",
      parts: [{ type: "tool", state: { status: "running" } }],
    })
    const pending = checkpoint({
      status: { type: "idle" },
      finish: "stop",
      parts: [{ type: "tool", state: { status: "pending" } }],
    })

    expect(running).toBe(false)
    expect(pending).toBe(false)
  })

  test("is unsafe when compaction or subtask is present", () => {
    const compaction = checkpoint({
      status: { type: "idle" },
      finish: "stop",
      parts: [{ type: "compaction" }],
    })
    const subtask = checkpoint({
      status: { type: "idle" },
      finish: "stop",
      parts: [{ type: "subtask" }],
    })

    expect(compaction).toBe(false)
    expect(subtask).toBe(false)
  })

  test("is unsafe when assistant finish is tool-calls or unknown", () => {
    const toolCalls = checkpoint({
      status: { type: "idle" },
      finish: "tool-calls",
      parts: [],
    })
    const unknown = checkpoint({
      status: { type: "idle" },
      finish: "unknown",
      parts: [],
    })

    expect(toolCalls).toBe(false)
    expect(unknown).toBe(false)
  })
})
