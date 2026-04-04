import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const dir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
mkdirSync(dir, { recursive: true })
const file = path.join(dir, "postgres-sync.log")

function fmt(msg: string, err?: unknown) {
  const ts = new Date().toISOString()
  const suffix = err ? ` ${err instanceof Error ? err.message : String(err)}` : ""
  return `${ts} [postgres-sync] ${msg}${suffix}\n`
}

export function warn(msg: string, err?: unknown) {
  try {
    appendFileSync(file, fmt(msg, err))
  } catch {}
}

export function info(msg: string) {
  try {
    appendFileSync(file, fmt(msg))
  } catch {}
}
