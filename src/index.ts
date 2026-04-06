import os from "node:os"
import path from "node:path"
import postgres from "postgres"
import { warn } from "./log.js"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import {
  checkpointState,
  pullSession,
  refreshCheckpoints,
  remoteStatus,
  saveCheckpoint,
  syncMetadata,
} from "./local.js"
import { tools } from "./tools.js"
import { replayBus, syncTodos, type Todo } from "./projectors.js"
import { backfill } from "./backfill.js"

type TodoEvent = {
  type: "todo.updated"
  properties: {
    sessionID: string
    todos: Array<Todo & { id?: string }>
  }
}

type StatusEvent = {
  type: "session.status"
  properties: {
    sessionID: string
    status: { type: "idle" | "busy" | "retry" }
  }
}

type Phase55Hooks = Hooks & {
  "session.list.before"?: (
    input: {
      directory?: string
      roots?: boolean
      start?: number
      search?: string
      limit?: number
    },
    output: {},
  ) => Promise<void>
  "session.status.before"?: (
    input: {},
    output: {
      status: Record<
        string,
        {
          type: "idle" | "busy" | "retry"
          attempt?: number
          message?: string
          next?: number
        }
      >
    },
  ) => Promise<void>
  "session.ensure.before"?: (
    input: {
      sessionID: string
      mode: "get" | "messages" | "todo" | "prompt" | "prompt_async" | "command" | "shell"
    },
    output: {},
  ) => Promise<void>
}

function timeout<T>(fn: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([fn(), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}

const plugin: Plugin = async (_, options) => {
  const url = options?.url as string
  if (!url) {
    warn("no postgres url configured (set options.url), skipping")
    return {}
  }

  const machine = (options?.machine as string) ?? os.hostname()
  const file = (options?.db as string) ?? path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db")
  const maxDays = typeof options?.backfill === "number" ? (options.backfill as number) : -1

  let sql: ReturnType<typeof postgres>
  try {
    sql = postgres(url, {
      connect_timeout: 5,
      max: 1,
      onclose() {
        warn("postgres connection closed")
      },
    })
  } catch (err) {
    warn("failed to create postgres connection, skipping", err)
    return {}
  }

  const sync = async () => {
    try {
      await syncMetadata(sql)
      await refreshCheckpoints(sql, machine)
    } catch (err) {
      warn("metadata sync failed", err)
    }
  }

  const ensure = async (sid: string) => {
    try {
      await pullSession(sql, sid)
    } catch (err) {
      warn("session pull failed", err)
    }
  }

  const status = async () => {
    try {
      return await remoteStatus(sql)
    } catch (err) {
      warn("remote status failed", err)
      return {}
    }
  }

  const checkpoint = async (sid: string) => {
    try {
      const state = checkpointState(sid)
      if (!state?.safe) return
      await saveCheckpoint(sql, {
        sessionID: sid,
        machine,
        checkpointTime: state.checkpointTime,
        lastMessageID: state.lastMessageID,
      })
    } catch (err) {
      warn("checkpoint save failed", err)
    }
  }

  if (maxDays !== 0) {
    void backfill(sql, machine, file, maxDays)
  }

  void sync()
  const timer = setInterval(() => {
    void sync()
  }, 30000)
  timer.unref()

  const hooks: Phase55Hooks = {
    event: async ({ event }) => {
      try {
        await replayBus(sql, event)
      } catch (err) {
        warn("replay failed", err)
      }

      try {
        const item = event as TodoEvent
        if (item.type === "todo.updated") {
          await syncTodos(
            sql,
            item.properties.sessionID,
            item.properties.todos.map((todo) => ({
              content: todo.content,
              status: todo.status,
              priority: todo.priority,
            })),
          )
        }

        const state = event as StatusEvent
        if (state.type === "session.status" && state.properties.status.type === "idle") {
          await checkpoint(state.properties.sessionID)
        }
      } catch (err) {
        warn("event hook failed", err)
      }
    },
    "session.list.before": async () => {
      await timeout(sync, 3000, undefined)
    },
    "session.status.before": async (
      _: {},
      output: {
        status: Record<
          string,
          {
            type: "idle" | "busy" | "retry"
            attempt?: number
            message?: string
            next?: number
          }
        >
      },
    ) => {
      const remote = await timeout(status, 3000, {})
      Object.assign(output.status, remote)
    },
    "session.ensure.before": async (data: {
      sessionID: string
      mode: "get" | "messages" | "todo" | "prompt" | "prompt_async" | "command" | "shell"
    }) => {
      await timeout(() => ensure(data.sessionID), 5000, undefined)
    },
    tool: tools(sql),
  }

  return hooks
}

export default { id: "opencode-postgres-sync", server: plugin }
