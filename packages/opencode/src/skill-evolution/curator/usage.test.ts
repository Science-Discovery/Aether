import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Usage } from "./usage"

async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "curator-usage-test-"))
  return { path: p, cleanup: () => fs.rm(p, { recursive: true, force: true }) }
}

function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  )
}

/** Create an in-scope skill dir <root>/<projectId>/skills/<name>/SKILL.md, return SKILL.md path. */
async function makeSkill(root: string, projectId: string, name: string): Promise<string> {
  const dir = path.join(root, projectId, "skills", name)
  await fs.mkdir(dir, { recursive: true })
  const loc = path.join(dir, "SKILL.md")
  await fs.writeFile(loc, `---\nname: ${name}\ndescription: test\n---\nBody\n`, "utf-8")
  return loc
}

describe("Usage.bumpUse", () => {
  // M1: 计数 upsert (核心接缝 — 写进去再读出来)
  test("upserts a record and increments use_count across calls", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc)
      await Usage.bumpUse(tmp.path, loc)

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]
      expect(rec).toBeDefined()
      expect(rec!.use_count).toBe(2)
      expect(rec!.last_used_at).not.toBeNull()
      expect(rec!.projectId).toBe("proj1")
      expect(rec!.name).toBe("foo")
    } finally {
      await tmp.cleanup()
    }
  })

  // M2: 范围过滤 — 不在 <projectId>/skills/ 下的 skill 不记账
  test("does not record out-of-scope skills", async () => {
    const tmp = await makeTmp()
    try {
      // <projectId>/archive/<name> — 3 段但中间不是 "skills"，属范围外
      const dir = path.join(tmp.path, "proj1", "archive", "baz")
      await fs.mkdir(dir, { recursive: true })
      const loc = path.join(dir, "SKILL.md")
      await fs.writeFile(loc, "---\nname: baz\n---\n", "utf-8")

      await Usage.bumpUse(tmp.path, loc)

      const data = await Usage.load(tmp.path)
      expect(Object.keys(data)).toHaveLength(0)
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Usage.archiveSkill", () => {
  // M4: 归档移目录 (核心接缝) — 真建目录+账本 → 移到 <projectId>/archive → archived
  test("moves the skill dir to <projectId>/archive and marks it archived", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc) // seed a ledger record
      const skillDir = path.dirname(loc)

      const ok = await Usage.archiveSkill(tmp.path, "proj1/foo")
      expect(ok).toBe(true)

      // original gone
      expect(await exists(skillDir)).toBe(false)
      // archived copy present at <projectId>/archive/<name>
      expect(await exists(path.join(tmp.path, "proj1", "archive", "foo", "SKILL.md"))).toBe(true)
      // ledger updated
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("archived")
      expect(data["proj1/foo"]!.archived_at).not.toBeNull()
    } finally {
      await tmp.cleanup()
    }
  })

  test("returns false when the skill directory is missing", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc)
      await fs.rm(path.dirname(loc), { recursive: true, force: true }) // delete the dir, keep ledger

      const ok = await Usage.archiveSkill(tmp.path, "proj1/foo")
      expect(ok).toBe(false)
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Usage.restoreSkill", () => {
  // M5: 恢复 — 从 archive 移回原 location，state 回 active
  test("moves an archived skill back to its original location and marks active", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc)
      const skillDir = path.dirname(loc)
      await Usage.archiveSkill(tmp.path, "proj1/foo")
      expect(await exists(skillDir)).toBe(false)

      const ok = await Usage.restoreSkill(tmp.path, "proj1/foo")
      expect(ok).toBe(true)
      expect(await exists(loc)).toBe(true) // back at original location
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active")
      expect(data["proj1/foo"]!.archived_at).toBeNull()
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Usage.load", () => {
  // M3: 账本损坏不崩 — 非法 JSON → 返回 {}，不抛
  test("returns empty object on corrupt ledger", async () => {
    const tmp = await makeTmp()
    try {
      const dir = path.join(tmp.path, "curator")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "usage.json"), "{ not valid json", "utf-8")

      const data = await Usage.load(tmp.path)
      expect(data).toEqual({})
    } finally {
      await tmp.cleanup()
    }
  })

  test("returns empty object when ledger missing", async () => {
    const tmp = await makeTmp()
    try {
      const data = await Usage.load(tmp.path)
      expect(data).toEqual({})
    } finally {
      await tmp.cleanup()
    }
  })
})
