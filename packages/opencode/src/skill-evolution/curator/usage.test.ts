import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Usage, type UsageRecord } from "./usage"

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

/** Build a ledger record for direct projectUseCount unit tests. */
function rec(projectId: string, name: string, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    projectId,
    id: null,
    name,
    location: `/x/${projectId}/skills/${name}`,
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

// SKILL_IDENTITY_DESIGN.md 里程碑5/6 (根因修复): 账本按 id 认人, 同名先后两个 skill 互不撞。
describe("Usage.bumpUse keys by id (same-name skills don't collide)", () => {
  // C1/B2: 旧 foo 归档后, 同名新 foo (不同 id) 拿到自己独立的账 —— 不撞、旧账冻结、不污染分母。
  test("a re-created same-name skill with a different id gets its own record, not the archived one's", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      // 旧 foo (id=skl_A): 用 2 次 → 归档(按它的 id key)
      await Usage.bumpUse(tmp.path, loc, undefined, undefined, "skl_A")
      await Usage.bumpUse(tmp.path, loc, undefined, undefined, "skl_A")
      await Usage.setState(tmp.path, "proj1/skl_A", "archived")
      // 新 foo (id=skl_B) 在同名位置被用
      await Usage.bumpUse(tmp.path, loc, undefined, undefined, "skl_B")

      const data = await Usage.load(tmp.path)
      expect(data["proj1/skl_A"]).toBeDefined() // 两条独立的账
      expect(data["proj1/skl_B"]).toBeDefined()
      expect(data["proj1/skl_A"]!.state).toBe("archived") // 旧的仍归档
      expect(data["proj1/skl_A"]!.use_count).toBe(2) // 旧的次数冻结, 没被新 foo 顶高(不污染分母)
      expect(data["proj1/skl_B"]!.state).toBe("active") // 新的独立活跃
      expect(data["proj1/skl_B"]!.use_count).toBe(1)
      expect(data["proj1/skl_B"]!.id).toBe("skl_B")
    } finally {
      await tmp.cleanup()
    }
  })

  // bug③: 同一个 id 从改名后的新目录加载 → 刷新 rec.location, 否则 curator 按旧路径误判'目录没了'而抖动
  test("refreshes location when the same id is loaded from a renamed directory", async () => {
    const tmp = await makeTmp()
    try {
      const fooLoc = await makeSkill(tmp.path, "proj1", "foo")
      await Usage.bumpUse(tmp.path, fooLoc, undefined, undefined, "skl_x")
      let data = await Usage.load(tmp.path)
      expect(data["proj1/skl_x"]!.location).toBe(path.join(tmp.path, "proj1", "skills", "foo"))

      // 文件夹改名 foo→bar (id 仍 skl_x), 从新路径加载
      const barLoc = await makeSkill(tmp.path, "proj1", "bar")
      await Usage.bumpUse(tmp.path, barLoc, undefined, undefined, "skl_x")
      data = await Usage.load(tmp.path)
      expect(data["proj1/skl_x"]!.location).toBe(path.join(tmp.path, "proj1", "skills", "bar")) // 刷新成当前路径
    } finally {
      await tmp.cleanup()
    }
  })

  // 兼容: 不传 id(老 skill)→ 仍按名字建 key, 记录 id 字段为 null
  test("falls back to name-keying when no id is given; record id is null", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "bar")
      await Usage.bumpUse(tmp.path, loc) // 无 id
      const data = await Usage.load(tmp.path)
      expect(data["proj1/bar"]).toBeDefined()
      expect(data["proj1/bar"]!.id).toBeNull()
    } finally {
      await tmp.cleanup()
    }
  })

  // 兼容: 老账本记录无 id 字段 → load 回填 null
  test("load backfills a missing id to null on legacy records", async () => {
    const tmp = await makeTmp()
    try {
      const dir = path.join(tmp.path, "curator")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, "usage.json"),
        JSON.stringify({
          "proj1/foo": {
            projectId: "proj1", name: "foo", location: "/x/proj1/skills/foo",
            use_count: 3, born_at_project_total: 0, last_used_at: null, recent_uses: [],
            state: "active", pinned: false, archived_at: null,
          },
        }),
        "utf-8",
      )
      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.id).toBeNull()
    } finally {
      await tmp.cleanup()
    }
  })
})

describe("Usage.projectUseCount", () => {
  // C1: 同一 projectId 下 use_count 求和 (含 archived)，别项目不计入；无记录 → 0
  test("sums same-project use_count including archived, excludes other projects", () => {
    const data = {
      "p1/a": rec("p1", "a", { use_count: 3 }),
      "p1/b": rec("p1", "b", { use_count: 2, state: "archived" }), // archived 的历史调用仍计入 (D6)
      "p2/x": rec("p2", "x", { use_count: 9 }), // 别项目 — 不进 p1 分母
    }
    expect(Usage.projectUseCount(data, "p1")).toBe(5)
    expect(Usage.projectUseCount(data, "p2")).toBe(9)
    expect(Usage.projectUseCount(data, "p3")).toBe(0) // 无该项目记录 → 0 (边界)
  })
})

describe("Usage born_at_project_total (write→read seam)", () => {
  // B2 (写读接缝): 真跑 累加同项目兄弟 → 再创建新 skill → load 读回；不手填出生水位。
  // born 必须 = 创建那刻"本项目"已累计的调用数，且不含别项目的调用。
  test("stamps born = same-project total at creation via bumpUse (not other projects)", async () => {
    const tmp = await makeTmp()
    try {
      const a = await makeSkill(tmp.path, "proj1", "a")
      const b = await makeSkill(tmp.path, "proj1", "b")
      const x = await makeSkill(tmp.path, "proj2", "x")
      // proj1 本项目总数顶到 3+2=5；proj2 单独 9 次 (不该进 proj1 的出生水位)
      for (let i = 0; i < 3; i++) await Usage.bumpUse(tmp.path, a)
      for (let i = 0; i < 2; i++) await Usage.bumpUse(tmp.path, b)
      for (let i = 0; i < 9; i++) await Usage.bumpUse(tmp.path, x)

      // 此刻创建 proj1 的新 skill c —— 出生水位应锁定为 5 (本项目)，与 proj2 的 9 无关
      const c = await makeSkill(tmp.path, "proj1", "c")
      await Usage.bumpUse(tmp.path, c)

      const data = await Usage.load(tmp.path)
      expect(data["proj1/c"]!.born_at_project_total).toBe(5)
      expect(data["proj1/c"]!.use_count).toBe(1)
    } finally {
      await tmp.cleanup()
    }
  })

  // B2b: seedIfMissing 创建路径同样写出生水位 (use_count 仍为 0)
  test("stamps born = same-project total at creation via seedIfMissing", async () => {
    const tmp = await makeTmp()
    try {
      const a = await makeSkill(tmp.path, "proj1", "a")
      for (let i = 0; i < 4; i++) await Usage.bumpUse(tmp.path, a)

      const d = await makeSkill(tmp.path, "proj1", "d")
      await Usage.seedIfMissing(tmp.path, d)

      const data = await Usage.load(tmp.path)
      expect(data["proj1/d"]!.born_at_project_total).toBe(4)
      expect(data["proj1/d"]!.use_count).toBe(0)
    } finally {
      await tmp.cleanup()
    }
  })

  // R1 (墓碑复活): 一个被标 deleted 的记录, 同名 skill 在原位置重建后再被使用 →
  // bumpUse 应把它复活成 active (否则 curator 永远跳过 deleted, 这个真在用的 skill 永世不判)。
  // 关键: use_count 保留 (分母单调, 兄弟的出生水位算过它), 但 born 重盖给一段新的试用期。
  test("revives a tombstoned (deleted) record on reuse: state→active, use_count kept, born re-stamped", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo") // 同名 skill 在原位置重建
      const dir = path.join(tmp.path, "curator")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, "usage.json"),
        JSON.stringify({
          "proj1/foo": {
            projectId: "proj1", name: "foo", location: path.dirname(loc),
            use_count: 5, born_at_project_total: 0, last_used_at: null, recent_uses: [],
            state: "deleted", pinned: false, archived_at: null,
          },
          "proj1/sib": {
            projectId: "proj1", name: "sib", location: "/x/proj1/skills/sib",
            use_count: 10, born_at_project_total: 0, last_used_at: null, recent_uses: [],
            state: "active", pinned: false, archived_at: null,
          },
        }),
        "utf-8",
      )

      await Usage.bumpUse(tmp.path, loc, "ses_reborn")

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]!
      expect(rec.state).toBe("active") // 复活 → curator 不再跳过它
      expect(rec.use_count).toBe(6) // 旧计数保留 (5) + 本次 (1)，不是重置成 1 (保分母单调)
      expect(rec.born_at_project_total).toBe(15) // 重盖 = 复活那刻本项目总数 foo(5)+sib(10) → 新试用期
      expect(rec.recent_uses).toHaveLength(1) // 旧生命的缓存清掉, 只剩本次事件
      expect(rec.recent_uses[0]!.session_id).toBe("ses_reborn")
    } finally {
      await tmp.cleanup()
    }
  })

  // R2 (归档不就地复活): archived 记录的目录已被搬到 archive/。在原位置就地复活会留下
  // 无人认领的归档副本(日后可能把旧内容当正版恢复)→ 复活只管 deleted, 不管 archived。
  test("does NOT revive an archived record in place (avoids orphaning its archive copy)", async () => {
    const tmp = await makeTmp()
    try {
      const loc = await makeSkill(tmp.path, "proj1", "foo")
      const dir = path.join(tmp.path, "curator")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, "usage.json"),
        JSON.stringify({
          "proj1/foo": {
            projectId: "proj1", name: "foo", location: path.dirname(loc),
            use_count: 3, born_at_project_total: 0, last_used_at: null, recent_uses: [],
            state: "archived", pinned: false, archived_at: "2026-01-01T00:00:00.000Z",
          },
        }),
        "utf-8",
      )

      await Usage.bumpUse(tmp.path, loc)

      const data = await Usage.load(tmp.path)
      const rec = data["proj1/foo"]!
      expect(rec.state).toBe("archived") // 未被就地复活 (避免遗留孤立归档副本)
      expect(rec.archived_at).toBe("2026-01-01T00:00:00.000Z") // 保持不变
    } finally {
      await tmp.cleanup()
    }
  })

  // B3 (只写一次): 已存在记录不重算 born —— 老记录回填 0 后，再 bumpUse 也不会被改成当前总数
  test("does not recompute born for an existing record (legacy backfilled 0 stays 0)", async () => {
    const tmp = await makeTmp()
    try {
      const foo = await makeSkill(tmp.path, "proj1", "foo")
      const bar = await makeSkill(tmp.path, "proj1", "bar")
      const dir = path.join(tmp.path, "curator")
      await fs.mkdir(dir, { recursive: true })
      // 老账本：foo 无 born 字段(回填 0)；bar 把本项目总数顶到 4
      await fs.writeFile(
        path.join(dir, "usage.json"),
        JSON.stringify({
          "proj1/foo": {
            projectId: "proj1", name: "foo", location: path.dirname(foo),
            use_count: 5, last_used_at: null, recent_uses: [],
            state: "active", pinned: false, archived_at: null,
          },
          "proj1/bar": {
            projectId: "proj1", name: "bar", location: path.dirname(bar),
            use_count: 4, born_at_project_total: 0, last_used_at: null, recent_uses: [],
            state: "active", pinned: false, archived_at: null,
          },
        }),
        "utf-8",
      )

      await Usage.bumpUse(tmp.path, foo) // foo 已存在 → 不该把 born 改成当前总数(9)

      const data = await Usage.load(tmp.path)
      expect(data["proj1/foo"]!.born_at_project_total).toBe(0) // 回填 0 且未被重算
      expect(data["proj1/foo"]!.use_count).toBe(6)
    } finally {
      await tmp.cleanup()
    }
  })
})
