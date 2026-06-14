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
      // 新字段默认值: 首次 upsert 出来的记录带零基线 (PD1)
      expect(rec!.idle_scans).toBe(0)
      expect(rec!.use_count_at_last_scan).toBe(0)
    } finally {
      await tmp.cleanup()
    }
  })

  // S1 (核心接缝): 写→读接力 — 连调两次带不同 session id，load 回来事件明细对得上
  test("appends a recent_uses event per call (write→read seam)", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc, "ses_A", new Date("2026-06-08T14:02:00.000Z"))
      await Usage.bumpUse(tmp.path, loc, "ses_B", new Date("2026-06-12T01:25:00.000Z"))

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]
      expect(rec).toBeDefined()
      expect(rec!.recent_uses).toHaveLength(2)
      expect(rec!.recent_uses[0]).toEqual({ session_id: "ses_A", at: "2026-06-08T14:02:00.000Z" })
      expect(rec!.recent_uses[1]).toEqual({ session_id: "ses_B", at: "2026-06-12T01:25:00.000Z" })
    } finally {
      await tmp.cleanup()
    }
  })

  // S2 (有界 + 假绿陷阱): N+1 次 → 恰 N 条、头部最老被挤掉、尾部最新还在
  test("slides the window to keep only the most recent MAX_RECENT_USES events", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      const n = Usage.MAX_RECENT_USES
      for (let i = 0; i <= n; i++) {
        // i 从 0 到 n，共 n+1 次；session id 编号便于辨认头尾
        await Usage.bumpUse(tmp.path, loc, `ses_${i}`)
      }

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]!
      expect(rec.recent_uses).toHaveLength(n) // 恰好 N，不是 ≥N
      expect(rec.recent_uses[0]!.session_id).toBe("ses_1") // 最老的 ses_0 被挤掉
      expect(rec.recent_uses[n - 1]!.session_id).toBe(`ses_${n}`) // 尾部是最新
      expect(rec.use_count).toBe(n + 1) // use_count 不封顶
    } finally {
      await tmp.cleanup()
    }
  })

  // S3: 同一 session id 多次加载 → 多条同 id 事件 (不去重)
  test("records one event per load even within the same session", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc, "ses_same")
      await Usage.bumpUse(tmp.path, loc, "ses_same")

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]!
      expect(rec.recent_uses).toHaveLength(2)
      expect(rec.recent_uses.map((e) => e.session_id)).toEqual(["ses_same", "ses_same"])
    } finally {
      await tmp.cleanup()
    }
  })

  // S4: 缺字段兜底 — 老账本记录无 recent_uses → bumpUse 不抛、变 1 条
  test("backfills recent_uses for legacy records missing the field", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      // 手写一条没有 recent_uses 的老记录
      const dir = path.join(tmp.path, "curator")
      await fs.mkdir(dir, { recursive: true })
      const legacy = {
        "proj1/foo": {
          projectId: "proj1",
          name: "foo",
          location: path.dirname(loc),
          use_count: 5,
          use_count_at_last_scan: 5,
          idle_scans: 0,
          last_used_at: "2026-06-01T00:00:00.000Z",
          state: "active",
          pinned: false,
          archived_at: null,
        },
      }
      await fs.writeFile(path.join(dir, "usage.json"), JSON.stringify(legacy), "utf-8")

      await Usage.bumpUse(tmp.path, loc, "ses_new")

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]!
      expect(rec.use_count).toBe(6)
      expect(rec.recent_uses).toHaveLength(1)
      expect(rec.recent_uses[0]!.session_id).toBe("ses_new")
    } finally {
      await tmp.cleanup()
    }
  })

  // S5 (防回归): 不传 sessionId → use_count+1 但不记坐标
  test("increments use_count without recording a coordinate when sessionId is absent", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc)

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]!
      expect(rec.use_count).toBe(1)
      expect(rec.recent_uses).toEqual([])
    } finally {
      await tmp.cleanup()
    }
  })

  // 新记录默认 recent_uses 为 []
  test("a freshly upserted record has an empty recent_uses array", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, loc)
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.recent_uses).toEqual([])
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

  // load() heals legacy records on its own — even when bumpUse never runs
  // (recordScanResult/setState rely on load returning a well-formed record).
  test("backfills missing recent_uses to [] for legacy records on load", async () => {
    const tmp = await makeTmp()
    try {
      const dir = path.join(tmp.path, "curator")
      await fs.mkdir(dir, { recursive: true })
      const legacy = {
        "proj1/foo": {
          projectId: "proj1",
          name: "foo",
          location: "/some/where",
          use_count: 3,
          use_count_at_last_scan: 3,
          idle_scans: 0,
          last_used_at: null,
          state: "active",
          pinned: false,
          archived_at: null,
        },
      }
      await fs.writeFile(path.join(dir, "usage.json"), JSON.stringify(legacy), "utf-8")

      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.recent_uses).toEqual([])
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
