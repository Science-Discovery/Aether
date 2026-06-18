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
    id: null,
    name,
    location,
    use_count: 0,
    born_at_project_total: 0,
    last_used_at: null,
    recent_uses: [],
    state: "active",
    pinned: false,
    archived_at: null,
    ...over,
  }
}

/**
 * Set up an archivable skill: a target (use_count 0, born 0) plus a same-project
 * sibling carrying `siblingUses` calls. The target's post-birth share is 0 over an
 * exposure of `siblingUses`; with siblingUses ≥ minExposureCalls (default 1000) it
 * is archivable, while the sibling (share 1) is kept. Overwrites the whole ledger.
 * Returns the target skill dir.
 */
async function makeArchivable(root: string, projectId: string, name: string, siblingUses = 1000): Promise<string> {
  const dir = await makeSkill(root, projectId, name, 0)
  const sibDir = await makeSkill(root, projectId, `${name}-sib`, 0)
  await writeLedger(root, {
    [`${projectId}/${name}`]: record(projectId, name, dir, { use_count: 0, born_at_project_total: 0 }),
    [`${projectId}/${name}-sib`]: record(projectId, `${name}-sib`, sibDir, {
      use_count: siblingUses,
      born_at_project_total: 0,
    }),
  })
  return dir
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

})

describe("Curator.applyAutomaticTransitions — transitions & edges", () => {
  // H2: pinned 跳过 (防假绿) — 占比够低本该归档, 但 pinned → 仍 active
  test("skips pinned skills (never archives them even when share is below threshold)", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeArchivable(tmp.path, "proj1", "foo") // 占比 0 / 曝光 1000 → 本该归档
      // 把目标记录改成 pinned (makeArchivable 写的是非 pinned)
      const data0 = await Usage.load(tmp.path)
      data0["proj1/foo"]!.pinned = true
      await writeLedger(tmp.path, data0)

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active") // pinned → 跳过
      expect(await exists(dir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // M16: 真孤儿 → 标 deleted (墓碑), 保留记录与计数, 不报错; 再跑一次不重复处理
  test("tombstones an orphan record (deleted) instead of removing it, and is idempotent", async () => {
    const tmp = await makeTmp()
    try {
      const ghost = path.join(tmp.path, "proj1", "skills", "ghost")
      await writeLedger(tmp.path, { "proj1/ghost": record("proj1", "ghost", ghost, { use_count: 3 }) })

      const counts = await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/ghost"]).toBeDefined() // 记录保留, 不删
      expect(data["proj1/ghost"]!.state).toBe("deleted")
      expect(counts.orphans).toBe(1)

      // 再跑一次: deleted 记录被跳过, 不再重复处理 (orphans 不再涨)
      const counts2 = await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })
      expect(counts2.orphans).toBe(0)
    } finally {
      await tmp.cleanup()
    }
  })

  // bug①: 孤儿清理不能破坏分母单调性。forget 删记录会把它的 use_count 从本项目总数抹掉,
  // 害得别的 skill 的出生水位对不上、曝光量算负 → 永远判不到。改成标 deleted 保留计数。
  test("orphan cleanup keeps the forgotten skill's use_count in the project total (monotonic denominator)", async () => {
    const tmp = await makeTmp()
    try {
      // bbb 在磁盘上 (活着); aaa 没有目录 (被外部删掉) 且 archive 无副本 → 真孤儿
      const bDir = await makeSkill(tmp.path, "proj1", "bbb", 0)
      const aGhost = path.join(tmp.path, "proj1", "skills", "aaa") // 故意不建目录
      await writeLedger(tmp.path, {
        "proj1/aaa": record("proj1", "aaa", aGhost, { use_count: 1000, born_at_project_total: 0 }),
        // bbb 出生水位 1000 = 它创建时本项目总数 (含了 aaa 那 1000 次)
        "proj1/bbb": record("proj1", "bbb", bDir, { use_count: 5, born_at_project_total: 1000 }),
      })

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })

      const data = await Usage.load(tmp.path)
      expect(data["proj1/aaa"]).toBeDefined() // 不被删成 undefined
      expect(data["proj1/aaa"]!.state).toBe("deleted")
      // 关键不变量: aaa 的 1000 仍在本项目总数里 → 分母不回退, bbb 的曝光量 = 1005-1000 = 5 (不会变负)
      expect(Usage.projectUseCount(data, "proj1")).toBe(1005)
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

  // M17: 跨项目同名 — 按占比归档 proj1/foo 不影响 proj2/foo (复合键 + 项目隔离分母)
  test("handles same-name skills in different projects independently", async () => {
    const tmp = await makeTmp()
    try {
      const dir1 = await makeSkill(tmp.path, "proj1", "foo", 0) // proj1: 占比 0 → archive
      const sib1 = await makeSkill(tmp.path, "proj1", "sib", 0)
      const dir2 = await makeSkill(tmp.path, "proj2", "foo", 0) // proj2: 占比 1 → keep
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", dir1, { use_count: 0, born_at_project_total: 0 }),
        "proj1/sib": record("proj1", "sib", sib1, { use_count: 1000, born_at_project_total: 0 }),
        "proj2/foo": record("proj2", "foo", dir2, { use_count: 1000, born_at_project_total: 0 }),
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
})

describe("Curator.applyAutomaticTransitions — concurrency", () => {
  // 路1 并发安全: 整理期间并发的 bumpUse 不被最后的写盘冲掉。
  // 用 spy 在 curator 读完账本后立刻注入一次 bumpUse(bar)(模拟并发的 skill 加载),
  // 断言整理结束后 bar 的次数仍是被加过的值。旧的"整本覆盖写"会把它盖回去 → 红。
  test("does not clobber a concurrent bumpUse that lands during the sweep", async () => {
    const tmp = await makeTmp()
    let spy: ReturnType<typeof spyOn> | undefined
    try {
      const aaaDir = await makeSkill(tmp.path, "proj1", "aaa", 0) // 占比 0 → 会被归档
      const sibDir = await makeSkill(tmp.path, "proj1", "sib", 0)
      const barDir = await makeSkill(tmp.path, "proj1", "bar", 0) // 不归档, 会被并发 bump
      await writeLedger(tmp.path, {
        "proj1/aaa": record("proj1", "aaa", aaaDir, { use_count: 0, born_at_project_total: 0 }),
        "proj1/sib": record("proj1", "sib", sibDir, { use_count: 1000, born_at_project_total: 0 }),
        "proj1/bar": record("proj1", "bar", barDir, { use_count: 5, born_at_project_total: 0 }),
      })

      const realLoad = Usage.load
      let injected = false
      spy = spyOn(Usage, "load").mockImplementation(async (root: string) => {
        const data = await realLoad(root)
        if (!injected) {
          injected = true
          await Usage.bumpUse(tmp.path, barDir) // 并发: bar 5 → 6, 写盘
        }
        return data
      })

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: DEFAULT_CURATOR_CONFIG })
      spy.mockRestore()
      spy = undefined

      const data = await Usage.load(tmp.path)
      expect(data["proj1/bar"]!.use_count).toBe(6) // 并发的 +1 必须留住, 不被整本覆盖回 5
      expect(data["proj1/aaa"]!.state).toBe("archived") // 整理本身照常完成
    } finally {
      spy?.mockRestore()
      await tmp.cleanup()
    }
  })
})

describe("Curator.maybeRun", () => {
  // 到期：跑流转 + 推进 lastRunAt/runCount
  test("runs a pass and advances state when due", async () => {
    const tmp = await makeTmp()
    try {
      const dir = await makeArchivable(tmp.path, "proj1", "foo") // 占比 0 / 曝光 1000 → 该归档
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
      const dir = await makeArchivable(tmp.path, "proj1", "foo") // 本该按占比归档
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
      expect(await exists(dir)).toBe(true) // 本该归档却没动 — 开关被尊重
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
      const dir = await makeArchivable(tmp.path, "proj1", "foo") // 占比 0 / 曝光 1000 → 该归档
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

// 占比判据 (RELATIVE_USAGE_DESIGN.md): 归档 = 出生后"本项目"调用占比 < 阈值，且出生后曝光量已过试用期窗口。
// 写一个 record + 真实 skill 目录的 fixture，让 applyAutomaticTransitions 按占比判，断言搬不搬目录。
describe("Curator.applyAutomaticTransitions — share-based archival", () => {
  // 里程碑1: 占比低于阈值 → 归档。foo mtime=今天，旧按天数判据不会归档它 → 改前应红。
  test("archives a skill whose post-birth call share is below archiveUsageShare", async () => {
    const tmp = await makeTmp()
    try {
      const fooDir = await makeSkill(tmp.path, "proj1", "foo", 0) // 今天刚改 → 旧判据留它
      const sibDir = await makeSkill(tmp.path, "proj1", "sib", 0)
      // 同项目: foo 0 次 / sib 1000 次 → 本项目总数 1000, foo 出生水位 0 → 曝光 1000, 占比 0
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", fooDir, { use_count: 0, born_at_project_total: 0 }),
        "proj1/sib": record("proj1", "sib", sibDir, { use_count: 1000, born_at_project_total: 0 }),
      })

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: DEFAULT_CURATOR_CONFIG })

      expect(await exists(fooDir)).toBe(false)
      expect(await exists(path.join(tmp.path, "proj1", "archive", "foo", "SKILL.md"))).toBe(true)
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("archived")
      // sib 占比 1000/1000 = 1 → 留
      expect(data["proj1/sib"]!.state).toBe("active")
      expect(await exists(sibDir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // 里程碑2 (M2 不删末位): 5 个 skill 各占 1/5 → 占比都在阈值之上 → 一个都不归档
  test("archives none when every share is above threshold (no last-place delete)", async () => {
    const tmp = await makeTmp()
    try {
      const led: Record<string, UsageRecord> = {}
      for (const n of ["a", "b", "c", "d", "e"]) {
        const dir = await makeSkill(tmp.path, "proj1", n, 0)
        led[`proj1/${n}`] = record("proj1", n, dir, { use_count: 200, born_at_project_total: 0 })
      }
      await writeLedger(tmp.path, led)

      const counts = await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: DEFAULT_CURATOR_CONFIG })
      expect(counts.archived).toBe(0) // 本项目总数 1000, 各占 0.2 ≥ 0.001 → 都留
      const data = await Usage.load(tmp.path)
      for (const n of ["a", "b", "c", "d", "e"]) expect(data[`proj1/${n}`]!.state).toBe("active")
    } finally {
      await tmp.cleanup()
    }
  })

  // 里程碑3 (出生窗口保护): 出生后曝光量 < minExposureCalls → 不判, 哪怕占比 0。
  // 漏掉窗口闸门会误归档它 → 实现时若先不加窗口应红。
  test("protects a newborn skill within its trial window (exposure < minExposureCalls)", async () => {
    const tmp = await makeTmp()
    try {
      const fooDir = await makeSkill(tmp.path, "proj1", "foo", 0)
      const sibDir = await makeSkill(tmp.path, "proj1", "sib", 0)
      // 本项目总数 50300, foo 出生水位 50000 → 曝光 = 300 < 1000 → 试用期未满
      await writeLedger(tmp.path, {
        "proj1/foo": record("proj1", "foo", fooDir, { use_count: 0, born_at_project_total: 50000 }),
        "proj1/sib": record("proj1", "sib", sibDir, { use_count: 50300, born_at_project_total: 0 }),
      })

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: DEFAULT_CURATOR_CONFIG })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active") // 窗口保护
      expect(await exists(fooDir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // 里程碑4 (项目隔离, 复现用户反例): 别项目猛跑不该稀释本项目里好 skill 的占比。
  test("project-isolated denominator — a busy other project does not dilute this one", async () => {
    const tmp = await makeTmp()
    try {
      const aFoo = await makeSkill(tmp.path, "projA", "foo", 0)
      const aSib = await makeSkill(tmp.path, "projA", "sib", 0)
      const bBusy = await makeSkill(tmp.path, "projB", "busy", 0)
      await writeLedger(tmp.path, {
        "projA/foo": record("projA", "foo", aFoo, { use_count: 5, born_at_project_total: 0 }),
        "projA/sib": record("projA", "sib", aSib, { use_count: 995, born_at_project_total: 0 }),
        "projB/busy": record("projB", "busy", bBusy, { use_count: 50000, born_at_project_total: 0 }),
      })

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: DEFAULT_CURATOR_CONFIG })
      const data = await Usage.load(tmp.path)
      // projA 本项目总数 = 1000, foo 占比 5/1000 = 0.005 ≥ 0.001 → 留
      // (全局分母会算成 5/51000 ≈ 0.0001 → 被冲到归档, 正是本次要避免的)
      expect(data["projA/foo"]!.state).toBe("active")
      expect(await exists(aFoo)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // 里程碑5 (出生水位写读接力): 真跑 创建 → 同项目累加 → 判 三步, 不手填 born。
  // 用小配置 (窗口 3 / 阈值 0.5) 避免上千次 bumpUse, 逻辑同默认值。
  const SMALL = { ...DEFAULT_CURATOR_CONFIG, minExposureCalls: 3, archiveUsageShare: 0.5 }

  test("relay: a newborn left unused IS archived once post-birth exposure passes the window", async () => {
    const tmp = await makeTmp()
    try {
      const fillerDir = await makeSkill(tmp.path, "proj1", "filler", 0)
      const newDir = await makeSkill(tmp.path, "proj1", "newbie", 0)
      // 先把本项目顶到 3 → 创建 newbie (出生水位锁 3) → 再顶 3 (newbie 曝光 = 6-3 = 3 ≥ 3)
      for (let i = 0; i < 3; i++) await Usage.bumpUse(tmp.path, fillerDir)
      await Usage.seedIfMissing(tmp.path, newDir) // newbie 出生: born=3, use_count=0
      for (let i = 0; i < 3; i++) await Usage.bumpUse(tmp.path, fillerDir)

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: SMALL })

      const data = await Usage.load(tmp.path)
      // newbie: 曝光 3 ≥ 3, 占比 0/3 = 0 < 0.5 → 归档
      expect(data["proj1/newbie"]!.state).toBe("archived")
      expect(await exists(newDir)).toBe(false)
      // filler: 出生水位 0, 曝光 6, 占比 6/6 = 1 → 留
      expect(data["proj1/filler"]!.state).toBe("active")
    } finally {
      await tmp.cleanup()
    }
  })

  test("relay: the same newborn is protected while still inside the window (one fewer post-birth call)", async () => {
    const tmp = await makeTmp()
    try {
      const fillerDir = await makeSkill(tmp.path, "proj1", "filler", 0)
      const newDir = await makeSkill(tmp.path, "proj1", "newbie", 0)
      for (let i = 0; i < 3; i++) await Usage.bumpUse(tmp.path, fillerDir)
      await Usage.seedIfMissing(tmp.path, newDir) // born=3
      for (let i = 0; i < 2; i++) await Usage.bumpUse(tmp.path, fillerDir) // 只加 2

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: SMALL })

      const data = await Usage.load(tmp.path)
      // newbie: 曝光 = 5-3 = 2 < 3 → 试用期未满 → 不判
      expect(data["proj1/newbie"]!.state).toBe("active")
      expect(await exists(newDir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })

  // H1 边界: 空账本 / 本项目总数为 0 → 曝光 ≤ 0, 试用期闸门拦下, 不归档、不抛
  test("edge: empty/zero-total project archives nothing and does not throw", async () => {
    const tmp = await makeTmp()
    try {
      const fooDir = await makeSkill(tmp.path, "proj1", "foo", 0)
      // 唯一 skill, use_count 0, 出生水位 0 → 本项目总数 0, 曝光 0 < 1000
      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW, config: DEFAULT_CURATOR_CONFIG })
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.state).toBe("active")
      expect(await exists(fooDir)).toBe(true)
    } finally {
      await tmp.cleanup()
    }
  })
})

// SKILL_IDENTITY_DESIGN.md bug②: curator 必须和加载器用同一个解析器读 id, 否则非规范 id 两边读不一致 → split-brain。
describe("Curator scanSkills reads id consistently with the loader", () => {
  test("uses the YAML parser (not a regex) so a non-canonical id keys the same as the loader", async () => {
    const tmp = await makeTmp()
    try {
      const dir = path.join(tmp.path, "proj1", "skills", "foo")
      await fs.mkdir(dir, { recursive: true })
      // 无引号 + 行尾注释: YAML 实际 id = "skl_x"; 手写正则会误抠成 "skl_x # note"
      await fs.writeFile(path.join(dir, "SKILL.md"), `---\nid: skl_x # note\nname: foo\ndescription: test\n---\nBody\n`, "utf-8")

      await Curator.applyAutomaticTransitions(tmp.path, { now: NOW })

      const data = await Usage.load(tmp.path)
      expect(data["proj1/skl_x"]).toBeDefined() // 按 YAML 真实 id 建 key
      expect(data["proj1/skl_x"]!.id).toBe("skl_x")
      expect(data["proj1/skl_x # note"]).toBeUndefined() // 不是正则误抠出来的那个
    } finally {
      await tmp.cleanup()
    }
  })
})
