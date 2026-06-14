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
    use_count_at_last_scan: 0,
    idle_scans: 0,
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

  // N1: 连续 N 次空闲才归档 (核心接缝, 先停点) — 真连跑多次巡检、use_count 不增长 → 第 N 次移进 archive。
  // 证明「上一轮写 use_count_at_last_scan → 下一轮读它判增长」这条写读接力跑得通 (不手填中间 idle_scans)。
  test("archives a skill after archiveAfterIdleScans consecutive idle scans", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      const ARCHIVE = DEFAULT_CURATOR_CONFIG.archiveAfterIdleScans // 12
      // 第 1 次巡检只建基线 (不判)，之后每次没被用 idle_scans+1。前 ARCHIVE 次 (含建基线) 都不该归档。
      for (let i = 0; i < ARCHIVE; i++) {
        await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
        expect(await exists(dir)).toBe(true)
        const mid = await Usage.load(tmp.path)
        expect(mid["proj1/foo"]!.state).not.toBe("archived")
      }
      // 第 ARCHIVE+1 次：idle_scans 达阈值 → 归档
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
  // N2: 中途被用清零 — 攒了几次空闲后真被用一次 (bumpUse 写 use_count) → idle_scans 归 0、未归档。
  // 写(bumpUse 增 use_count)读(applyAutomaticTransitions 判增长)在测验里接力跑, 不手填中间值。
  test("resets idle_scans to 0 when used midway (no archive)", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      const loc = path.join(dir, "SKILL.md")
      // 攒几次空闲 (1 次建基线 + 2 次累加 → idle_scans=2)
      for (let i = 0; i < 3; i++) await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      expect((await Usage.load(tmp.path))["proj1/foo"]!.idle_scans).toBeGreaterThan(0)

      await Usage.bumpUse(tmp.path, loc) // 真被用一次
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })

      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.idle_scans).toBe(0)
      expect(data["proj1/foo"]!.state).toBe("active")
      expect(await exists(dir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // N3: 标 stale — 连跑 staleAfterIdleScans 次未用 → stale (未到归档阈值, 文件还在)
  test("marks a skill stale after staleAfterIdleScans idle scans", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      const STALE = DEFAULT_CURATOR_CONFIG.staleAfterIdleScans // 4
      // 1 次建基线 + STALE 次累加 → idle_scans 达 STALE
      for (let i = 0; i <= STALE; i++) await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("stale")
      expect(await exists(dir)).toBe(true) // 未归档
    } finally {
      await tmp.cleanup()
    }
  })

  // N4: stale 复活 — stale 后真被用一次 (bumpUse 增 use_count) → 退回 active、idle_scans 清零
  test("reactivates a stale skill that was used since last scan", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      const loc = path.join(dir, "SKILL.md")
      // 预置: 已 stale, 上轮基线 use_count_at_last_scan=2, idle_scans=5
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", dir, {
          state: "stale",
          use_count: 2,
          use_count_at_last_scan: 2,
          idle_scans: 5,
        }),
      })
      await Usage.bumpUse(tmp.path, loc) // 真被用一次: use_count 2→3
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })

      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active") // 复活
      expect(data["proj1/foo"]!.idle_scans).toBe(0) // 清零
    } finally {
      await tmp.cleanup()
    }
  })

  // N5: pinned 跳过 (排 N1 后, 防假绿) — idle_scans 预置超阈值 → pinned 仍 active、不归档
  test("skips pinned skills even when idle_scans is over the threshold", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      await writeLedger(tmp.path, { "proj1/foo": record("proj1", "foo", dir, { pinned: true, idle_scans: 99 }) })
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active")
      expect(await exists(dir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // N6: 旧账本缺字段不误删 (排 N1 后, 防假绿) — 无 idle_scans/use_count_at_last_scan 的旧记录 → 首次跑只建基线
  test("does not archive a legacy record missing the new fields (seeds baseline)", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      // 旧账本: 故意省掉两个新字段 (绕过 record() 工厂, 模拟升级前落盘的记录)
      await writeLedger(tmp.path, {
        "proj1/foo": {
          projectId: "proj1",
          name: "foo",
          location: dir,
          use_count: 3,
          last_used_at: null,
          state: "active",
          pinned: false,
          archived_at: null,
        } as unknown as UsageRecord,
      })
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active") // 没被误删
      expect(data["proj1/foo"]!.idle_scans).toBe(0) // 补了基线
      expect(data["proj1/foo"]!.use_count_at_last_scan).toBe(3) // 基线=当前 use_count
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

  // N7: 跨项目同名各算各 — proj1/foo 攒满阈值、proj2/foo idle_scans=0 → 仅 proj1/foo 归档 (复合键独立累加)
  test("handles same-name skills in different projects independently", async () => {
    const tmp = await makeTmp()
    try {
      const dir1 = await makeSkill(tmp.path, "proj1", "foo", 0)
      const dir2 = await makeSkill(tmp.path, "proj2", "foo", 0)
      // proj1/foo 预置到差一步归档 (跑一次 → 12 → archive), proj2/foo 全新
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", dir1, {
          idle_scans: DEFAULT_CURATOR_CONFIG.archiveAfterIdleScans - 1,
        }),
        "proj2/foo": record("proj2", "foo", dir2, { idle_scans: 0 }),
      })
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

  // N8: 系统时间跳变不成片误删 (顾虑2) — now 从 2026 跳到 2099, idle_scans 仍只 +1, 不归档。
  // 判据里零日历依赖: 旧版"按天算"会 (2099-2026)≈26512 天 ≫ 90 天 → 立刻误删; 新版只 +1。
  test("a system-clock jump does not mass-archive (criterion ignores the calendar)", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW }) // 建基线
      const FUTURE = new Date("2099-01-01T00:00:00.000Z")
      await Curator.applyAutomaticTransitions(tmp.path, { now: FUTURE }) // 系统时间跳到 2099
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.idle_scans).toBe(1) // 只 +1, 没被时间跳变放大
      expect(data["proj1/foo"]!.state).toBe("active") // 没归档
      expect(await exists(dir)).toBe(true)
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
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      // 预置到差一步归档 → 这一次到期的巡检把它归档
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", dir, { idle_scans: DEFAULT_CURATOR_CONFIG.archiveAfterIdleScans - 1 }),
      })
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
      const dir = await makeSkill(tmp.path, "proj1", "foo", 0)
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", dir, { idle_scans: DEFAULT_CURATOR_CONFIG.archiveAfterIdleScans - 1 }),
      })
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
