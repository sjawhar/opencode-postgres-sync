import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"

test("index behavior checks pass in isolation", async () => {
  const cwd = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
  const proc = Bun.spawn(["bun", "test", "./src/index.check.ts"], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited

  expect(code, `${out}${err}`).toBe(0)
})
