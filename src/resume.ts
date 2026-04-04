type Status = { type: "idle" | "busy" | "retry" }

type Part = {
  type?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
    time?: { start?: number }
  }
}

const err = "Interrupted during cross-machine restore"

export function normalize<T extends Part>(part: T, now = Date.now()): T {
  if (part.type !== "tool") return part
  if (part.state?.status !== "pending" && part.state?.status !== "running") return part

  return {
    ...part,
    state: {
      status: "error",
      input: part.state.input ?? {},
      metadata: part.state.metadata,
      error: err,
      time: {
        start: part.state.time?.start ?? now,
        end: now,
      },
    },
  } as T
}

export function checkpoint(input: { status: Status; finish?: string; parts: Array<Part> }) {
  if (input.status.type !== "idle") return false
  if (input.finish === "tool-calls" || input.finish === "unknown") return false

  for (const part of input.parts) {
    if (part.type === "compaction" || part.type === "subtask") return false
    if (part.type !== "tool") continue
    if (part.state?.status === "pending" || part.state?.status === "running") return false
  }

  return true
}

export const RestoreError = err
