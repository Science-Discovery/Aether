import { describe, expect, test, spyOn } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Curator } from "./curator"
import { Usage, type UsageRecord } from "./usage"
import { DEFAULT_CURATOR_CONFIG } from "./constants"
import { Config } from "@/config/config"
import { ConfigReader } from "../config-reader"

async function makeTmp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "curator-test-"))
  return { path: p, cleanup: () => fs.rm(p, { recursive: true, force: true }) }
}

const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = new Date("2026-06-01T00:00:00.000Z")

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  )
}

/** Create an in-scope skill <root>/<projectId>/skills/<name>/SKILL.md; SKILL.md mtime = mtimeAgoMs before NOW. */
async function makeSkill(root: string, projectId: string, name: string, mtimeAgoMs = 0): Promise<string> {
  const dir = path.join(root, projectId, "skills", name)
  await fs.mkdir(dir, { recursive: true })
  const md = path.join(dir, "SKILL.md")
  await fs.writeFile(md, `---\nname: ${name}\ndescription: test\n---\nBody\n`, "utf-8")
  const t = new Date(NOW.getTime() - mtimeAgoMs)
  await fs.utimes(md, t, t)
  return dir
}

/** Write the usage ledger directly (used to set up pinned / orphan fixtures). */
async function writeLedger(root: string, records: Record<string, UsageRecord>): Promise<void> {
  const dir = path.join(root, "curator")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "usage.json"), JSON.stringify(records, null, 2), "utf-8")
}

function record(projectId: string, name: string, location: string, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    projectId,
    name,
    location,
    use_count: 0,
    last_used_at: null,
    recent_uses: [],
    state: "active",
    pinned: false,
    archived_at: null,
    ...over,
  }
}

describe("Curator.shouldRunNow", () => {
  // M6: 首次不立刻跑 — 推迟并种下 lastRunAt
  test("first run defers and seeds lastRunAt", async () => {
    const tmp = await makeTmp()
    try {
      const run = await Curator.shouldRunNow(tmp.path, { now: NOW })
      expect(run).toBe(false)
      const state = await Curator.loadState(tmp.path)
      expect(state.lastRunAt).toBe(NOW.toISOString())
    } finally {
      await tmp.cleanup()
    }
  })

  // M7: 未到间隔不跑
  test("does not run before interval elapses", async () => {
    const tmp = await makeTmp()
    try {
      await Curator.saveState(tmp.path, { lastRunAt: ago(1 * HOUR), paused: false, runCount: 1 })
      expect(await Curator.shouldRunNow(tmp.path, { now: NOW })).toBe(false)
    } finally {
      await tmp.cleanup()
    }
  })

  // M8: 到间隔才跑
  test("runs after interval elapses", async () => {
    const tmp = await makeTmp()
    try {
      await Curator.saveState(tmp.path, { lastRunAt: ago(8 * DAY), paused: false, runCount: 1 })
      expect(await Curator.shouldRunNow(tmp.path, { now: NOW })).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // M9: 暂停 / 禁用不跑
  test("does not run when paused", async () => {
    const tmp = await makeTmp()
    try {
      await Curator.saveState(tmp.path, { lastRunAt: ago(8 * DAY), paused: true, runCount: 1 })
      expect(await Curator.shouldRunNow(tmp.path, { now: NOW })).toBe(false)
    } finally {
      await tmp.cleanup()
    }
  })

  test("does not run when disabled", async () => {
    const tmp = await makeTmp()
    try {
      await Curator.saveState(tmp.path, { lastRunAt: ago(8 * DAY), paused: false, runCount: 1 })
      const run = await Curator.shouldRunNow(tmp.path, {
        now: NOW,
        config: { ...DEFAULT_CURATOR_CONFIG, enabled: false },
      })
      expect(run).toBe(false)
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Curator.applyAutomaticTransitions", () => {
  // M10: 扫描补记录 — 扫到无账本记录的 skill → 补一条
  test("seeds a ledger record for an unrecorded in-scope skill", async () => {
    const tmp = await makeTmp()
    try {
      await makeSkill(tmp.path, "proj1", "foo", 0)
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]).toBeDefined()
      expect(data["proj1/foo"]!.location).toBe(path.join(tmp.path, "proj1", "skills", "foo"))
    } finally {
      await tmp.cleanup()
    }
  })

  // M11: 到期归档 (核心接缝, 先停点) — mtime 100 天前 → 移进 archive、archived
  test("archives a skill inactive past archiveAfterDays", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 100 * DAY)
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })

      expect(await exists(dir)).toBe(false)
      expect(await exists(path.join(tmp.path, "proj1", "archive", "foo", "SKILL.md"))).toBe(true)
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("archived")
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Curator.applyAutomaticTransitions — transitions & edges", () => {
  // M12: 标 stale — 40 天没动 → stale (未归档)
  test("marks a skill stale after staleAfterDays", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 40 * DAY)
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("stale")
      expect(await exists(dir)).toBe(true) // not archived
    } finally {
      await tmp.cleanup()
    }
  })

  // M13: 复活 — stale 的 skill 又被用 (last_used_at=now) → 退回 active
  test("reactivates a stale skill that was used recently", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 40 * DAY)
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", dir, { state: "stale", last_used_at: NOW.toISOString() }),
      })
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active")
    } finally {
      await tmp.cleanup()
    }
  })

  // M14: pinned 跳过 (排 M11 后, 防假绿) — pinned 且 100 天没动 → 仍 active
  test("skips pinned skills (never archives them)", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 100 * DAY)
      await writeLedger(tmp.path, { "proj1/foo": record("proj1", "foo", dir, { pinned: true }) })
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active")
      expect(await exists(dir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // M15: 新/刚改不误伤 (排 M11 后, 防假绿) — mtime=今天 → 仍 active
  test("does not archive a fresh skill", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active")
      expect(await exists(dir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // M16: 孤儿自愈 — 账本有记录但目录没了 → 清掉, 不报错
  test("prunes orphan records whose skill dir is gone", async () => {
    const tmp = await makeTmp()
    try {
      const ghost = path.join(tmp.path, "proj1", "skills", "ghost")
      await writeLedger(tmp.path, { "proj1/ghost": record("proj1", "ghost", ghost) })
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/ghost"]).toBeUndefined()
    } finally {
      await tmp.cleanup()
    }
  })

  // M16b: 假孤儿自愈 — 记录 state=active 且原目录没了, 但 archive/ 里有副本
  // (并发覆盖把归档状态刷回 active 造成) → 不能删, 应修回 archived 保住可恢复性
  test("heals a fake orphan (archived copy exists) instead of forgetting it", async () => {
    const tmp = await makeTmp()
    try {
      const loc = path.join(tmp.path, "proj1", "skills", "foo") // 原位置: 已不存在
      const archived = path.join(tmp.path, "proj1", "archive", "foo")
      await fs.mkdir(archived, { recursive: true })
      await fs.writeFile(path.join(archived, "SKILL.md"), "---\nname: foo\n---\n", "utf-8")
      // 账本被并发覆盖后的样子: 状态 active, 但目录已被搬到 archive/
      await writeLedger(tmp.path, { "proj1/foo": record("proj1", "foo", loc, { state: "active" }) })

      const counts = await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })

      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]).toBeDefined() // 没被误删
      expect(data["proj1/foo"]!.state).toBe("archived") // 修回 archived
      expect(counts.healed).toBe(1)
      expect(counts.orphans).toBe(0)
    } finally {
      await tmp.cleanup()
    }
  })

  // M17: 跨项目同名 — 归档 proj1/foo 不影响 proj2/foo (复合键)
  test("handles same-name skills in different projects independently", async () => {
    const tmp = await makeTmp()
    try {
      const dir1 = await makeSkill(tmp.path, "proj1", "foo", 100 * DAY) // → archive
      const dir2 = await makeSkill(tmp.path, "proj2", "foo", 0) // fresh → keep
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })

      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("archived")
      expect(await exists(dir1)).toBe(false)
      expect(data["proj2/foo"]!.state).toBe("active")
      expect(await exists(dir2)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Curator.maybeRun", () => {
  // 到期：跑流转 + 推进 lastRunAt/runCount
  test("runs a pass and advances state when due", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 100 * DAY)
      await Curator.saveState(tmp.path, { lastRunAt: ago(8 * DAY), paused: false, runCount: 1 })

      const counts = await Curator.maybeRun(tmp.path, { now: NOW })
      expect(counts).not.toBeNull()
      expect(counts!.archived).toBe(1)
      expect(await exists(dir)).toBe(false)
      const state = await Curator.loadState(tmp.path)
      expect(state.lastRunAt).toBe(NOW.toISOString())
      expect(state.runCount).toBe(2)
    } finally {
      await tmp.cleanup()
    }
  })

  // 未到期：跳过, 不动 skill
  test("returns null and does nothing when not due", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 100 * DAY)
      await Curator.saveState(tmp.path, { lastRunAt: ago(1 * HOUR), paused: false, runCount: 1 })

      const counts = await Curator.maybeRun(tmp.path, { now: NOW })
      expect(counts).toBeNull()
      expect(await exists(dir)).toBe(true) // untouched
    } finally {
      await tmp.cleanup()
    }
  })
})

// 总开关接力 — 写(config 里的 curator_enabled)→ 读(getCuratorEnabled)→ 跑决定(maybeRun 的真实搬文件结果)
// 必须真让写和读在测验里接力跑一遍, 不手填中间值: 用 spyOn 扮演"用户已在 aether.jsonc 拨好开关",
// 让该值流过 getCuratorEnabled 进到 maybeRun, 断言它真的改变了归档结果。
describe("Curator on/off switch wiring (config → getCuratorEnabled → maybeRun)", () => {
  // 关: 即使过了 7 天间隔、skill 早该归档, 关了就不许搬
  test("a disabled config stops an otherwise-due run (no archive)", async () => {
    const tmp = await makeTmp()
    const spy = spyOn(Config, "get").mockResolvedValue({ skills: { curator_enabled: false } } as any)
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 100 * DAY)
      await Curator.saveState(tmp.path, { lastRunAt: ago(8 * DAY), paused: false, runCount: 1 })

      // 读那头: 写进 config 的 false 必须被 getCuratorEnabled 读出来
      const enabled = await ConfigReader.getCuratorEnabled()
      expect(enabled).toBe(false)

      // 接线: 完全照 hook.ts 构造 config 的方式喂给 maybeRun
      const counts = await Curator.maybeRun(tmp.path, {
        now: NOW,
        config: { ...DEFAULT_CURATOR_CONFIG, enabled },
      })
      expect(counts).toBeNull()
      expect(await exists(dir)).toBe(true) // 没被归档 — 开关被尊重
    } finally {
      spy.mockRestore()
      await tmp.cleanup()
    }
  })

  // 未设(默认开): skill 到期 → 照常归档; 同时验 ?? true 默认值
  test("an unset config defaults to on and lets a due run archive", async () => {
    const tmp = await makeTmp()
    const spy = spyOn(Config, "get").mockResolvedValue({ skills: {} } as any)
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 100 * DAY)
      await Curator.saveState(tmp.path, { lastRunAt: ago(8 * DAY), paused: false, runCount: 1 })

      const enabled = await ConfigReader.getCuratorEnabled()
      expect(enabled).toBe(true) // 没设 → 默认开

      const counts = await Curator.maybeRun(tmp.path, {
        now: NOW,
        config: { ...DEFAULT_CURATOR_CONFIG, enabled },
      })
      expect(counts).not.toBeNull()
      expect(counts!.archived).toBe(1)
      expect(await exists(dir)).toBe(false) // 已归档
    } finally {
      spy.mockRestore()
      await tmp.cleanup()
    }
  })
})
