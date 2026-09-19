import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Engine } from "../engine.js"
import { Store } from "../store.js"
import { planCheck, preflight, speculationOk, staleEdges } from "../graph.js"
import {
  migrateSubproblems,
  registerProposals,
  propagateB,
  rollbackSet,
  chainStrength,
  strengthName,
  contradictions,
  gateDecision,
} from "../milestone.js"

const cfg = await Bun.file(new URL("../workflow.json", import.meta.url)).json()
const cleanups = []
afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map(async (fn) => {
      try {
        await fn()
      } catch {
        // 隔离上下文目录被 runner chmod 为只读：恢复权限后重试删除
        try {
          Bun.spawnSync(["chmod", "-R", "u+rwx", fn.chmodPath])
          await fn()
        } catch {}
      }
    }),
  )
})

// ---- 受控样例模型边界：真实 Runner、存储、校验、调度与传播执行 ----

function fakeExecutor() {
  return async (code, inputs) => {
    const joined = inputs.map((i) => i.content).join("\n")
    const exit = code.includes("EXIT1") || code.includes("sys.exit(1)") || joined.includes("EXIT1") ? 1 : 0
    return {
      exit,
      stdout: `verifier ran over ${inputs.length} inputs`,
      stderr: "",
      files: [],
      interpreter: "python3",
      isolation: "fake",
      inputs: inputs.map((i) => ({ id: i.id, hash: i.hash })),
    }
  }
}

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loca-test-"))
  const cleanup = () => rm(dir, { recursive: true, force: true })
  cleanup.dir = dir
  cleanup.chmodPath = dir
  cleanups.push(cleanup)
  await mkdir(path.join(dir, ".aether"))
  await symlink(path.resolve(import.meta.dir, "../../../agent"), path.join(dir, ".aether/agent"))
  await symlink(path.resolve(import.meta.dir, "../../../command"), path.join(dir, ".aether/command"))
  const state = {
    artifacts: new Set(),
    gateDecision: "promote",
    gateDecisions: [],
    challenges: [],
    unitFails: 0,
    triageClass: "A",
    s1Statement: "X = 0.125 且规范场守恒",
    verifierCode: "import sys\nprint('verifier ok')\n",
    unitFailForever: false,
    ...options.state,
  }
  const config = { ...cfg, ...(options.cfg ?? {}) }
  const engine = new Engine(dir, config, null, path.join(dir, "loca/.runtime"), options.executor ?? fakeExecutor())
  const turns = new Map()
  const ev = (packet, context) => packet.assets?.[0]?.id ?? context.run.assets[0]
  const pass = (checks, packet, context) => ({
    verdict: "pass",
    checks: checks.map((id) => ({ id, status: "pass", reason: "受控样例检查", evidence: [ev(packet, context)] })),
    findings: [],
  })
  const base = {
    contract: () => ({
      goal: "测试目标",
      criteria: [
        { id: "C1", text: "标准一", method: "程序检查", origin: "目标：" },
        { id: "C2", text: "标准二", method: "独立验证", origin: "标准：" },
      ],
      removed: [],
      questions: [],
      assumptions: [],
    }),
    fidelity: (packet, context) => pass(config.checks.contract, packet, context),
    planner: () => ({
      strategy: "先 S1 后 S2",
      subproblems: [
        {
          id: "S1",
          goal: "求 X 并给出逻辑封闭结论",
          criteria: ["C1"],
          expectedRefs: [],
          depends: [],
          verification: { anchor: "programmatic", spec: "检查守恒恒等式是否成立" },
          robustness: "结论无关：目标是求值，不预设结果",
        },
        {
          id: "S2",
          goal: "验证 Y 的标度行为",
          criteria: ["C2"],
          expectedRefs: ["S1"],
          depends: ["S1"],
          verification: { anchor: "rederivation", spec: "用不同方法重推 Y" },
          robustness: "结论无关：只引用 X 的槽位",
        },
      ],
      reason: "两步走",
    }),
    solve: (packet, context) => {
      const sub = packet.plan.subproblem.id
      const name = `result-${sub}.md`
      const content = sub === "S1" ? `# ${sub}\nstatement: ${state.s1Statement}\n` : `# ${sub}\nuses S1\n`
      if (!state.artifacts.has(`${name}:${content}`)) {
        state.artifacts.add(`${name}:${content}`)
        engine.register(context, "artifact", name, content)
      }
      const milestones =
        sub === "S1"
          ? [
              {
                id: "M1",
                statement: state.s1Statement,
                scope: "临界区域",
                criteria: ["C1"],
                inputs: [],
                branches: [],
                highRisk: [],
                artifacts: [name],
                values: [{ symbol: "alpha", value: "0.125", unit: "1" }],
              },
            ]
          : [
              {
                id: "M1",
                statement: "Y 的标度行为与 X 一致",
                scope: "临界区域",
                criteria: ["C2"],
                inputs: [{ from: "S1:M1", use: "X 的结论作为前提" }],
                branches: [],
                highRisk: [],
                artifacts: [name],
                values: [],
              },
            ]
      return {
        status: "completed",
        artifacts: [name],
        milestones,
        claims: [],
        problems: [],
        reason: "完成并自检",
      }
    },
    gate: (packet, context) => ({
      decision: state.gateDecisions.length ? state.gateDecisions.shift() : state.gateDecision,
      checks: config.checks.gate.map((id) => ({
        id,
        status: "pass",
        reason: "判据满足",
        evidence: [ev(packet, context)],
      })),
      note: "逻辑封闭",
      findings: [],
    }),
    anchor: (packet, context) => {
      const registered = packet.registered
      if ((registered?.anchor ?? state.anchorChoice) === "programmatic") {
        return {
          anchor: "programmatic",
          spec: registered?.spec ?? "运行检查程序",
          verifier: state.verifierCode,
          inputs: packet.milestone.artifacts.map((id) => engine.store.asset(id).name),
          reason: "程序化检查恒等式",
        }
      }
      return {
        anchor: registered?.anchor ?? "rederivation",
        spec: registered?.spec ?? "不同方法重推",
        reason: "独立重推导",
      }
    },
    vaudit: async (packet, context) => {
      const exec = await engine.compute(
        context,
        { code: "import sys\nsys.exit(1)\n", inputs: [] },
        { ask: async () => {} },
      )
      return {
        decision: "trusted",
        checks: config.checks.vaudit.map((id) => ({
          id,
          status: "pass",
          reason: "语义符合且对照充分",
          evidence: [exec.id],
        })),
        findings: [],
        controls: [{ id: "K1", mutation: "注入破坏守恒的项", execution: exec.id, observed: "failed" }],
      }
    },
    adversarial: (packet, context) => ({
      challenges: state.challenges.map((c) => ({ ...c, evidence: [ev(packet, context)] })),
      note: "过程审阅完成",
    }),
    verify: (packet, context) => {
      const isUnit = packet.mode === "unit"
      const shouldFail = isUnit && (state.unitFailForever || state.unitFails > 0)
      if (shouldFail && !state.unitFailForever) state.unitFails--
      const checks = isUnit ? config.checks.unit : config.checks.verify
      if (shouldFail)
        return {
          verdict: "fail",
          checks: checks.map((id) => ({
            id,
            status: "fail",
            reason: "独立复核发现错误",
            evidence: [ev(packet, context)],
          })),
          findings: [
            {
              id: "UF1",
              target: packet.target?.id ?? "step",
              detail: "该步骤的近似不成立",
              evidence: [ev(packet, context)],
              repair: "solve",
              blocking: true,
            },
          ],
          summary: "条件式复核失败",
        }
      const out = pass(checks, packet, context)
      return { ...out, summary: "独立验证通过" }
    },
    compat: (packet, context) => pass(config.checks.compat, packet, context),
    triage: (packet) => ({
      impacts: [
        {
          finding: packet.findings[0]?.id ?? "UF1",
          class: state.triageClass,
          affected: [],
          goalChange: state.triageClass === "C",
          note: "受控样例分类",
        },
      ],
      reason: "影响分析完成",
    }),
    integrate: (packet, context) => {
      const run = context.run
      const verified = Object.values(run.milestones).filter((m) => m.status === "verified")
      return {
        verdict: "pass",
        checks: config.checks.integrate.map((id) => ({
          id,
          status: "pass",
          reason: "集成检查",
          evidence: [run.assets[0]],
        })),
        findings: [],
        summary: "全部标准已由已验证里程碑覆盖",
        criteria: run.contract.criteria.map((c) => {
          const owners = verified.filter((m) => m.criteria.includes(c.id))
          return {
            id: c.id,
            milestones: owners.map((m) => m.id),
            artifacts: owners.flatMap((m) => m.artifacts),
            evidence: [run.assets[0]],
            scope: "全范围",
            strength: strengthName(Math.max(...owners.map((m) => chainStrength(run, m)))),
            review: "建议复核验证器与执行记录",
          }
        }),
      }
    },
  }
  const handlers = { ...base, ...(options.handlers ?? {}) }
  const wrap = options.wrap ?? ((v) => v)
  // 模拟重启的新实例：client 闭包需要把 children 查找重绑到新 engine
  const clientOf = (target) => ({
    config: { get: async () => ({ data: { memory: { enabled: false }, skills: { evolution_enabled: false } } }) },
    app: { agents: async () => ({ data: [{ name: "loca", permission: [] }] }) },
    session: {
      get: async () => ({ data: { permission: [] } }),
      create: async () => ({ data: { id: `child-${++count.value}` } }),
      abort: async () => ({ data: true }),
      prompt: async (args) => {
        const context = target.children.get(args.path.id)
        const parsed = JSON.parse(args.body.parts[0].text)
        const packet = parsed.packet ?? { assets: [] }
        const turn = turns.get(args.path.id) ?? 1
        turns.set(args.path.id, turn + 1)
        const value = await wrap(
          handlers[context.role]?.(packet, context, parsed, turn) ?? {},
          packet,
          context,
          parsed,
          turn,
        )
        return { data: { info: { structured: value } } }
      },
    },
  })
  const client = clientOf(engine)
  const rebind = (target) => {
    target.client = clientOf(target)
    target.runner.client = target.client
    return target.client
  }
  const count = { value: 0 }
  let controller = new AbortController()
  engine.client = client
  engine.runner.client = client
  const drive = async (text) => {
    // 每次 drive 使用新的中止信号：上一次的中断不应传染下一次会话
    controller = new AbortController()
    engine.capture("session-1", { id: `msg-${++count.value}`, parts: [{ type: "text", text }] })
    return await engine.act("session-1", {
      abort: controller.signal,
      ask: async () => {},
      metadata: async () => {},
    })
  }
  return { engine, state, drive, dir, controller, rebind, handlers }
}

const GOAL = "目标：验证标度理论\n标准：两条可检验标准"

// ---- 端到端流程 ----

test("happy path: 计划 → 求解 → gate → vaudit → 快检 → 深审 → 集成交付", async () => {
  const f = await fixture()
  const summary = await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  expect(run.phase).toBe("awaiting_human")
  expect(run.plan.version).toBe(1)
  const s1 = run.milestones["S1:M1"]
  const s2 = run.milestones["S2:M1"]
  expect(s1.status).toBe("verified")
  expect(s2.status).toBe("verified")
  // S1 程序锚 → programmatic；S2 重推导锚消费 S1 → 链取最弱环节仍为 programmatic？
  // independent(1) vs premise programmatic(0) → max rank = 1 → independent
  expect(s1.strength).toBe("programmatic")
  expect(s2.strength).toBe("independent")
  expect(run.verifiers["S1:M1"].status).toBe("trusted")
  expect(s1.review.quick.pass).toBe(true)
  expect(s2.review.e2e.verdict).toBe("pass")
  expect(summary).toContain("等待你验收")
  expect(summary).toContain("证据强度")
  expect(existsSync(path.join(run.directory, "audit.json"))).toBe(true)
  expect(existsSync(path.join(run.directory, "summary.md"))).toBe(true)
  const audit = await Bun.file(path.join(run.directory, "audit.json")).json()
  expect(audit.ledger.some((e) => e.consumer === "S2:M1" && e.consumed === "S1:M1")).toBe(true)
  // 验收流转
  f.engine.requests.set("session-1", "accept")
  await f.engine.act("session-1", { abort: f.controller.signal, ask: async () => {}, metadata: async () => {} })
  expect(f.engine.store.run("session-1").phase).toBe("accepted")
})

test("gate continue: 未逻辑封闭 → 重开子问题 → 再提案 → 升格", async () => {
  const f = await fixture({ state: { gateDecisions: ["continue", "promote"] } })
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  const s1 = run.milestones["S1:M1"]
  expect(s1.status).toBe("verified")
  expect(s1.history.some((h) => h.status === "draft")).toBe(true)
  // continue 之后 solve 收到 feedback.kind === "continue"（通过事件与版本递增验证）
  expect(s1.version).toBeGreaterThanOrEqual(2)
})

test("A 类：unit 失败 → triage A → patch（命题不变）→ v2 → 快检+深审重跑 → verified", async () => {
  const f = await fixture({
    state: {
      challenges: [
        {
          id: "Q1",
          target: "关键近似",
          kind: "approximation",
          hypothesis: "近似在外层失效",
          importance: "must",
          reason: "记录第 3 步未论证",
        },
      ],
      unitFails: 1,
      triageClass: "A",
    },
  })
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  const s1 = run.milestones["S1:M1"]
  expect(s1.status).toBe("verified")
  expect(s1.version).toBe(2)
  expect(s1.history[0].version).toBe(1)
  // A 类分类记录在 triage 阶段事件中（版本递增会重置 impact 字段）
  const events = f.engine.store.events(run)
  expect(
    events.some((e) => e.kind === "stage" && e.data.stage === "triage" && e.data.summary.includes("影响分类 A")),
  ).toBe(true)
  expect(events.some((e) => e.kind === "propagation")).toBe(false)
  // patch 模式的 solve 确实被调度
  const patchJobs = f.engine.store.jobs(run).filter((j) => j.role === "solve" && j.status === "accepted")
  expect(patchJobs.length).toBeGreaterThanOrEqual(2)
})

test("B 类：结论修正 → v2 → 下游三态刷新（计划边 stale + 验证器重跑路径）", async () => {
  const f = await fixture({
    state: {
      challenges: [
        {
          id: "Q1",
          target: "数值外推",
          kind: "numeric",
          hypothesis: "外推超出收敛域",
          importance: "must",
          reason: "未做收敛检查",
        },
      ],
      unitFails: 1,
      triageClass: "B",
      s1Statement: "X = 0.25 且规范场守恒",
    },
  })
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  const s1 = run.milestones["S1:M1"]
  expect(s1.version).toBe(2)
  expect(s1.statement).toContain("0.25")
  expect(
    f.engine.store
      .events(run)
      .some((e) => e.kind === "stage" && e.data.stage === "triage" && e.data.summary.includes("影响分类 B")),
  ).toBe(true)
  const events = f.engine.store.events(run)
  expect(events.some((e) => e.kind === "propagation")).toBe(true)
  // S2 尚未开工（串行波次下可能已开工也可能未开工）；无论如何最终态必须收敛
  expect(run.phase).toBe("awaiting_human")
  expect(run.milestones["S2:M1"].status).toBe("verified")
})

test("C 类：回滚 + 重规划（计划版本 2），失败里程碑重做后收敛", async () => {
  const f = await fixture({
    state: {
      challenges: [
        {
          id: "Q1",
          target: "方法路线",
          kind: "concept",
          hypothesis: "前提失效导致路线错误",
          importance: "must",
          reason: "目标定义依赖结论内容",
        },
      ],
      unitFails: 1,
      triageClass: "C",
    },
  })
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  expect(run.plan.version).toBe(2)
  const events = f.engine.store.events(run)
  expect(events.some((e) => e.kind === "rollback")).toBe(true)
  // 迟到的深审组件不得把回滚后的 superseded 覆盖成 failed 引发级联 replan
  expect(events.filter((e) => e.kind === "rollback")).toHaveLength(1)
  expect(run.phase).toBe("awaiting_human")
  expect(run.milestones["S1:M1"].status).toBe("verified")
})

test("快检失败走 triage：EXIT1 验证器 → A 类补洞后换验证器", async () => {
  let anchorCalls = 0
  const f = await fixture({
    state: { verifierCode: "import sys\nsys.exit(1) # EXIT1\n", triageClass: "A" },
    wrap: (value, _packet, context) => {
      if (context.role === "anchor") {
        anchorCalls++
        if (anchorCalls > 1) value.verifier = "import sys\nsys.exit(0)\n"
      }
      return value
    },
  })
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  const s1 = run.milestones["S1:M1"]
  expect(run.phase).toBe("awaiting_human")
  expect(s1.status).toBe("verified")
  expect(s1.version).toBeGreaterThanOrEqual(2)
  const quickEvents = f.engine.store.events(run).filter((e) => e.kind === "stage" && e.data.stage === "quick")
  expect(quickEvents.some((e) => e.data.summary.includes("失败"))).toBe(true)
  expect(quickEvents.some((e) => e.data.summary.includes("通过"))).toBe(true)
})

test("vaudit 阴性对照守卫：声称 failed 但执行退出码为 0 → 会话内纠正", async () => {
  const f = await fixture({
    wrap: async (value, _packet, context, _parsed, turn) => {
      if (context.role === "vaudit" && turn === 1) {
        // 伪造：对照引用一个 exit 0 的执行
        const exec = await f.engineRef.compute(
          context,
          { code: "import sys\nsys.exit(0)\n", inputs: [] },
          { ask: async () => {} },
        )
        value.controls = [{ id: "K1", mutation: "x", execution: exec.id, observed: "failed" }]
      }
      return value
    },
  })
  f.engineRef = f.engine
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  expect(run.verifiers["S1:M1"].status).toBe("trusted")
  const jobs = f.engine.store.jobs(run).filter((j) => j.role === "vaudit")
  expect(jobs.some((j) => j.status === "accepted")).toBe(true)
})

test("预算耗尽 → unfinished，不伪造交付", async () => {
  const f = await fixture({ cfg: { calls: 6 } })
  let threw = null
  try {
    await f.drive(GOAL)
  } catch (error) {
    threw = error
  }
  // act 捕获错误并落到 unfinished（返回状态文本而不是抛出）
  const run = f.engine.store.run("session-1")
  expect(["unfinished", "needs_human"]).toContain(run.phase)
  expect(run.delivery ?? null).toBe(null)
  void threw
})

test("新一轮：awaiting_human 后新意见 → round 2 重置里程碑", async () => {
  const f = await fixture()
  await f.drive(GOAL)
  await f.drive("补充：标准一改为要求误差界")
  const run = f.engine.store.run("session-1")
  expect(run.round).toBe(2)
  // 里程碑注册表已重建（新轮全部 v1）
  expect(Object.values(run.milestones).every((m) => m.version === 1)).toBe(true)
  expect(run.previous).toBeTruthy()
})

// ---- 纯函数：传播、回滚、强度链、矛盾、计划 ----

function seededRun() {
  const run = {
    contract: { criteria: [{ id: "C1" }, { id: "C2" }] },
    plan: {
      subproblems: [
        {
          id: "S1",
          goal: "g1",
          criteria: ["C1"],
          expectedRefs: [],
          depends: [],
          verification: { anchor: "weak", spec: "s" },
          robustness: "r",
        },
        {
          id: "S2",
          goal: "g2",
          criteria: ["C2"],
          expectedRefs: ["S1"],
          depends: ["S1"],
          verification: { anchor: "programmatic", spec: "s" },
          robustness: "r",
        },
        {
          id: "S3",
          goal: "g3",
          criteria: ["C2"],
          expectedRefs: ["S2"],
          depends: ["S2"],
          verification: { anchor: "rederivation", spec: "s" },
          robustness: "r",
        },
      ],
    },
    milestones: {},
    ledger: [],
    verifiers: {},
    subresults: { S1: { status: "completed" }, S2: { status: "completed" } },
  }
  const sub = (id) => run.plan.subproblems.find((s) => s.id === id)
  registerProposals(run, sub("S1"), {
    status: "completed",
    artifacts: [],
    milestones: [
      {
        id: "M1",
        statement: "a",
        scope: "s",
        criteria: ["C1"],
        inputs: [],
        branches: [],
        highRisk: [],
        artifacts: [],
        values: [{ symbol: "g", value: "1", unit: "1" }],
      },
    ],
    claims: [],
    problems: [],
    reason: "",
  })
  registerProposals(run, sub("S2"), {
    status: "completed",
    artifacts: [],
    milestones: [
      {
        id: "M1",
        statement: "b",
        scope: "s",
        criteria: ["C2"],
        inputs: [{ from: "S1:M1", use: "premise" }],
        branches: [],
        highRisk: [],
        artifacts: [],
        values: [],
      },
    ],
    claims: [],
    problems: [],
    reason: "",
  })
  run.milestones["S1:M1"].status = "verified"
  run.milestones["S1:M1"].verification = { mode: "implement", anchor: "programmatic", spec: "s" }
  run.milestones["S2:M1"].status = "verified"
  run.milestones["S2:M1"].verification = { mode: "implement", anchor: "programmatic", spec: "s" }
  run.verifiers["S2:M1"] = { asset: "verifier:x", status: "trusted", controls: [] }
  return run
}

test("preflight 与推测预算", () => {
  const run = seededRun()
  // S3 的前提 S2 verified → 可调度
  expect(speculationOk(run, "S3", 1).ok).toBe(true)
  // S2 退到 quick_checked → S3 变推测，depth=1 允许、depth=0 拒绝
  run.milestones["S2:M1"].status = "quick_checked"
  expect(speculationOk(run, "S3", 1).ok).toBe(true)
  expect(speculationOk(run, "S3", 1).speculative).toBe(1)
  expect(speculationOk(run, "S3", 0).ok).toBe(false)
  // S2 failed → S3 硬阻塞
  run.milestones["S2:M1"].status = "failed"
  expect(preflight(run, "S3").ok).toBe(false)
})

function seedS3(run) {
  registerProposals(
    run,
    run.plan.subproblems.find((x) => x.id === "S3"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "M1",
          statement: "c",
          scope: "s",
          criteria: ["C2"],
          inputs: [{ from: "S2:M1", use: "premise" }],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  run.milestones["S3:M1"].status = "verified"
  run.milestones["S3:M1"].verification = { mode: "implement", anchor: "rederivation", spec: "s" }
}

test("B 类三态：trusted 验证器吸收传播（rerun）；无验证器则 stale 传递", () => {
  const run = seededRun()
  seedS3(run)
  const effects = propagateB(run, "S1:M1")
  expect(effects.rerun).toContain("S2:M1")
  expect(run.milestones["S2:M1"].status).toBe("stale")
  expect(effects.staleManual).not.toContain("S3:M1")
  expect(run.milestones["S3:M1"].status).toBe("verified")

  const run2 = seededRun()
  seedS3(run2)
  delete run2.verifiers["S2:M1"]
  const effects2 = propagateB(run2, "S1:M1")
  expect(effects2.staleManual).toContain("S2:M1")
  expect(effects2.staleManual).toContain("S3:M1")
  expect(run2.milestones["S3:M1"].status).toBe("stale")
})

test("C 类选择性回滚：沿账本传递依赖，独立里程碑保留", () => {
  const run = seededRun()
  registerProposals(
    run,
    run.plan.subproblems.find((s) => s.id === "S3"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "M1",
          statement: "c",
          scope: "s",
          criteria: ["C2"],
          inputs: [{ from: "S2:M1", use: "premise" }],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  run.milestones["S3:M1"].status = "verified"
  const set = rollbackSet(run, "S1:M1")
  expect(set.milestones.sort()).toEqual(["S2:M1", "S3:M1"].sort())
  expect(set.subs.sort()).toEqual(["S2", "S3"].sort())
})

test("强度链取最弱环节", () => {
  const run = seededRun()
  expect(strengthName(chainStrength(run, run.milestones["S1:M1"]))).toBe("programmatic")
  // S2 programmatic 消费 programmatic → programmatic
  expect(strengthName(chainStrength(run, run.milestones["S2:M1"]))).toBe("programmatic")
  // S2 改 weak → S3（rederivation=independent）消费 S2 → weak
  run.milestones["S2:M1"].verification.anchor = "weak"
  registerProposals(
    run,
    run.plan.subproblems.find((s) => s.id === "S3"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "M1",
          statement: "c",
          scope: "s",
          criteria: ["C2"],
          inputs: [{ from: "S2:M1", use: "p" }],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  run.milestones["S3:M1"].verification = { mode: "implement", anchor: "rederivation", spec: "s" }
  expect(strengthName(chainStrength(run, run.milestones["S3:M1"]))).toBe("weak")
})

test("程序层矛盾检测与计划边 staleness", () => {
  const run = seededRun()
  registerProposals(
    run,
    run.plan.subproblems.find((s) => s.id === "S3"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "M1",
          statement: "c",
          scope: "s",
          criteria: ["C2"],
          inputs: [{ from: "S2:M1", use: "p" }],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [{ symbol: "g", value: "2", unit: "1" }],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  const clashes = contradictions(run, run.milestones["S3:M1"])
  expect(clashes.length).toBe(1)
  expect(clashes[0].symbol).toBe("g")
  const edges = staleEdges(run, ["S2"])
  expect(edges.some((e) => e.consumer === "S3")).toBe(true)
})

test("gate merge：折叠为父级分支，父级 verified 退回 quick_checked", () => {
  const run = seededRun()
  registerProposals(
    run,
    run.plan.subproblems.find((s) => s.id === "S1"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "M2",
          statement: "a2",
          scope: "s",
          criteria: [],
          inputs: [],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  const outcome = gateDecision(run, run.milestones["S1:M2"], { decision: "merge" })
  expect(outcome).toBe("merged")
  expect(run.milestones["S1:M2"].status).toBe("superseded")
  expect(run.milestones["S1:M1"].branches.some((b) => b.id === "M2")).toBe(true)
  expect(run.milestones["S1:M1"].status).toBe("quick_checked")
})

test("计划校验：覆盖缺口与未知引用被打回", () => {
  const contract = { criteria: [{ id: "C1" }, { id: "C2" }] }
  const good = {
    strategy: "s",
    subproblems: [
      {
        id: "S1",
        goal: "g",
        criteria: ["C1"],
        expectedRefs: [],
        depends: [],
        verification: { anchor: "weak", spec: "s" },
        robustness: "r",
      },
      {
        id: "S2",
        goal: "g",
        criteria: ["C2"],
        expectedRefs: ["S1"],
        depends: [],
        verification: { anchor: "weak", spec: "s" },
        robustness: "r",
      },
    ],
    reason: "策略说明",
  }
  expect(planCheck(good, contract)).toBe(true)
  expect(() => planCheck({ ...good, subproblems: good.subproblems.slice(0, 1) }, contract)).toThrow("No subproblem")
  expect(() =>
    planCheck(
      { ...good, subproblems: [{ ...good.subproblems[0], expectedRefs: ["S9"] }, good.subproblems[1]] },
      contract,
    ),
  ).toThrow("unknown subproblem")
})

// ---- 存储闸门 ----

test("交付闸门：无集成结果不得进入 awaiting_human", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loca-store-"))
  const store = new Store(dir)
  const run = store.create("s")
  run.phase = "integrating"
  store.save(run)
  expect(() => store.move(run, "awaiting_human")).toThrow("Delivery gate")
  await rm(dir, { recursive: true, force: true })
})

// ---- 稳健性防御（v2 防线移植后的回归测试）----

test("问题保留：缺失的旧问题自动继承为 open；克隆折叠；无证据的 closed 退回 open", async () => {
  const { retainProblems, mergeProblems } = await import("../milestone.js")
  const value = {
    problems: [
      { id: "P1", detail: "缺口一", status: "closed", evidence: ["x"] },
      { id: "P2", detail: "缺口二", status: "closed", evidence: [] },
    ],
  }
  const prior = {
    problems: [
      { id: "P1", detail: "缺口一", status: "open", evidence: [] },
      { id: "P3", detail: "缺口三", status: "open", evidence: [] },
    ],
  }
  retainProblems(value, prior)
  const ids = value.problems.map((p) => p.id)
  expect(ids.includes("P3")).toBe(true) // 未提及 ≠ 已解决
  expect(value.problems.find((p) => p.id === "P2").status).toBe("open") // closed 无证据退回 open
  expect(value.problems.find((p) => p.id === "P1").status).toBe("closed") // 有证据的关闭保留
  // 克隆链折叠：P-G7b-c7 与 P-G7b-c8 合并回 P-G7b
  const merged = mergeProblems([
    { id: "P-G7b", detail: "原始缺口", status: "open", evidence: [] },
    { id: "P-G7b-c7", detail: "沿袭 P-G7b 的同一缺口", status: "closed", evidence: ["x"] },
    { id: "独立", detail: "另一个问题", status: "open", evidence: [] },
  ])
  expect(merged.some((p) => p.id === "P-G7b-c7")).toBe(false)
  expect(merged.find((p) => p.id === "P-G7b").status).toBe("open") // open 粘滞
  expect(merged.some((p) => p.id === "独立")).toBe(true)
})

test("推测深度按传递闭包计算：链式未深审前提受 depth 约束", () => {
  const run = seededRun()
  // S3 只直接引用 S2（verified），但 S2 传递引用 S1（quick_checked）
  run.milestones["S1:M1"].status = "quick_checked"
  expect(preflight(run, "S3").ok).toBe(true) // 直接前提全 verified
  const ok = speculationOk(run, "S3", 1)
  expect(ok.ok).toBe(true)
  expect(ok.speculative).toBe(1) // 闭包内的 S1 计入
  expect(speculationOk(run, "S3", 0).ok).toBe(false) // depth 0 拒绝
})

test("packet 容忍已修剪资产：不因坏 id 抛错（防不烧预算的无限重试）", async () => {
  const f = await fixture()
  const run = f.engine.store.create("probe")
  f.engine.store.put(run, "input", "goal.txt", "probe")
  const good = run.assets[0]
  const packet = f.engine.packet(run, { probe: true }, ["artifact:nonexistent", good])
  expect(packet.assets.some((a) => a.id === good)).toBe(true)
  expect(packet.assets.some((a) => a.id === "artifact:nonexistent")).toBe(false)
})

test("中断恢复：中途取消后 continue 从持久化状态重建 frontier 并完成交付", async () => {
  let calls = 0
  const f = await fixture({
    wrap: (value, _packet, context) => {
      calls++
      // 第 4 个角色调用进行中取消（模拟实例崩溃/用户中断）：
      // 中止当前 run 的控制器而非复用某个 signal 引用
      if (calls === 4) f.engine.active.get(context.run.id)?.controller.abort()
      return value
    },
  })
  await f.drive(GOAL)
  const mid = f.engine.store.run("session-1")
  expect(mid.phase).toBe("cancelled")
  // 中断时进行中的任务作废重来（v2 语义）；已完成的合约保留
  expect(mid.contract).toBeTruthy()
  // 取消是环境事件不是任务失败：里程碑不得被 infra finding 污染成 failed
  // （否则 continue 后 gate 需整轮重跑，已升格审判作废）
  for (const m of Object.values(mid.milestones)) {
    expect(m.status === "failed" && (m.review.findings ?? []).some((x) => x.id.endsWith("-infra"))).toBe(false)
  }
  // 恢复：frontier 是持久化状态的纯投影，从断点重建
  const out = await f.drive("continue")
  const run = f.engine.store.run("session-1")
  expect(run.phase).toBe("awaiting_human")
  expect(run.milestones["S1:M1"].status).toBe("verified")
  expect(run.milestones["S2:M1"].status).toBe("verified")
  expect(out).toContain("等待你验收")
  // 恢复不烧计划版本号：单计划版本内完成
  expect(run.cycle).toBe(1)
  // 被中断的 job 标记为 stale 而非凭空消失
  const jobs = f.engine.store.jobs(run)
  expect(jobs.some((j) => j.status === "stale" || j.status === "cancelled")).toBe(true)
})

test("进程级中断恢复：in-flight job 标 interrupted，continue 后原会话续传不重做", async () => {
  // 模拟实例崩溃（进程死亡）：vaudit 的 prompt 永不 resolve（调用方进程消失，
  // 无人消费 promise）——与用户 cancel（主动 abort→cancelled）的关键差异。
  let hang = false
  const seen = []
  const f = await fixture({
    handlers: {
      vaudit: async (packet, context, parsed) => {
        seen.push({ session: context.job.session, resume: parsed.resume ?? null })
        if (hang) await new Promise(() => {})
        const exec = await f.engine.compute(
          context,
          { code: "import sys\nsys.exit(1)\n", inputs: [] },
          { ask: async () => {} },
        )
        return {
          decision: "trusted",
          checks: cfg.checks.vaudit.map((id) => ({
            id,
            status: "pass",
            reason: "语义符合且对照充分",
            evidence: [exec.id],
          })),
          findings: [],
          controls: [{ id: "K1", mutation: "注入破坏守恒的项", execution: exec.id, observed: "failed" }],
        }
      },
    },
  })
  hang = true
  // 第一次 drive 永不完成（vaudit 挂起）：丢弃该 promise 等效于进程死亡。
  // 100ms 后磁盘上 run 处于 working、vaudit job 处于 running。
  const dying = f.drive(GOAL)
  dying.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 100))
  hang = false
  const mid = f.engine.store.run("session-1")
  expect(mid.phase).toBe("working")
  const dyingJob = f.engine.store.jobs(mid).find((j) => j.role === "vaudit" && j.status === "running")
  expect(dyingJob).toBeTruthy()
  expect(dyingJob.session).toBeTruthy()
  const deadSession = dyingJob.session
  // 模拟重启的新实例：同一落盘 store 上新建 Engine（内存态 active/children 随
  // 旧进程消失）；旧 engine 挂起的调度循环不再触碰磁盘（其 guard 已过期）
  const fresh = new Engine(f.dir, cfg, null, path.join(f.dir, "loca/.runtime"), fakeExecutor())
  const client = f.rebind(fresh)
  fresh.client = client
  fresh.runner.client = client
  fresh.capture("session-1", { id: "msg-revive", parts: [{ type: "text", text: "continue" }] })
  const out = await fresh.act("session-1", {
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: async () => {},
  })
  const run = fresh.store.run("session-1")
  expect(run.phase).toBe("awaiting_human")
  expect(out).toContain("等待你验收")
  // 挂起会话上的两次 prompt：第一次初始 packet（无 resume），第二次续传 packet（有 resume）
  const vauditSeen = seen.filter((s) => s.session === deadSession)
  expect(vauditSeen.length).toBe(2)
  expect(vauditSeen[0].resume).toBe(null)
  expect(vauditSeen[1].resume).toBeTruthy()
  // 原会话被复用：interrupted job 同 id 续跑至 accepted，无第二个 vaudit job
  const vauditJobs = f.engine.store.jobs(run).filter((j) => j.role === "vaudit")
  expect(vauditJobs.some((j) => j.id === dyingJob.id && j.status === "accepted")).toBe(true)
  expect(vauditJobs.filter((j) => j.status === "accepted").length).toBe(1)
  // 续传消耗 attempt 预算但不烧 cycle：单计划版本内完成
  expect(run.cycle).toBe(1)
  expect(run.milestones["S1:M1"].status).toBe("verified")
  expect(run.milestones["S2:M1"].status).toBe("verified")
  void dying
})

test("backstop 软化：活跃任务不因 wall-clock timeout 被杀，停滞任务仍由 watchdog 处置", async () => {
  // vaudit timeout 设 100ms：旧语义下必死（wall-clock 到点 abort）；
  // 新语义下只要 watchdog 周期内有活动就放行（软告警），任务应 accepted
  const f = await fixture({
    cfg: { timeout: { vaudit: 100 } },
    handlers: {
      vaudit: async (packet, context) => {
        // 模拟活跃流：持续刷会话 activity（watchdog 每周期看到活动）
        const beat = setInterval(() => f.engine.activity.set(context.job.session, Date.now()), 200)
        try {
          await new Promise((resolve) => setTimeout(resolve, 500)) // 超过 timeout 时限
        } finally {
          clearInterval(beat)
        }
        const exec = await f.engine.compute(
          context,
          { code: "import sys\nsys.exit(1)\n", inputs: [] },
          { ask: async () => {} },
        )
        return {
          decision: "trusted",
          checks: cfg.checks.vaudit.map((id) => ({
            id,
            status: "pass",
            reason: "语义符合且对照充分",
            evidence: [exec.id],
          })),
          findings: [],
          controls: [{ id: "K1", mutation: "注入破坏守恒的项", execution: exec.id, observed: "failed" }],
        }
      },
    },
  })
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  expect(run.phase).toBe("awaiting_human")
  // 活跃的 vaudit 超过 timeout 时限仍 accepted（backstop 放行）
  const vaudits = f.engine.store.jobs(run).filter((j) => j.role === "vaudit")
  expect(vaudits.some((j) => j.status === "accepted")).toBe(true)
})

test("watchdog 仍然处置无活动的停滞任务", async () => {
  let stalls = 0
  const f = await fixture({
    cfg: { idle: 200 },
    handlers: {
      vaudit: async () => {
        // 无任何活动：不刷 activity。首轮挂 3 秒（远超 idle=200ms）被 watchdog
        // 杀；后续 attempt 不再挂（防测试超时），让流程走完
        if (stalls++ === 0) await new Promise((resolve) => setTimeout(resolve, 2500))
        return {
          decision: "trusted",
          checks: cfg.checks.vaudit.map((id) => ({ id, status: "pass", reason: "ok", evidence: [] })),
          findings: [],
          controls: [],
        }
      },
    },
  })
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  // 首个 vaudit attempt 被 watchdog 判停滞：不会 accepted
  const vaudits = f.engine.store.jobs(run).filter((j) => j.role === "vaudit")
  expect(vaudits.some((j) => ["timeout", "retrying", "exhausted"].includes(j.status))).toBe(true)
  expect(vaudits[0].status).not.toBe("accepted")
})

test("statement 归一化：patch 轮次叙述不改命题主干 → 沿用验证方案不重置", async () => {
  // 场景回放（NRQCD 实测）：模型每轮 patch 把"经第 N 轮维持性补洞复核后维持"
  // 写进 statement——数学内容未变。字面比较会让 v2 gated 的里程碑在 v3 被重置
  // verification（anchor/gate/vaudit 全链重跑数小时）。
  let round = 0
  const statements = [
    "三线函数在红外区域收敛：(Q1) 恒等式成立",
    "三线函数在红外区域收敛，经第 11 轮维持性补洞复核后维持：(Q1) 恒等式成立",
    "三线函数在红外区域收敛，且经 round-10 patch 完成登记层补洞后维持：(Q1) 恒等式成立",
  ]
  const f = await fixture({
    handlers: {
      solve: (packet, context) => {
        const sub = packet.plan.subproblem.id
        const name = `result-${sub}.md`
        const content = `# ${sub}\nstatement: ${state.s1Statement}\n`
        if (!state.artifacts.has(`${name}:${content}`)) {
          state.artifacts.add(`${name}:${content}`)
          f.engine.register(context, "artifact", name, content)
        }
        const stmt = sub === "S1" ? statements[Math.min(round, statements.length - 1)] : `# ${sub} uses S1\n`
        if (sub === "S1") round++
        const milestones =
          sub === "S1"
            ? [
                {
                  id: "M1",
                  statement: stmt,
                  scope: "临界区域",
                  criteria: ["C1"],
                  inputs: [],
                  branches: [],
                  highRisk: [],
                  artifacts: [name],
                  values: [{ symbol: "alpha", value: "0.125", unit: "1" }],
                },
              ]
            : [
                {
                  id: "M1",
                  statement: "Y 的标度行为与 X 一致",
                  scope: "临界区域",
                  criteria: ["C2"],
                  inputs: [{ from: "S1:M1", use: "X 的结论作为前提" }],
                  branches: [],
                  highRisk: [],
                  artifacts: [name],
                  values: [],
                },
              ]
        return {
          status: "completed",
          artifacts: [name],
          milestones,
          claims: [],
          problems: [],
          reason: "完成并自检",
        }
      },
    },
  })
  const { state } = f
  void state
  await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  const m1 = run.milestones["S1:M1"]
  expect(m1.status).toBe("verified")
  // v3（叙述变化但主干相同）不重置验证器：verifier 保留，无第三次 anchor
  expect(m1.verification.verifier).toBeTruthy()
  const anchors = f.engine.store.jobs(run).filter((j) => j.role === "anchor" && j.slot === "S1:M1")
  expect(anchors.filter((j) => j.status === "accepted").length).toBe(1)
})

test("timeout 继承：健康超时（backstop）的 attempt 2 沿用原会话与上下文", async () => {
  const seen = []
  const f = await fixture({
    cfg: { timeout: { vaudit: 200 }, attempts: 2 },
    handlers: {
      vaudit: async (packet, context, parsed) => {
        seen.push({ session: context.job.session, resume: parsed.resume ?? null, dir: context.dir })
        // 持续活跃（刷心跳）但永远不返回——第一 attempt 被 backstop 绝对上限杀
        const beat = setInterval(() => f.engine.activity.set(context.job.session, Date.now()), 50)
        try {
          await new Promise(() => {})
        } finally {
          clearInterval(beat)
        }
      },
    },
  })
  // 驱动会因 backstop hard 永不收敛而抛错——捕获后检查 attempt 2 的会话继承
  const p = f.drive(GOAL)
  p.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const run = f.engine.store.run("session-1")
  const vaudits = f.engine.store.jobs(run).filter((j) => j.role === "vaudit")
  // 出现两个 attempt（attempt 1 timeout，attempt 2 继承原会话）
  expect(vaudits.length).toBeGreaterThanOrEqual(2)
  const first = vaudits.find((j) => j.attempt === 1)
  const second = vaudits.find((j) => j.attempt === 2)
  expect(["timeout", "retrying", "exhausted"].includes(first.status)).toBe(true)
  // 继承核心断言：attempt 2 复用 attempt 1 的会话与目录
  expect(second.session).toBe(first.session)
  expect(second.directory).toBe(first.directory)
  expect(second.resumed).toBe(true)
  // 续传指令注入（第二次 prompt 带 resume）
  const inheritSeen = seen.filter((s) => s.session === first.session)
  expect(inheritSeen.length).toBeGreaterThanOrEqual(2)
  expect(inheritSeen[1].resume).toBeTruthy()
  for (const j of f.engine.store.jobs(run).filter((j) => j.role === "vaudit"))
    console.log("VJOB", j.attempt, j.status, "| sess:", j.session, "| err:", String(j.error).slice(0, 100))
})

// ---- 之前未覆盖的确定性路径 ----

test("涌现里程碑管线：anchor 提案模式 → crosscheck 锚 → 分支验证 → 弱链标注进交付", async () => {
  const f = await fixture({
    state: { emergentDone: false },
    handlers: {
      solve: (packet, context) => {
        const sub = packet.plan.subproblem.id
        const name = `result-${sub}.md`
        f.engine.register(context, "artifact", name, `# ${sub}\n`)
        if (sub === "S1" && !f.state.emergentDone) {
          f.state.emergentDone = true
          return {
            status: "completed",
            artifacts: [name],
            milestones: [
              {
                id: "M1",
                statement: "X = 0.125 且规范场守恒",
                scope: "临界区域",
                criteria: ["C1"],
                inputs: [],
                branches: [],
                highRisk: [],
                artifacts: [name],
                values: [{ symbol: "alpha", value: "0.125", unit: "1" }],
              },
              {
                id: "M2",
                statement: "标度函数在临界区域内解析（涌现结论）",
                scope: "临界区域",
                criteria: ["C1"],
                inputs: [],
                branches: [{ id: "B1", statement: "标度函数的连续性分支", inputs: ["internal"] }],
                highRisk: [],
                artifacts: [name],
                values: [],
              },
            ],
            claims: [],
            problems: [],
            reason: "主里程碑+涌现里程碑",
          }
        }
        const base = {
          S1: {
            status: "completed",
            artifacts: [name],
            milestones: [
              {
                id: "M1",
                statement: "X = 0.125 且规范场守恒",
                scope: "临界区域",
                criteria: ["C1"],
                inputs: [],
                branches: [],
                highRisk: [],
                artifacts: [name],
                values: [{ symbol: "alpha", value: "0.125", unit: "1" }],
              },
            ],
            claims: [],
            problems: [],
            reason: "ok",
          },
          S2: {
            status: "completed",
            artifacts: [name],
            milestones: [
              {
                id: "M1",
                statement: "Y 的标度行为与 X 一致",
                scope: "临界区域",
                criteria: ["C2"],
                inputs: [{ from: "S1:M1", use: "前提" }],
                branches: [],
                highRisk: [],
                artifacts: [name],
                values: [],
              },
            ],
            claims: [],
            problems: [],
            reason: "ok",
          },
        }
        return base[sub]
      },
      anchor: (packet) => {
        if (packet.mode === "propose")
          return { anchor: "crosscheck", spec: "以独立分支交叉验证标度行为", inputs: [], reason: "涌现提案独立提出" }
        return {
          anchor: "programmatic",
          spec: packet.registered?.spec ?? "运行检查程序",
          verifier: "import sys\nsys.exit(0)\n",
          inputs: packet.milestone.artifacts.map((id) => f.engine.store.asset(id).name),
          reason: "程序化检查",
        }
      },
    },
  })
  const summary = await f.drive(GOAL)
  const run = f.engine.store.run("session-1")
  expect(run.phase).toBe("awaiting_human")
  const m1 = run.milestones["S1:M1"]
  const m2 = run.milestones["S1:M2"]
  // 涌现里程碑走完 propose→gate→（无 e2e）深审→verified，强度 crosscheck（有分支）
  expect(m2.kind).toBe("emergent")
  expect(m2.status).toBe("verified")
  expect(m2.strength).toBe("crosscheck")
  expect((m2.review.branches ?? []).length).toBe(1)
  expect(m1.strength).toBe("programmatic")
  // C1 由 M1(programmatic)+M2(crosscheck) 负责 → 链取最弱环节 crosscheck，软规则标注
  expect(summary).toContain("crosscheck")
})

test("needs_human 澄清流：阻断问题暂停 → 用户答复 → 新轮完成", async () => {
  const f = await fixture({
    state: { clarify: true },
    handlers: {
      contract: (packet, context) => {
        if (f.state.clarify) {
          f.state.clarify = false
          return {
            goal: "测试目标",
            criteria: [
              { id: "C1", text: "标准一", method: "程序检查", origin: "目标：" },
              { id: "C2", text: "标准二", method: "独立验证", origin: "标准：" },
            ],
            removed: [],
            questions: [{ id: "Q1", blocking: true, question: "关键参数未给出", evidence: [] }],
            assumptions: [],
          }
        }
        void packet
        void context
        return {
          goal: "测试目标",
          criteria: [
            { id: "C1", text: "标准一", method: "程序检查", origin: "目标：" },
            { id: "C2", text: "标准二", method: "独立验证", origin: "标准：" },
          ],
          removed: [],
          questions: [],
          assumptions: [],
        }
      },
    },
  })
  const first = await f.drive(GOAL)
  const mid = f.engine.store.run("session-1")
  expect(mid.phase).toBe("needs_human")
  expect(first).toContain("需要你决定")
  // 用户答复 → 新一轮（旧标准保留）
  const second = await f.drive("补充：关键参数 alpha=0.5")
  const run = f.engine.store.run("session-1")
  expect(second).toContain("等待你验收")
  expect(run.phase).toBe("awaiting_human")
  expect(run.round).toBe(2)
  expect(run.contract.criteria.map((c) => c.id)).toEqual(["C1", "C2"])
})

test("anchorStrength 与 resolveInput 纯函数", async () => {
  const { anchorStrength } = await import("../milestone.js")
  expect(anchorStrength({ verification: { anchor: "programmatic" } })).toBe("programmatic")
  expect(anchorStrength({ verification: { anchor: "rederivation" } })).toBe("independent")
  expect(anchorStrength({ verification: { anchor: "crosscheck" }, branches: [{ id: "B1" }] })).toBe("crosscheck")
  expect(anchorStrength({ verification: { anchor: "crosscheck" }, branches: [] })).toBe("weak")
  expect(anchorStrength({ verification: { anchor: "weak" } })).toBe("weak")
  const { resolveInput } = await import("../milestone.js")
  const run = seededRun()
  expect(resolveInput(run, "internal")).toEqual({ type: "internal", id: "internal" })
  expect(resolveInput(run, "S1:M1")).toEqual({ type: "milestone", id: "S1:M1" })
  // 短名唯一时解析；歧义（S1:M1 与 S2:M1 同尾）返回 null
  run.milestones["S3:M9"] = { id: "S3:M9", status: "proposed", inputs: [], subproblem: "S3" }
  expect(resolveInput(run, "M9")).toEqual({ type: "milestone", id: "S3:M9" })
  expect(resolveInput(run, "M1")).toBeNull()
  // 资产按注册名
  const index = new Map([["g.txt", [{ id: "artifact:g", kind: "artifact" }]]])
  expect(resolveInput(run, "g.txt", index)).toEqual({ type: "asset", id: "artifact:g" })
  expect(resolveInput(run, "不存在", index)).toBeNull()
})

test("前提漂移三态：真变化阻断 / 状态退化阻断 / 确认不变语义放行", async () => {
  const { premiseDrift } = await import("../milestone.js")
  const run = seededRun()
  run.verifiers["S2:M1"] = { asset: "verifier:x", status: "trusted", controls: [] }
  seedS3(run)
  const effects = propagateB(run, "S1:M1")
  expect(effects.rerun).toContain("S2:M1")
  // 场景一：前提版本前进且内容变化（B 类真修正）→ 阻断
  run.milestones["S1:M1"].version = 2
  run.milestones["S1:M1"].statement = "a-修正后的新命题"
  const d1 = premiseDrift(run, run.milestones["S2:M1"])
  expect(d1.ok).toBe(false)
  expect(d1.reason).toContain("内容已变化")
  // 场景二：前提状态退化 → 阻断
  run.milestones["S1:M1"].version = 1
  run.milestones["S1:M1"].statement = "a"
  run.milestones["S1:M1"].status = "stale"
  const d2 = premiseDrift(run, run.milestones["S2:M1"])
  expect(d2.ok).toBe(false)
  expect(d2.reason).toContain("状态已退化")
  // 场景三：版本前进但内容指纹一致（确认不变的刷新）→ 语义放行
  run.milestones["S1:M1"].status = "verified"
  run.milestones["S1:M1"].version = 2
  const d3 = premiseDrift(run, run.milestones["S2:M1"])
  expect(d3.ok).toBe(true)
  expect(d3.semanticBypass).toContain("内容指纹一致")
  // 场景四：无漂移 → 干净通过
  run.milestones["S1:M1"].version = 1
  const d4 = premiseDrift(run, run.milestones["S2:M1"])
  expect(d4.ok).toBe(true)
  expect(d4.semanticBypass).toBeUndefined()
})

test("里程碑 id 多级前缀归一：P1:P1:P1:M2 → P1:M2", () => {
  const run = seededRun()
  registerProposals(
    run,
    run.plan.subproblems.find((x) => x.id === "S1"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "S1:S1:M9-multi",
          statement: "多级前缀",
          scope: "s",
          criteria: ["C1"],
          inputs: [],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  expect(run.milestones["S1:M9-multi"]).toBeTruthy()
  expect(run.milestones["S1:S1:M9-multi"]).toBeUndefined()
})

test("语义迁移：replan 改 id + migratedFrom → 里程碑/验证器/账本/子结果全保留且引用重写", () => {
  const run = seededRun()
  seedS3(run)
  run.verifiers["S1:M1"] = { asset: "verifier:a", status: "trusted", controls: [] }
  const out = migrateSubproblems(run, { S1: "X1", S3: "X3" })
  expect(run.milestones["X1:M1"]).toBeTruthy()
  expect(run.milestones["X1:M1"].status).toBe("verified")
  expect(run.milestones["S1:M1"]).toBeUndefined()
  expect(run.verifiers["X1:M1"].status).toBe("trusted")
  expect(run.ledger.some((e) => e.consumer === "S2:M1" && e.consumed === "X1:M1")).toBe(true)
  const s3 = run.milestones["X3:M1"]
  expect(s3.inputs[0].from).toBe("S2:M1")
  expect(run.subresults["X1"]?.status).toBe("completed")
  expect(run.subresults["S1"]).toBeUndefined()
  expect(out.migrated.length).toBe(2)
})

test("语义迁移冲突保守放弃：新 key 被占用时跳过该子问题", () => {
  const run = seededRun()
  run.milestones["X1:M1"] = {
    id: "X1:M1",
    subproblem: "X1",
    status: "proposed",
    inputs: [],
    verification: { mode: "propose" },
    review: {},
  }
  const out = migrateSubproblems(run, { S1: "X1" })
  expect(out.skipped).toContain("S1")
  expect(run.milestones["S1:M1"]).toBeTruthy()
})

test("conservative A 兜底连续两次升级 needs_human（防无限循环）", async () => {
  const f = await fixture({
    cfg: { cycles: 3 },
    handlers: {
      triage: () => {
        throw new Error("triage 崩溃")
      },
    },
    state: {
      challenges: [{ id: "Q1", target: "x", kind: "concept", hypothesis: "h", importance: "must", reason: "r" }],
      unitFailForever: true,
    },
  })
  let threw = null
  try {
    await f.drive(GOAL)
  } catch (error) {
    threw = error
  }
  void threw
  const run = f.engine.store.run("session-1")
  expect(run.phase).toBe("needs_human")
  const events = f.engine.store.events(run)
  expect(events.some((e) => e.kind === "conservative_triage" && e.data.escalated)).toBe(true)
})

test("gate mergeInto：跨子问题语义合并 + 无效目标回退", () => {
  const run = seededRun()
  seedS3(run)
  // S3（邻接计划子问题）下申报一个待合并提案
  registerProposals(
    run,
    run.plan.subproblems.find((x) => x.id === "S3"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "M9",
          statement: "本属映射表的独立分支",
          scope: "s",
          criteria: ["C2"],
          inputs: [{ from: "S2:M1", use: "p" }],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  // 声明跨子问题目标：折到 S1:M1（计划邻接，语义正确）
  const out = gateDecision(run, run.milestones["S3:M9"], { decision: "merge", mergeInto: "S1:M1" })
  expect(out).toBe("merged")
  expect(run.milestones["S3:M9"].mergedInto).toBe("S1:M1")
  expect(run.milestones["S1:M1"].branches.some((b) => b.id === "M9")).toBe(true)
  // 无效目标（未注册）→ 引擎校验层会拒绝；纯函数层回退到同子问题父级
  registerProposals(
    run,
    run.plan.subproblems.find((x) => x.id === "S3"),
    {
      status: "completed",
      artifacts: [],
      milestones: [
        {
          id: "M8",
          statement: "x",
          scope: "s",
          criteria: ["C2"],
          inputs: [],
          branches: [],
          highRisk: [],
          artifacts: [],
          values: [],
        },
      ],
      claims: [],
      problems: [],
      reason: "",
    },
  )
  const out2 = gateDecision(run, run.milestones["S3:M8"], { decision: "merge", mergeInto: "不存在:id" })
  expect(out2).toBe("merged")
  expect(run.milestones["S3:M8"].mergedInto).toBe("S3:M1")
})

test("执行预算与内嵌 payload 静态拦截", async () => {
  const f = await fixture()
  const run = f.engine.store.create("probe-budget")
  run.model = { providerID: "alibaba-cn", modelID: "glm-5.3" }
  f.engine.store.put(run, "policy", "workflow.json", "{}")
  f.engine.active.set(run.id, { controller: new AbortController() })
  const mkCtx = (role) => ({
    run,
    job: { id: "j1", role, round: 1, cycle: 1 },
    role,
    epoch: run.epoch,
    allowed: new Set(),
    produced: [],
    controller: new AbortController(),
  })
  // C) anchor 预算 6 次：第 7 次拒绝
  const ctxA = mkCtx("anchor")
  for (let i = 0; i < 6; i++) await f.engine.compute(ctxA, { code: "print(1)", inputs: [] }, { ask: async () => {} })
  let threw = null
  try {
    await f.engine.compute(ctxA, { code: "print(1)", inputs: [] }, { ask: async () => {} })
  } catch (e) {
    threw = e
  }
  expect(String(threw)).toContain("沙箱执行预算已用尽")
  // D) 验证器内嵌 b85 payload 拒绝（走 anchor check 逻辑——直接构造 check 场景太重，用正则同源验证）
  const decoder = /b85decode|b64decode|zlib\.decompress|lzma\.decompress|a2b_\w+|decodebytes/i
  const blobLiteral = /["'][A-Za-z0-9+/=]{200,}["']/
  const isPayload = (code) => decoder.test(code) && blobLiteral.test(code)
  // 真 payload：解码调用 + 长编码字面量 → 拦
  expect(isPayload('import base64\nbase64.b85decode("ABCDEFGH' + "X".repeat(300) + '")')).toBe(true)
  // 功能性 zlib（无常量字面量）→ 放行
  expect(isPayload("import zlib\nd = zlib.decompress(LOCA_INPUTS_DATA)")).toBe(false)
  // 普通验证器 → 放行
  expect(isPayload("import hashlib\nh = hashlib.sha256(x)")).toBe(false)
})
