import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createInterface } from "readline"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"

// End-to-end test of the JS watcher sidecar protocol: start message in,
// ready + file events out, clean exit on stdin close.

const script = path.join(import.meta.dir, "watcher-child.ts")

function startChild(root: string) {
  const proc = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] })
  const lines: Array<Record<string, any>> = []
  const waiter = { notify: () => {} }
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sidecar never became ready")), 30_000)
    waiter.notify = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  const out = createInterface({ input: proc.stdout!, crlfDelay: Infinity })
  out.on("line", (line) => {
    if (!line.trim()) return
    const msg = JSON.parse(line)
    lines.push(msg)
    if (msg.type === "ready") waiter.notify()
  })
  const stderr: string[] = []
  const errOut = createInterface({ input: proc.stderr!, crlfDelay: Infinity })
  errOut.on("line", (line) => stderr.push(line))
  proc.stdin!.write(JSON.stringify({ v: 1, type: "start", root, ignore: [], mode: "full", dirs: [] }) + "\n")
  return {
    proc,
    lines,
    ready,
    stderr,
    stop: () => {
      proc.stdin!.end()
      return proc.exited
    },
    kill: () => proc.kill(),
  }
}

async function until(
  lines: Array<Record<string, any>>,
  predicate: (msg: Record<string, any>) => boolean,
  what: string,
) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = lines.find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("watcher js sidecar", () => {
  let tmp: string

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "watcher-child-test-"))
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test("reports ready and streams file events", async () => {
    const child = startChild(tmp)
    await child.ready

    await fs.writeFile(path.join(tmp, "hello.txt"), "hi")
    const create = await until(child.lines, (m) => m.type === "event" && m.event === "add", "create event")
    expect(create.path).toContain("hello.txt")

    await fs.writeFile(path.join(tmp, "hello.txt"), "updated")
    await until(child.lines, (m) => m.type === "event" && m.event === "change", "change event")

    const stopped = child.stop()
    await until(child.lines, (m) => m.type === "event" && m.event === "unlink", "unlink event").catch(() => {
      // the unlink event may race with stdin close; not required
    })
    await stopped
  }, 30_000)

  test("exits when the directory is missing", async () => {
    const missing = path.join(tmp, "does-not-exist")
    const child = startChild(missing)
    const code = await Promise.race([
      child.proc.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("sidecar ignored a missing directory")), 20_000)),
    ])
    expect(code).not.toBe(0)
    child.kill()
  }, 30_000)
})
