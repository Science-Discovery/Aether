import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"

async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "instance-test-"))
  return { path: p, cleanup: () => fs.rm(p, { recursive: true, force: true }) }
}

function projectFor(directory: string, worktree: string) {
  return {
    id: ProjectID.fromDirectory(directory),
    worktree,
    sandboxes: [] as string[],
    time: { created: Date.now(), updated: Date.now() },
  }
}

describe("instance closing tombstone", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    tmp = await makeTmp()
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  test("closed directory does not create an instance", async () => {
    const dir = path.join(tmp.path, "sandbox-a")
    await fs.mkdir(dir, { recursive: true })

    Instance.beginClose(dir)
    try {
      const result = await Instance.provide({ directory: dir, fn: () => "ok" })
      expect(result).toBe("ok")
      expect(Instance.has(dir)).toBe(false)
    } finally {
      Instance.endClose(dir)
    }
  })

  test("closed directory never executes in another instance's context", async () => {
    const live = path.join(tmp.path, "live")
    const closed = path.join(tmp.path, "sandbox-b")
    await fs.mkdir(live, { recursive: true })
    await fs.mkdir(closed, { recursive: true })

    await Instance.provide({ directory: live, worktree: live, project: projectFor(live, live), fn: () => undefined })

    Instance.beginClose(closed)
    try {
      await Instance.provide({ directory: closed, fn: () => undefined })
      expect(Instance.has(closed)).toBe(false)
    } finally {
      Instance.endClose(closed)
    }
  })

  test("endClose reallows instance creation after the directory was deleted and recreated", async () => {
    const dir = path.join(tmp.path, "sandbox-c")
    await fs.mkdir(dir, { recursive: true })

    Instance.beginClose(dir)
    await fs.rm(dir, { recursive: true, force: true })
    Instance.endClose(dir)
    await fs.mkdir(dir, { recursive: true })

    await Instance.provide({ directory: dir, worktree: dir, project: projectFor(dir, dir), fn: () => undefined })
    expect(Instance.has(dir)).toBe(true)
  })
})
