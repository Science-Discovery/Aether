import { expect, test } from "bun:test"
import { join } from "node:path"

test("MCP tool cancellation propagates session abort (isolated probe)", async () => {
  const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "cancellation-probe.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = proc.stdout.toString()
  const lastLine = stdout.trim().split("\n").at(-1) ?? ""
  let results: Array<{ name: string; pass: boolean; detail?: string }>
  try {
    results = JSON.parse(lastLine)
  } catch {
    throw new Error(
      `probe produced no parsable result (exit ${proc.exitCode})\nstdout:\n${stdout}\nstderr:\n${proc.stderr.toString()}`,
    )
  }

  expect(results.length).toBe(3)
  for (const r of results) {
    expect(r.pass, `${r.name}${r.detail ? `: ${r.detail}` : ""}`).toBe(true)
  }
}, 60_000)
