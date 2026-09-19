import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { Store, hash } from "./store.js"
import { Runner, parallel } from "./runner.js"
import { exact, review } from "./schema.js"
import { planCheck, milestonesOf, speculationOk, staleEdges, closure } from "./graph.js"
import {
  registerProposals,
  migrateSubproblems,
  resolveInput,
  retainProblems,
  premiseDrift,
  closureOk,
  referenced,
  gateDecision,
  anchorResult,
  deepSpec,
  contradictions,
  propagateB,
  rollbackSet,
  aggregate,
  reviewComplete,
  chainStrength,
  strengthName,
} from "./milestone.js"
import { execute } from "./execute.js"

export const engines = new Map()

const LABELS = {
  new: "启动",
  contract: "合约",
  planning: "规划",
  working: "里程碑工作",
  integrating: "集成",
  awaiting_human: "待人工验收",
  accepted: "已验收",
  cancelled: "已取消",
  unfinished: "未完成",
  needs_human: "需人工输入",
}

export class Engine {
  // executor 可注入：默认为 OS 沙箱执行；测试注入假执行器以解耦环境。
  constructor(root, cfg, client, dir = path.join(root, "loca/.runtime"), executor = execute) {
    if (cfg.concurrency < 1 || cfg.attempts < 1 || cfg.depth < 0 || cfg.calls < 1 || cfg.subattempts < 1)
      throw new Error("Invalid workflow limits")
    this.root = root
    this.cfg = cfg
    this.executor = executor
    this.store = new Store(dir)
    this.runner = new Runner(this, client)
    this.active = new Map()
    this.children = new Map()
    this.requests = new Map()
    this.commands = new Map()
    this.activity = new Map()
    this.orchestrates = new Set()
    this.owner = randomUUID()
    this.templates = ["loca", "loca-status", "loca-accept", "loca-cancel", "loca-assumptions"]
      .map((name) =>
        readFileSync(path.join(root, ".aether", "command", `${name}.md`), "utf8")
          .replace(/^---[\s\S]*?---\s*/, "")
          .replaceAll("$ARGUMENTS", "")
          .replace(/\$\d+/g, "")
          .trim(),
      )
      .filter(Boolean)
    this.store.db.exec("CREATE TABLE IF NOT EXISTS leases (session TEXT PRIMARY KEY, owner TEXT, expires INTEGER)")
  }

  report(run, stage, lines) {
    const dir = path.join(this.store.dir, "reports")
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `R${run.round}C${run.cycle}-${stage}.md`)
    const text = [
      `# LOCA 阶段报告：${stage}（第 ${run.round} 轮 / 计划版本 ${run.cycle}）`,
      `时间：${new Date().toISOString()}`,
      "",
      ...lines,
      "",
      "---",
      `阶段纪要全集与本报告同目录：${dir}`,
      `机器可读状态：${this.store.dir}/state.sqlite（runs/jobs/events/assets 四表 + run 行内计划/里程碑/账本）`,
    ].join("\n")
    writeFileSync(file, text, { flag: "w" })
    this.store.event(run, "report_written", { stage, file })
    return file
  }

  latestReport(run) {
    const dir = path.join(this.store.dir, "reports")
    try {
      const files = readdirSync(dir)
        .filter((name) => name.startsWith(`R${run.round}C${run.cycle}`))
        .sort()
      return files.length ? path.join(dir, files.at(-1)) : null
    } catch {
      return null
    }
  }

  guard(run, epoch = run.epoch) {
    if (this.store.byId(run.id)?.epoch !== epoch) throw new Error("STALE: newer user input supersedes this work")
    if (this.active.get(run.id)?.controller.signal.aborted) throw new Error("Workflow cancelled")
  }

  capture(session, message, model) {
    const command = this.commands.get(session)
    this.commands.delete(session)
    if (command && command.action !== "work") {
      this.requests.set(session, command.action)
      const run = this.current()
      if (!run) return
      if (command.action === "cancel") {
        const expected = run.epoch
        run.epoch++
        this.store.save(run, expected)
        this.store.move(run, "cancelled")
        this.active.get(run.id)?.controller.abort()
      }
      return
    }
    const raw =
      command?.text ??
      message.parts
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
    const stripped = this.templates.find((template) => raw.startsWith(template))
    const text = stripped ? raw.slice(stripped.length).trim() : raw
    this.requests.set(session, "work")
    const bare = !text.trim() || text.trim() === "continue"
    let run = this.current()
    if (!run) {
      if (this.store.latest()) run = this.store.latest()
      else run = this.store.create(session)
    }
    if (run.session !== session) {
      const previous = run.session
      run.session = session
      this.store.save(run)
      this.store.event(run, "driver", { from: previous, to: session })
    }
    if (bare) return
    if (
      run.history.some((item) => item.message === message.id) ||
      run.pending.some((item) => item.message === message.id)
    )
      return
    const expected = run.epoch
    run.epoch++
    run.response = null
    run.pending.push({
      message: message.id,
      text,
      files: message.parts
        .filter((part) => part.type === "file")
        .map((part) => ({ url: part.url, mime: part.mime, filename: part.filename })),
    })
    if (model) run.model = model
    try {
      this.store.save(run, expected)
      this.store.event(run, "human_input", { epoch: run.epoch, message: message.id, text })
      this.active.get(this.current()?.id)?.controller.abort()
    } catch {
      this.store.event(run, "human_input_superseded", { message: message.id, text: text.slice(0, 120) })
    }
  }

  packet(
    run,
    value,
    ids = run.assets.flatMap((id) => {
      try {
        return ["report", "port", "packet", "prompt", "policy", "fragment"].includes(this.store.asset(id).kind)
          ? []
          : [id]
      } catch {
        return []
      }
    }),
  ) {
    const stub = (asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      bytes: asset.bytes,
      read: "loca_evidence(id,start,end)",
    })
    const base = {
      version: this.cfg.version,
      round: run.round,
      cycle: run.cycle,
      ...(value && value.slim ? {} : { contract: run.contract }),
      ...value,
    }
    // 显式 id 同样容忍已修剪资产：asset() 抛错若发生在 runner.call 之前不烧
    // calls 预算，frontier 会无限重试同一个必然失败的任务
    const resolved = [...new Set(ids)].flatMap((id) => {
      try {
        return [this.store.asset(id)]
      } catch {
        return []
      }
    })
    const stubBytes = resolved.reduce((total, asset) => total + Buffer.byteLength(JSON.stringify(stub(asset))), 0)
    let budget = Math.max(0, (this.cfg.packet ?? 180000) * 0.6 - Buffer.byteLength(JSON.stringify(base)) - stubBytes)
    const inline = new Set()
    for (let i = resolved.length - 1; i >= 0; i--) {
      const asset = resolved[i]
      const size = Buffer.byteLength(asset.content)
      if (size <= 8000 && budget >= size + 400) {
        inline.add(i)
        budget -= size + 400
      }
    }
    return { ...base, assets: resolved.map((asset, i) => (inline.has(i) ? asset : stub(asset))) }
  }

  current() {
    const held = this.store.db
      .query("SELECT session FROM leases WHERE expires > ? ORDER BY expires DESC")
      .all(Date.now())
    for (const id of this.active.keys()) {
      const run = this.store.byId(id)
      if (run) return run
    }
    for (const session of held.map((row) => row.session)) {
      const run = this.store.run(session) ?? this.byDriver(session)
      if (run) return run
    }
    return this.store.latest()
  }

  byDriver(session) {
    const row = this.store.db
      .query("SELECT run FROM jobs WHERE json_extract(data, '$.parent') = ? ORDER BY rowid DESC LIMIT 1")
      .get(session)
    return row ? this.store.byId(row.run) : null
  }

  async act(session, ctx) {
    const action = this.requests.get(session)
    const query = action === "status" || action === "assumptions"
    const run = this.current()
    if (!run) {
      if (query || action === "work") return "当前项目没有进行中的 LOCA 工作；可用 /loca 输入目标与验收标准。"
      return "请先使用 /loca 输入目标和验收标准。"
    }
    if (run.session !== session) {
      const previous = run.session
      run.session = session
      this.store.save(run)
      this.store.event(run, "driver", { from: previous, to: session })
    }
    if (this.active.has(run.id) && this.active.get(run.id).session !== session) {
      if (run.session !== session) return this.status(run)
    }
    if (action === "status") return this.status(run)
    if (action === "assumptions") {
      this.requests.delete(session)
      return this.renderAssumptions(run)
    }
    if (action === "accept") {
      if (run.phase !== "awaiting_human" || run.pending.length)
        throw new Error("Only the current audited delivery can be accepted")
      this.store.move(run, "accepted", { delivery: run.delivery, by: "human_command" })
      this.requests.delete(session)
      return `已记录用户验收：第 ${run.round} 轮。\n成果与审核包：${run.directory}`
    }
    if (action === "cancel") {
      const expected = run.epoch
      run.epoch++
      this.store.save(run, expected)
      this.store.move(run, "cancelled")
      this.active.get(run.id)?.controller.abort()
      this.requests.delete(session)
      return "LOCA 工作已取消；已有成果和审核记录已保留。"
    }
    if (this.active.has(run.id)) return this.status(run)
    if (!run.pending.length && run.phase === "accepted") return this.status(run)
    if (!run.pending.length && run.phase === "awaiting_human") return run.summary
    if (!run.pending.length && !run.history.length) return "请输入目标与验收标准。"
    // Infra-resume（中断恢复不烧计划版本号）：无新输入、无待处理 replan 信号、
    // 停在 working/integrating 或未完成/取消态 → 回退本次 cycle 计数。
    if (
      run.cycle > 0 &&
      !run.pending.length &&
      !run.planInvalid &&
      (["working", "integrating"].includes(run.phase) || ["unfinished", "cancelled"].includes(run.phase))
    ) {
      run.cycle--
      run.error = null
      this.store.save(run)
      this.store.event(run, "resume", { cycle: run.cycle, phase: run.phase })
    }
    // lease owner 带 pid 前缀：实例重启后新 pid 与旧 owner 不一致即视为旧进程
    // 遗留的死 lease，立即接管（否则续传要干等 90 秒租约过期）
    const owned = (lease) =>
      String(lease?.owner ?? "").startsWith(`pid-${process.pid}#`) || !lease || !(lease.expires > Date.now())
    const acquired = this.store.db.transaction(() => {
      const lease = this.store.db.query("SELECT * FROM leases WHERE session = ?").get(session)
      if (!owned(lease)) return false
      const dead =
        lease && String(lease.owner).startsWith("pid-") && !String(lease.owner).startsWith(`pid-${process.pid}#`)
      this.store.db
        .query("INSERT OR REPLACE INTO leases VALUES (?, ?, ?)")
        .run(session, `pid-${process.pid}#${this.owner}`, Date.now() + 90000)
      if (dead) this.store.event(run, "lease_reclaimed", { previous: lease.owner })
      return true
    })()
    if (!acquired) return "该会话的工作正由另一插件实例执行；请用 /loca-status 查看记录。"
    const heartbeat = setInterval(
      () =>
        this.store.db
          .query("UPDATE leases SET expires = ? WHERE session = ? AND owner = ?")
          .run(Date.now() + 90000, session, `pid-${process.pid}#${this.owner}`),
      20000,
    )
    const controller = new AbortController()
    this.active.set(run.id, { controller, session })
    const stop = () => controller.abort()
    ctx.abort?.addEventListener("abort", stop, { once: true })
    if (ctx.abort?.aborted) stop()
    return this.work(run)
      .catch((error) => {
        const current = this.current()
        if (current && current.id === run.id && current.epoch !== run.epoch) {
          this.store.event(current, "superseded", { previous: run.epoch })
          return current.phase === "cancelled"
            ? "工作已取消，旧结果不会推进流程。"
            : "已保存新意见，并停止旧轮次。请使用 /loca continue 开始新一轮。"
        }
        this.store.move(
          run,
          controller.signal.aborted ? "cancelled" : run.phase === "needs_human" ? "needs_human" : "unfinished",
          { error: Engine.explain(error) },
        )
        run.error = String(error)
        this.store.save(run)
        return this.status(run)
      })
      .finally(() => {
        clearInterval(heartbeat)
        ctx.abort?.removeEventListener("abort", stop)
        this.active.delete(run.id)
        this.store.db
          .query("DELETE FROM leases WHERE session = ? AND owner = ?")
          .run(session, `pid-${process.pid}#${this.owner}`)
        this.requests.delete(session)
      })
  }

  async work(run) {
    const store = this.store
    const entryPhase = run.phase
    await parallel(
      store.jobs(run).filter((job) => ["preparing", "running", "checking", "correcting"].includes(job.status)),
      this.cfg.concurrency,
      async (job) => {
        // 中断恢复：上次实例遗留的在飞 job 保留 session 与上下文目录，标记
        // interrupted 等待原会话续传（同 role+slot+packet 才命中；packet 变化的
        // 调度不会匹配，由重调度自然重做）
        store.job(run, job, "interrupted", { reason: "Interrupted execution recovered" })
        store.event(run, "job_resumable", {
          job: job.id,
          role: job.role,
          slot: job.slot,
          session: job.session,
          note: "会话保留待续传；continue 后由 runner 原会话恢复",
        })
      },
    )
    if (run.pending.length) {
      if (run.contract) run.previous = run.contract
      run.history.push(...run.pending)
      run.pending = []
      run.round++
      run.cycle = 0
      run.calls = 0
      run.error = null
      run.contract = null
      run.summary = null
      run.delivery = null
      run.integrated = null
      run.plan = null
      run.planInvalid = false
      run.milestones = {}
      run.ledger = []
      run.verifiers = {}
      run.subresults = {}
      run.subreports = {}
      store.save(run)
      store.put(run, "policy", "workflow.json", JSON.stringify(this.cfg))
    }
    if (!run.contract) await this.contractPhase(run)
    void entryPhase
    for (; run.cycle < this.cfg.cycles; ) {
      this.guard(run)
      // 恢复/取消后重入 frontier：phase 回到 working（原实现只在 taskSolve 里
      // move，纯 gate/vaudit 调度期 run 会一直显示 cancelled/unfinished）
      if (!["working", "integrating", "needs_human"].includes(run.phase)) store.move(run, "working")
      run.cycle++
      store.save(run)
      if (!run.plan || run.planInvalid || run.plan.round !== run.round) await this.planPhase(run)
      const outcome = await this.frontier(run)
      // needs_human 是暂停信号（如 triage 持续不可用升级）：保持暂停态返回，
      // 不能落入 replan 分支被下一 cycle 的重规划覆盖
      if (run.phase === "needs_human") return this.status(run)
      if (outcome === "replan") {
        run.planInvalid = true
        store.save(run)
        continue
      }
      if (await this.integratePhase(run)) {
        this.guard(run)
        store.move(run, "awaiting_human", { delivery: run.delivery })
        return run.summary
      }
      run.planInvalid = true
      store.save(run)
    }
    throw new Error("Plan-version budget exhausted; no accepted result was produced")
  }

  async contractPhase(run) {
    const store = this.store
    store.move(run, "contract")
    const raw = store.put(run, "input", "human-input.json", JSON.stringify(run.history))
    const contract = await this.runner.call(
      run,
      "contract",
      this.packet(run, { previous: run.previous ?? null, history: run.history }, [raw.id]),
      (value) => {
        exact(
          value.criteria.map((item) => item.id),
          [...new Set(value.criteria.map((item) => item.id))],
          "criteria",
        )
        const anchors = [run.history.map((item) => item.text).join("\n")]
        for (const row of store.db
          .query(
            "SELECT data FROM assets WHERE json_extract(data, '$.run') = ? AND json_extract(data, '$.kind') IN ('input', 'source')",
          )
          .all(run.id)
          .map((row) => JSON.parse(row.data)))
          anchors.push(store.asset(row.id).content)
        if (value.criteria.some((item) => !anchors.some((text) => text.includes(item.origin))))
          throw new Error("Criterion origin must quote human input or registered evidence")
        if (value.removed.some((item) => !run.history.at(-1).text.includes(item.quote)))
          throw new Error("Removing a criterion requires a quote from current user feedback")
        run.previous?.criteria.forEach((item) => {
          if (!value.criteria.some((next) => next.id === item.id) && !value.removed.some((next) => next.id === item.id))
            throw new Error(`Old criterion silently lost: ${item.id}`)
        })
      },
    )
    const fidelity = await this.runner.call(
      run,
      "fidelity",
      this.packet(
        run,
        {
          checks: this.cfg.checks.contract,
          history: run.history,
          previous: run.previous ?? null,
          proposed: contract.value,
        },
        [raw.id, contract.record.id],
      ),
      (value) => review(value, this.cfg.checks.contract),
    )
    const blocking = contract.value.questions.filter((item) => item.blocking)
    run.questions = contract.value.questions.filter((item) => !item.blocking)
    if (blocking.length || fidelity.value.verdict !== "pass") {
      store.move(run, "needs_human", { questions: blocking, review: fidelity.value })
      throw new Error(this.renderClarification(blocking, fidelity.value))
    }
    run.contract = contract.value
    store.save(run)
    store.event(run, "stage", {
      stage: "contract",
      round: run.round,
      cycle: run.cycle,
      summary: `合约已确立：目标「${run.contract.goal.slice(0, 80)}」，验收标准 ${run.contract.criteria.length} 条（${run.contract.criteria.map((c) => c.id).join("、")}）`,
    })
    this.report(run, "contract", [
      "## 本阶段完成的工作",
      "根据你的输入确立了合约（goal）与验收标准（criteria）。",
      "",
      "### 目标",
      run.contract.goal,
      "",
      "### 验收标准",
      ...run.contract.criteria.map((c) => `- **${c.id}**：${c.text}（验证方式：${c.method}）`),
      "",
      "## 下一阶段计划",
      "规划（planner）：产出问题图——子问题、预期引用与预注册验证方案。",
    ])
  }

  async planPhase(run) {
    const store = this.store
    store.move(run, "planning")
    const verified = Object.values(run.milestones)
      .filter((m) => m.status === "verified")
      .map((m) => ({ id: m.id, statement: m.statement.slice(0, 160), strength: m.strength }))
    const priorPlan = run.plan
      ? {
          version: run.plan.version,
          strategy: run.plan.strategy.slice(0, 400),
          subproblems: run.plan.subproblems.map((sub) => ({
            id: sub.id,
            goal: sub.goal.slice(0, 120),
            status: run.subresults[sub.id]?.status ?? "unattempted",
          })),
        }
      : null
    const plan = await this.runner.call(
      run,
      "planner",
      this.packet(run, {
        priorPlan,
        verified,
        feedback: run.feedback ?? null,
        history: run.history,
      }),
      (value) => {
        planCheck(value, run.contract)
        if (run.plan)
          for (const sub of value.subproblems)
            if (sub.migratedFrom && !run.plan.subproblems.some((old) => old.id === sub.migratedFrom))
              throw new Error(`Subproblem ${sub.id} declares migratedFrom unknown subproblem ${sub.migratedFrom}`)
      },
    )
    // 语义迁移（planner 声明的 oldSub → newSub）：在任何清理之前执行，
    // 保住已实现验证器与审核状态
    const previousPlan = run.plan
    const migration = {}
    if (previousPlan)
      for (const sub of plan.value.subproblems)
        if (sub.migratedFrom && previousPlan.subproblems.some((old) => old.id === sub.migratedFrom))
          migration[sub.migratedFrom] = sub.id
    let migrated = { migrated: [], skipped: [] }
    if (Object.keys(migration).length) {
      migrated = migrateSubproblems(run, migration)
      store.event(run, "semantic_migration", { ...migrated, mapping: migration })
    }
    run.plan = { version: (run.plan?.version ?? 0) + 1, cycle: run.cycle, round: run.round, ...plan.value }
    run.planInvalid = false
    run.pendingRollback = null
    // 孤儿里程碑：owner 子问题已不在新计划中。verified 的保留为可复用证据；
    // 未完成审核的 supersede——新计划不再资助它们的审核，否则 assess 永远等不到它们收敛
    const ids = new Set(run.plan.subproblems.map((sub) => sub.id))
    for (const m of Object.values(run.milestones)) {
      // 迁移冲突放弃的里程碑同样走孤儿清理：owner 已不在新计划，保留只会
      // 挡住 assess（无人重审无人消费）；冲突详情已在 semantic_migration 事件留痕
      if (!ids.has(m.subproblem) && !["verified", "superseded", "draft"].includes(m.status)) {
        m.history.push({ version: m.version, statement: m.statement, scope: m.scope, status: m.status })
        m.status = "superseded"
        m.supersededBy = "replan:orphaned"
      }
    }
    store.save(run)
    store.event(run, "stage", {
      stage: "planning",
      round: run.round,
      cycle: run.cycle,
      summary: `计划 v${run.plan.version}：${plan.value.subproblems.length} 个子问题——${plan.value.subproblems.map((s) => s.id).join("、")}；锚类型 ${plan.value.subproblems.map((s) => `${s.id}:${s.verification.anchor}`).join("、")}`,
    })
    this.report(run, "planning", [
      "## 本阶段完成的工作",
      `产出问题图 v${run.plan.version}：${plan.value.subproblems.length} 个子问题。`,
      "",
      "### 求解策略",
      plan.value.strategy.slice(0, 800),
      "",
      "### 子问题划分（目标抗失效性 + 预注册验证方案）",
      ...plan.value.subproblems.map(
        (sub) =>
          `- **${sub.id}**（标准 ${sub.criteria.join("、")}；预期引用 ${sub.expectedRefs.join("、") || "无"}；锚 ${sub.verification.anchor}）：${sub.goal.slice(0, 120)}\n  - 验证方案：${sub.verification.spec.slice(0, 200)}\n  - 抗失效性：${sub.robustness.slice(0, 160)}`,
      ),
      "",
      "## 下一阶段计划",
      "frontier 事件驱动循环：并行求解子问题；达成里程碑即 gate→快检→深审（e2e/semi/unit/adversarial/compat），审核与后续求解并行推进。",
    ])
  }

  // ---- frontier：事件驱动调度核心 ----
  // 每轮迭代：计算可运行任务 → 并行派发（受并发与推测深度约束）→ 等任一完成
  // → 状态落账并重算。C 类失败即时中止推测性任务（任务级 AbortController）。

  async frontier(run) {
    const store = this.store
    const tasks = new Map()
    // 活锁护栏：确定性失败若绕过一切预算约束，在此强制终止而不是烧干时间
    for (let spin = 0; spin < 5000; spin++) {
      this.guard(run)
      // needs_human 是 work 级暂停（如 triage 持续不可用升级）：停止调度，
      // 等在飞任务自然收尾后退出
      if (run.phase === "needs_human") {
        while (tasks.size) await Promise.all([...tasks.keys()])
        return "replan"
      }
      // C 类回滚已标记：中止依赖闭包内的在飞 solve，等独立任务自然收尾后退出重规划
      if (run.planInvalid) {
        if (run.pendingRollback?.length) {
          const doomed = new Set(run.pendingRollback)
          run.pendingRollback = null
          store.save(run)
          for (const [, entry] of tasks)
            if (entry.task.kind === "solve" && doomed.has(entry.task.sub)) entry.controller.abort()
        }
        while (tasks.size) await Promise.all([...tasks.keys()])
        return "replan"
      }
      for (const task of this.readyTasks(run)) {
        if (tasks.size >= this.cfg.concurrency) break
        // solve 的去重键归一化为 (kind, sub)：triage 重开改变 mode 后，旧 mode 的
        // 在飞任务与新 mode 任务同时调度会造成同一子问题双重版本递增竞态
        const key = task.kind === "solve" ? `solve:${task.sub}` : JSON.stringify(task)
        if ([...tasks.values()].some((t) => t.key === key)) continue
        const controller = new AbortController()
        const promise = this.runTask(run, task, controller)
          .catch((error) => {
            if (String(error).includes("LOCA_TASK_ABORTED")) return
            if (/Workflow cancelled|STALE|LOCA_TASK_ABORTED|LOCA_CALL_ABORTED/.test(String(error))) throw error
            // 任务级失败：记录并把失败落到实体上，由 assess 决断。
            // 取消类错误（runwide/task abort）不算任务失败——job 已标 cancelled，
            // 里程碑状态不应被 infra finding 污染（否则取消→continue 后 gate
            // 要整轮重跑，已升格的审判全部作废）
            store.event(run, "task_error", { task, error: String(error).slice(0, 400) })
            this.taskFailed(run, task, error)
          })
          .finally(() => tasks.delete(promise))
        tasks.set(promise, { task, controller, key })
      }
      if (!tasks.size) {
        const verdict = this.assess(run)
        if (verdict === "done") return "done"
        if (verdict.replan) {
          run.feedback = verdict.feedback ?? null
          store.event(run, "stage", {
            stage: "replan",
            round: run.round,
            cycle: run.cycle,
            summary: `触发重规划：${verdict.reason}`,
          })
          return "replan"
        }
        throw new Error(verdict.reason)
      }
      await Promise.race(tasks.keys())
    }
    throw new Error("frontier livelock suspected: 5000 scheduling iterations without progress")
  }

  // 纯状态投影：当前可调度的任务集合。
  readyTasks(run) {
    const out = []
    const active = Object.values(run.milestones).filter((m) => m.status !== "superseded")
    // 1) triage：深审失败且未分类的里程碑
    for (const m of active) if (m.status === "failed" && !m.impact) out.push({ kind: "triage", milestone: m.id })
    // 2) anchor：提案需要验证方案实现（计划主里程碑的程序锚）或独立提出（涌现）
    for (const m of active) {
      if (m.status !== "proposed") continue
      const v = m.verification
      const needsImplement = v.mode === "implement" && v.anchor === "programmatic" && !v.verifier
      const needsPropose = v.mode === "propose" && !v.anchor
      if (needsImplement || needsPropose) out.push({ kind: "anchor", milestone: m.id })
    }
    // 3) gate：验证方案就绪但未裁决。
    // 程序化短路：前提不可用（failed/stale/draft）时不调度 gate——否则引擎预检
    // 拒绝 promote → correction 耗尽 → failed → triage 级联。前提自身的生命周期
    // （triage 重开/回滚/刷新）恢复后，gate 自然可调度。
    const nameIndex = this.nameIndexFor(run)
    for (const m of active) {
      if (m.status !== "proposed") continue
      const v = m.verification
      const ready = v.mode === "propose" ? !!v.anchor : v.anchor === "programmatic" ? !!v.verifier : !!v.spec
      if (!ready) continue
      if (!closureOk(run, m, nameIndex).ok) continue
      out.push({ kind: "gate", milestone: m.id })
    }
    // 4) vaudit：gated 的程序锚验证器待审计
    for (const m of active) {
      if (m.status !== "gated") continue
      if (m.verification.anchor === "programmatic" && run.verifiers[m.id]?.status === "draft")
        out.push({ kind: "vaudit", milestone: m.id })
    }
    // 5) quick：gated 且验证器已 trusted
    for (const m of active) {
      if (m.status !== "gated") continue
      if (m.verification.anchor === "programmatic" && run.verifiers[m.id]?.status === "trusted")
        out.push({ kind: "quick", milestone: m.id })
    }
    // 6) quick rerun：B 类刷新（stale 状态且验证器 trusted）
    for (const m of active) {
      if (m.status === "stale" && run.verifiers[m.id]?.status === "trusted")
        out.push({ kind: "quick", milestone: m.id, rerun: true })
    }
    // 7) 深审组件：quick_checked 里程碑
    for (const m of active) {
      if (m.status !== "quick_checked") continue
      const spec = deepSpec(run, m)
      const review = m.review
      if (spec.e2e && !review.e2e) out.push({ kind: "e2e", milestone: m.id })
      if (!review.adversarial) out.push({ kind: "adversarial", milestone: m.id })
      if (!review.compat) out.push({ kind: "compat", milestone: m.id })
      for (const branch of m.branches)
        if (!(review.branches ?? []).some((b) => b.id === branch.id))
          out.push({ kind: "branch", milestone: m.id, branch: branch.id })
      for (const unit of review.unitPlan ?? [])
        if (!(review.units ?? []).some((u) => u.id === unit)) out.push({ kind: "unit", milestone: m.id, unit })
    }
    // 8) solve：pre-flight 通过（含推测预算）且无在办结果的子问题
    for (const sub of run.plan.subproblems) {
      const result = run.subresults[sub.id]
      if (result?.status === "completed" || result?.status === "blocked") continue
      if (result?.failed && (result.attempts ?? 0) >= this.cfg.subattempts) continue
      const flight = speculationOk(run, sub.id, this.cfg.depth)
      if (!flight.ok) continue
      const mode = !result
        ? "attack"
        : result.feedback?.kind === "patch"
          ? "patch"
          : result.feedback?.kind === "refresh"
            ? "refresh"
            : result.feedback?.kind === "continue"
              ? "continue"
              : "refine"
      out.push({ kind: "solve", sub: sub.id, mode })
    }
    return out
  }

  // 迟到结果守卫：任务执行期间里程碑可能被版本递增/回滚/刷新改写状态，
  // 迟到的组件结果（深审各席、快检、gate 等）不得写回——否则会把 superseded
  // 覆盖成 failed、把新版本的 review 混入旧结果。
  staleResult(run, m, version, where) {
    if (m.status === "superseded" || m.version !== version) {
      this.store.event(run, "stale_result_dropped", { milestone: m.id, version, status: m.status, where })
      return true
    }
    return false
  }

  async runTask(run, task, controller) {
    switch (task.kind) {
      case "solve":
        return await this.taskSolve(run, task, controller)
      case "anchor":
        return await this.taskAnchor(run, run.milestones[task.milestone], controller)
      case "gate":
        return await this.taskGate(run, run.milestones[task.milestone], controller)
      case "vaudit":
        return await this.taskVaudit(run, run.milestones[task.milestone], controller)
      case "quick":
        return await this.taskQuick(run, run.milestones[task.milestone], task.rerun ?? false, controller)
      case "adversarial":
        return await this.taskAdversarial(run, run.milestones[task.milestone], controller)
      case "e2e":
        return await this.taskE2E(run, run.milestones[task.milestone], controller)
      case "branch":
        return await this.taskBranch(run, run.milestones[task.milestone], task.branch, controller)
      case "unit":
        return await this.taskUnit(run, run.milestones[task.milestone], task.unit, controller)
      case "compat":
        return await this.taskCompat(run, run.milestones[task.milestone], controller)
      case "triage":
        return await this.taskTriage(run, run.milestones[task.milestone], controller)
      default:
        throw new Error(`Unknown task kind ${task.kind}`)
    }
  }

  taskFailed(run, task, error) {
    if (task.kind === "solve") {
      const prior = run.subresults[task.sub]
      run.subresults[task.sub] = {
        ...(prior ?? {}),
        status: "working",
        failed: true,
        // 计入 attempts：确定性失败（如 packet 构建抛错）若不烧预算也不计次，
        // 会绕过 subattempts 上限形成无限重试
        attempts: (prior?.attempts ?? 0) + 1,
        artifacts: prior?.artifacts ?? [],
        claims: prior?.claims ?? [],
        problems: [...(prior?.problems ?? [])],
        reason: String(error).slice(0, 500),
      }
    } else if (task.milestone) {
      const m = run.milestones[task.milestone]
      if (m && m.status !== "verified" && m.status !== "superseded") {
        m.status = "failed"
        m.review.findings = [
          ...(m.review.findings ?? []),
          {
            id: `${m.id}-infra`,
            target: m.id,
            detail: `${task.kind} 任务失败：${String(error).slice(0, 200)}`,
            evidence: m.artifacts.slice(0, 4),
            repair: "human",
            blocking: true,
          },
        ]
      }
    }
    this.store.save(run)
  }

  // 资产名索引（封闭性检查/输入解析用）。
  // 缓存键 (run.id, run.assets.length)：资产只增不减，长度变化即失效。
  // 用 metadata() 构建——不做 blob 重读与哈希；readyTasks 每次调度迭代都要
  // 封闭性检查，全量 asset() 重哈希会让调度循环随资产数平方级变慢。
  nameIndexFor(run) {
    if (this.indexCache && this.indexCache.run === run.id && this.indexCache.count === run.assets.length)
      return this.indexCache.map
    const map = new Map()
    for (const id of run.assets) {
      let record
      try {
        record = this.store.metadata(id)
      } catch {
        continue
      }
      if (!["input", "source", "artifact", "code", "execution", "verifier"].includes(record.kind)) continue
      const key = (record.name ?? "").trim()
      if (!map.has(key)) map.set(key, [record])
      else map.get(key).push(record)
    }
    this.indexCache = { run: run.id, count: run.assets.length, map }
    return map
  }

  premises(run) {
    return Object.values(run.milestones)
      .filter((m) => ["verified", "quick_checked"].includes(m.status))
      .map((m) => ({
        id: m.id,
        version: m.version,
        status: m.status,
        strength: m.strength,
        statement: m.statement,
        scope: m.scope.slice(0, 200),
        values: m.values,
        artifacts: m.artifacts,
      }))
  }

  async taskSolve(run, task, controller) {
    const store = this.store
    const sub = run.plan.subproblems.find((item) => item.id === task.sub)
    const prior = run.subresults[sub.id] ?? null
    const priorImpacts = new Map(Object.entries(run.milestones).map(([id, m]) => [id, m.impact?.class ?? null]))
    const priors = run.plan.subproblems
      .filter((item) => run.subresults[item.id])
      .map((item) => ({
        id: item.id,
        status: run.subresults[item.id].status,
        artifacts: run.subresults[item.id].artifacts,
        claims: run.subresults[item.id].claims,
      }))
    store.move(run, "working")
    const result = await this.runner
      .call(
        run,
        "solve",
        this.packet(run, {
          mode: task.mode,
          plan: {
            strategy: run.plan.strategy,
            subproblem: {
              id: sub.id,
              goal: sub.goal,
              criteria: sub.criteria,
              expectedRefs: sub.expectedRefs,
              verification: sub.verification,
              robustness: sub.robustness,
            },
            priors: priors.filter((item) => item.id !== sub.id),
            premises: this.premises(run),
          },
          ...(prior ? { prior: { ...prior, incremental: true } } : {}),
          feedback: prior?.feedback ?? null,
          history: run.history,
        }),
        (value) => {
          const contractIds = new Set(run.contract.criteria.map((item) => item.id))
          for (const proposal of value.milestones)
            proposal.criteria.forEach((id) => {
              if (!contractIds.has(id))
                throw new Error(`Milestone proposal ${proposal.id} references unknown criterion ${id}`)
            })
          if (value.status === "blocked" && !value.reason.trim()) throw new Error("blocked requires a reason")
          // 输入可解析性（判据 2 的申报侧）：提前打回不可解析的输入
          const nameIndex = this.nameIndexFor(run)
          for (const proposal of value.milestones)
            for (const input of proposal.inputs) {
              if (input.from === "internal") continue
              if (!resolveInput(run, input.from, nameIndex))
                throw new Error(
                  `Milestone ${proposal.id} input "${input.from}" 无法解析：应为已知里程碑 id/短名、已注册资产名，或字面 "internal"`,
                )
            }
          // 冻结输入不得作为里程碑产物（v2 solved() 的 source/input 禁令）：
          // 前提与成果混淆会让验证器检验外部材料而非本项工作
          for (const id of [...value.artifacts, ...value.milestones.flatMap((p) => p.artifacts)]) {
            const kind = store.asset(id)?.kind
            if (kind === "source" || kind === "input")
              throw new Error(
                `冻结来源 ${id} 被当作产出物引用：里程碑产物必须是本项工作产出（artifact/code/execution），来源属于 evidence`,
              )
          }
          // 防静默删除：缺失的旧问题自动继承为 open；克隆合并
          retainProblems(value, prior)
          // completed 不允许携带未决问题（v2：completed candidate has unresolved problems）
          if (value.status === "completed" && value.problems.some((p) => p.status === "open"))
            throw new Error(
              `status=completed 但存在未决问题（${value.problems
                .filter((p) => p.status === "open")
                .map((p) => p.id)
                .join("、")}）：继续解决后申报，或如实申报 working`,
            )
        },
        task.sub,
        controller,
      )
      .catch((error) => {
        if (/Workflow cancelled|STALE|LOCA_TASK_ABORTED/.test(String(error))) throw error
        return {
          value: {
            status: "working",
            failed: true,
            artifacts: prior?.artifacts ?? [],
            milestones: [],
            claims: prior?.claims ?? [],
            // 只继承模型工作问题（防静默删除）；infra 错误记在 reason——
            // 不进 problems，否则模型无法用证据关闭它，恢复被 completed 检查卡死
            problems: [...(prior?.problems ?? [])],
            reason: String(error).slice(0, 500),
          },
          record: { id: null },
        }
      })
    run.subresults[sub.id] = result.value
    run.subresults[sub.id].attempts = (prior?.attempts ?? 0) + 1
    run.subreports[sub.id] = result.record.id
    // 里程碑提案注册（版本递增 + 账本更新）
    const versions = Object.values(run.milestones).map((m) => `${m.id}@${m.version}`)
    registerProposals(run, sub, result.value)
    // B 类传播：先前被判定为 B 的里程碑新版本落地 → 下游三态刷新
    for (const m of Object.values(run.milestones)) {
      if (!versions.includes(`${m.id}@${m.version}`) && m.version > 1 && priorImpacts.get(m.id) === "B") {
        const effects = propagateB(run, m.id)
        this.applyPropagation(run, m, effects)
      }
    }
    // 排空窗口竞态兜底：本次注册的里程碑若依赖不可用前提（典型：C 类回滚计算后、
    // 推测性 solve 在排空期间完成），直接落 draft 并重开 owner——
    // 不能让建立在失效前提上的提案进入 gate/审核管线
    for (const m of milestonesOf(run, sub.id)) {
      if (m.status !== "proposed" || versions.includes(`${m.id}@${m.version}`)) continue
      const closure = closureOk(run, m, this.nameIndexFor(run))
      if (!closure.ok) {
        m.status = "draft"
        this.reopen(
          run,
          sub.id,
          "continue",
          `里程碑 ${m.id} 的前提当前不可用（${closure.reason}）：待前提恢复后重新申报`,
        )
        store.event(run, "premise_wait", { milestone: m.id, reason: closure.reason })
      }
    }
    this.store.save(run)
    const verified = Object.values(run.milestones).filter((m) => m.status === "verified").length
    this.store.event(run, "stage", {
      stage: "solve",
      round: run.round,
      cycle: run.cycle,
      detail: sub.id,
      summary: `子问题 ${sub.id}（${task.mode}）：${result.value.status === "completed" ? "完成" : result.value.status === "working" ? "有进展" : "被阻塞"}；累计里程碑 ${Object.values(run.milestones).filter((m) => m.status !== "superseded").length} 个（已验证 ${verified}）`,
    })
    this.report(run, `solve-${sub.id}`, [
      "## 本阶段完成的工作",
      `子问题 **${sub.id}**（模式 ${task.mode}）求解会话结束：**${result.value.status}**。`,
      "",
      "### 里程碑提案",
      ...(result.value.milestones.length
        ? result.value.milestones.map(
            (p) => `- **${sub.id}:${p.id}**：${p.statement.slice(0, 160)}（适用域：${p.scope.slice(0, 80)}）`,
          )
        : ["（无新提案）"]),
      "",
      "### 已验证里程碑注册表",
      ...(Object.values(run.milestones)
        .filter((m) => m.status === "verified")
        .map((m) => `- ${m.id} v${m.version}（${m.strength}）：${m.statement.slice(0, 120)}`) || ["（暂无）"]),
    ])
    if (result.value.status === "blocked") {
      run.planInvalid = true
      run.feedback = {
        verdict: "fail",
        findings: [
          { id: "B1", target: sub.id, detail: result.value.reason, evidence: [], repair: "plan", blocking: true },
        ],
      }
      this.store.save(run)
    }
  }

  applyPropagation(run, changed, effects) {
    const store = this.store
    store.event(run, "propagation", { milestone: changed.id, ...effects })
    for (const edge of effects.planStale ?? [])
      store.event(run, "plan_edge_stale", { consumer: edge, premise: changed.subproblem })
    for (const id of effects.staleManual ?? []) {
      const m = run.milestones[id]
      if (m)
        this.reopen(
          run,
          m.subproblem,
          "refresh",
          `前提 ${changed.id} 结论已更新（v${changed.version}），里程碑 ${id} 标记 stale；请复核后重新申报或确认不变`,
        )
    }
    this.report(run, `propagation-${changed.id}`, [
      "## 本阶段完成的工作",
      `里程碑 **${changed.id}** 新版本 v${changed.version} 落地，B 类传播完成：`,
      `- 验证器重跑（通过即止）：${effects.rerun?.join("、") || "无"}`,
      `- 标记 stale 待人工复核重报：${effects.staleManual?.join("、") || "无"}`,
      `- 计划边 stale（未开工子问题，调度时自动消费新版本）：${effects.planStale?.join("、") || "无"}`,
    ])
  }

  reopen(run, subId, kind, note) {
    const result = run.subresults[subId]
    if (!result || result.status === "completed") {
      run.subresults[subId] = {
        ...(result ?? { artifacts: [], claims: [], problems: [] }),
        status: "working",
        feedback: { kind, note, findings: [] },
      }
    } else result.feedback = { kind, note, findings: [] }
  }

  async taskAnchor(run, m, controller) {
    const mode = m.verification.mode
    const version = m.version
    const anchored = await this.runner
      .call(
        run,
        "anchor",
        this.packet(
          run,
          {
            mode,
            milestone: {
              id: m.id,
              statement: m.statement,
              scope: m.scope,
              artifacts: m.artifacts,
              values: m.values,
            },
            // implement：计划预注册的锚类型与规格；propose：独立提出方案。
            // anchor 不看 solve 的推导产物——验证方案必须独立于推导路径。
            registered: mode === "implement" ? { anchor: m.verification.anchor, spec: m.verification.spec } : null,
            premises: this.premises(run).filter((p) => p.status === "verified"),
          },
          [
            ...m.artifacts,
            ...run.assets.filter((id) => {
              try {
                return ["input", "source"].includes(this.store.metadata(id).kind)
              } catch {
                return false
              }
            }),
          ],
        ),
        (value, context) => {
          if (mode === "implement") {
            if (value.anchor !== m.verification.anchor)
              throw new Error(`实现模式必须沿用预注册锚类型 ${m.verification.anchor}，不能改为 ${value.anchor}`)
          }
          if (value.anchor === "programmatic") {
            if (!value.verifier?.trim()) throw new Error("programmatic 锚必须提供验证器 Python 源码")
            if (!value.inputs.length) throw new Error("programmatic 锚必须声明验证器消费的资产名（inputs 非空）")
            // 白名单 = 本里程碑产物 ∪ 根资产（input/source）。验证方案常需对照
            // 源文件（如按 sha256 校验冻结闭环），只许用里程碑产物会堵死合法验证
            const names = new Set(m.artifacts.map((id) => this.store.asset(id).name))
            for (const id of run.assets) {
              try {
                const asset = this.store.metadata(id)
                if (["input", "source"].includes(asset.kind)) names.add(asset.name)
              } catch {}
            }
            const missing = value.inputs.filter((name) => !names.has(name))
            if (missing.length)
              throw new Error(
                `验证器输入 ${missing.map((n) => `"${n}"`).join("、")} 不在可用资产中；可用：本里程碑产物 ${m.artifacts.map((id) => this.store.asset(id).name).join("、")} 或根资产（packet 中 kind 为 input/source 的资产名）`,
              )
          }
          if (value.anchor !== "programmatic" && value.verifier) throw new Error("非程序锚不应提交验证器代码")
          if (value.anchor === "programmatic" && value.verifier) {
            // 内嵌压缩 payload 是审计黑洞；但 zlib/lzma 可能是被检验的功能本身——
            // 只拦真实 payload 特征：解码调用 × 长编码字面量的组合
            const decoder = /b85decode|b64decode|zlib\.decompress|lzma\.decompress|a2b_\w+|decodebytes/i
            const blobLiteral = /["'][A-Za-z0-9+/=]{200,}["']/
            if (decoder.test(value.verifier) && blobLiteral.test(value.verifier))
              throw new Error(
                "验证器源码含解码调用+长编码字面量（内嵌压缩 payload）：对照数据请通过 inputs 引用资产、程序生成或明文常量；若解码是被检验功能本身，数据同样应来自 LOCA_INPUTS",
              )
          }
          void context
        },
        m.id,
        controller,
      )
      .catch((error) => {
        if (/Workflow cancelled|STALE|LOCA_TASK_ABORTED/.test(String(error))) throw error
        m.verification = { ...m.verification, anchorError: String(error).slice(0, 300) }
        this.store.save(run)
        throw error
      })
    if (this.staleResult(run, m, version, "anchor")) return
    const value = anchored.value
    const verifierAssetId = value.verifier
      ? this.store.put(run, "verifier", `${m.id}-v${m.version}.py`, value.verifier, { milestone: m.id }).id
      : null
    anchorResult(run, m, value, verifierAssetId)
    this.store.save(run)
    this.store.event(run, "stage", {
      stage: "anchor",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary: `里程碑 ${m.id} 验证方案就绪（${value.anchor}锚${verifierAssetId ? "，验证器待审计" : ""}）`,
    })
  }

  async taskGate(run, m, controller) {
    const version = m.version
    const sub = run.plan.subproblems.find((item) => item.id === m.subproblem)
    const nameIndex = this.nameIndexFor(run)
    const closure = closureOk(run, m, nameIndex)
    const ref = referenced(run, m)
    const gate = await this.runner.call(
      run,
      "gate",
      this.packet(
        run,
        {
          milestone: {
            id: m.id,
            kind: m.kind,
            version: m.version,
            statement: m.statement,
            scope: m.scope,
            criteria: m.criteria,
            inputs: m.inputs,
            branches: m.branches,
            highRisk: m.highRisk,
            values: m.values,
            artifacts: m.artifacts,
            verification: m.verification,
          },
          sub: { id: sub.id, goal: sub.goal, criteria: sub.criteria },
          // merge 候选父级（语义判断的素材）：同子问题或计划邻接的已注册里程碑
          mergeCandidates: Object.values(run.milestones)
            .filter(
              (other) =>
                other.id !== m.id &&
                other.status !== "superseded" &&
                other.status !== "draft" &&
                (other.subproblem === m.subproblem ||
                  run.plan.subproblems
                    .find((item) => item.id === m.subproblem)
                    ?.expectedRefs.includes(other.subproblem) ||
                  run.plan.subproblems
                    .find((item) => item.id === other.subproblem)
                    ?.expectedRefs.includes(m.subproblem)),
            )
            .slice(0, 8)
            .map((other) => ({ id: other.id, statement: other.statement.slice(0, 160), status: other.status })),
          engineChecks: {
            closure: { ok: closure.ok, reason: closure.reason ?? null },
            reference: ref,
          },
        },
        m.artifacts,
      ),
      (value) => {
        // gate 的 decision 不映射为 verdict：merge/continue 是合法裁决而非审核失败
        exact(
          value.checks.map((check) => check.id),
          this.cfg.checks.gate,
          "gate checks",
        )
        if (value.mergeInto && !run.milestones[value.mergeInto])
          throw new Error(
            `mergeInto 指向未注册里程碑 ${value.mergeInto}；可用候选见 packet.mergeCandidates，原样复制其 id`,
          )
        if (value.mergeInto && (value.mergeInto === m.id || run.milestones[value.mergeInto]?.status === "superseded"))
          throw new Error("mergeInto 不能指向自身或已归档里程碑")
        if (value.decision === "promote") {
          if (value.checks.some((check) => check.status !== "pass"))
            throw new Error("升格要求三项判据（statement/anchor/mass）检查全部通过")
          if (value.findings.some((item) => item.blocking))
            throw new Error("升格与阻断发现矛盾：存在问题时应裁决 merge/continue")
          if (!closure.ok || !ref)
            throw new Error(`引擎预检未过不能升格：closure=${closure.ok ? "ok" : closure.reason}；reference=${ref}`)
        }
      },
      m.id,
      controller,
    )
    if (this.staleResult(run, m, version, "gate")) return
    const value = gate.value
    const outcome = gateDecision(run, m, value)
    this.store.save(run)
    this.store.event(run, "stage", {
      stage: "gate",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary:
        outcome === "promote"
          ? `里程碑 ${m.id} v${m.version} 升格（${m.verification.anchor}锚）→ ${m.verification.anchor === "programmatic" ? "验证器审计→快检" : "深审"}`
          : outcome === "merged"
            ? `提案 ${m.id} 并入父里程碑作为 semi-e2e 分支`
            : `提案 ${m.id} 未逻辑封闭，回到 solve 继续累积`,
    })
    if (outcome === "continue") {
      this.reopen(run, m.subproblem, "continue", `gate 判定提案未逻辑封闭：${value.note.slice(0, 200)}`)
      this.store.save(run)
    }
  }

  async taskVaudit(run, m, controller) {
    const version = m.version
    const verifier = this.store.asset(run.verifiers[m.id].asset)
    // 根资产（验证器可能声明为输入）对 vaudit 可见：阴性对照需要真实注入这些资产
    const vRootNames = new Set(m.verification.verifierInputs ?? [])
    const vRoots = run.assets.filter((id) => {
      if (m.artifacts.includes(id)) return false
      try {
        const asset = this.store.metadata(id)
        return ["input", "source"].includes(asset.kind) && vRootNames.has(asset.name)
      } catch {
        return false
      }
    })
    const audited = await this.runner.call(
      run,
      "vaudit",
      this.packet(
        run,
        {
          milestone: { id: m.id, statement: m.statement, scope: m.scope, values: m.values },
          verifier: { code: verifier.content, spec: m.verification.spec, inputs: m.verification.verifierInputs },
          artifacts: [...m.artifacts, ...vRoots],
        },
        [...m.artifacts, ...vRoots],
      ),
      (value, context) => {
        exact(
          value.checks.map((check) => check.id),
          this.cfg.checks.vaudit,
          "vaudit checks",
        )
        if (value.decision === "trusted") {
          if (value.checks.some((check) => check.status !== "pass"))
            throw new Error("trusted 要求全部检查（semantic/independence/negative_controls）通过")
          if (!value.controls.length) throw new Error("trusted 验证器必须至少提供一条阴性对照")
          for (const control of value.controls) {
            if (control.observed !== "failed")
              throw new Error(`阴性对照 ${control.id} 观测到 ${control.observed}：已知错误实现必须使验证器 fail`)
            if (!context.produced.includes(control.execution))
              throw new Error(`阴性对照 ${control.id} 必须引用本次调用产生的执行记录（得到的是 ${control.execution}）`)
            try {
              const execution = JSON.parse(this.store.asset(control.execution).content)
              if (execution.exit === 0)
                throw new Error(`阴性对照 ${control.id} 的执行退出码为 0：注入错误后验证器仍然 pass，验证器被平凡满足`)
            } catch (error) {
              if (error instanceof SyntaxError) throw new Error(`阴性对照执行记录不可解析：${control.execution}`)
              throw error
            }
          }
          const semantic = value.checks.find((check) => check.id === "semantic")
          if (semantic?.status !== "pass") throw new Error("trusted 要求 semantic 检查通过")
        }
      },
      m.id,
      controller,
    )
    if (this.staleResult(run, m, version, "vaudit")) return
    if (!run.verifiers[m.id]) return
    const value = audited.value
    this.store.event(run, "stage", {
      stage: "vaudit",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary:
        value.decision === "trusted"
          ? `里程碑 ${m.id} 验证器审计通过（阴性对照 ${value.controls.length} 条），进入快检`
          : `里程碑 ${m.id} 验证器审计被拒（第 ${m.verification.rejections ?? 0} 次）：${(value.findings[0]?.detail ?? value.checks.find((c) => c.status !== "pass")?.reason ?? "").slice(0, 120)}`,
    })
    run.verifiers[m.id].status = value.decision === "trusted" ? "trusted" : "rejected"
    run.verifiers[m.id].controls = value.controls
    if (value.decision !== "trusted") {
      m.verification.rejections = (m.verification.rejections ?? 0) + 1
      // 拒绝：验证器重置，回到 anchor 重新实现；两次被拒则升级为里程碑失败交 triage
      if (m.verification.rejections >= 2) {
        m.status = "failed"
        m.review.findings = [
          {
            id: `${m.id}-vaudit`,
            target: m.id,
            detail: `验证器连续 ${m.verification.rejections} 次未通过审计：${(value.findings[0]?.detail ?? value.checks.find((c) => c.status !== "pass")?.reason ?? "").slice(0, 200)}`,
            evidence: value.checks.flatMap((c) => c.evidence).slice(0, 6),
            repair: "verify",
            blocking: true,
          },
        ]
        this.store.save(run)
        return
      }
      m.verification.verifier = null
      delete run.verifiers[m.id]
      m.status = "proposed"
    }
    this.store.save(run)
  }

  async taskQuick(run, m, rerun, controller) {
    const version = m.version
    const verifier = this.store.asset(run.verifiers[m.id].asset)
    // 验证器输入 = 里程碑产物 + anchor 声明的根资产（input/source，按名解析）
    const rootNames = new Set(m.verification.verifierInputs ?? [])
    const extra = run.assets.filter((id) => {
      if (m.artifacts.includes(id)) return false
      try {
        const asset = this.store.metadata(id)
        return ["input", "source"].includes(asset.kind) && rootNames.has(asset.name)
      } catch {
        return false
      }
    })
    const inputs = [...m.artifacts, ...extra].map((id) => this.store.asset(id))
    let result
    try {
      result = await this.executor(verifier.content, inputs, this.cfg.execution, controller.signal)
    } catch (error) {
      if (this.staleResult(run, m, version, "quick-error")) return
      m.review.quick = { error: String(error).slice(0, 300) }
      m.status = "failed"
      m.review.findings = [
        {
          id: `${m.id}-quick-infra`,
          target: m.id,
          detail: `程序化快检无法执行：${String(error).slice(0, 240)}`,
          evidence: [run.verifiers[m.id]?.asset].filter(Boolean),
          repair: "human",
          blocking: true,
        },
      ]
      this.store.save(run)
      return
    }
    if (this.staleResult(run, m, version, "quick")) return
    const asset = this.store.put(
      run,
      "execution",
      `${m.id}-${rerun ? "rerun" : "quick"}-v${m.version}.json`,
      JSON.stringify({ ...result, code: verifier.id, codehash: verifier.hash, milestone: m.id, version: m.version }),
      { milestone: m.id },
    )
    const pass = result.exit === 0
    if (rerun) {
      m.review.reruns = [...(m.review.reruns ?? []), { execution: asset.id, exit: result.exit, pass }]
      // 漂移复查：重跑通过不等于结论存活——验证器只消费本里程碑产物，
      // 检测不到前提值变化；前提真变化（指纹不一致）或状态退化时必须走 refine 重新申报。
      // 版本漂移但内容指纹一致（确认不变的刷新）→ 语义放行
      const drift = premiseDrift(run, m)
      if (drift.ok && drift.semanticBypass)
        this.store.event(run, "drift_bypass", { milestone: m.id, note: drift.semanticBypass })
      if (pass && drift.ok) {
        m.status = "verified"
        m.strength = strengthName(chainStrength(run, m))
        this.store.event(run, "stage", {
          stage: "refresh",
          round: run.round,
          cycle: run.cycle,
          detail: m.id,
          summary: `B 类刷新：${m.id} 验证器重跑通过且前提无漂移，stale 传播在此止住`,
        })
      } else if (pass) {
        m.status = "failed"
        m.impact = null
        m.review.findings = [
          {
            id: `${m.id}-rerun-drift`,
            target: m.id,
            detail: `验证器重跑通过但前提已漂移（${drift}）：结论对新前提值的存活需由 solve 重新确认后申报`,
            evidence: [asset.id],
            repair: "solve",
            blocking: true,
          },
        ]
      } else {
        m.status = "failed"
        m.impact = null
        m.review.findings = [
          {
            id: `${m.id}-rerun`,
            target: m.id,
            detail: `前提更新后验证器重跑失败（exit ${result.exit}）：${result.stdout.slice(-240)}`,
            evidence: [asset.id],
            repair: "solve",
            blocking: true,
          },
        ]
      }
      this.store.save(run)
      return
    }
    m.review.quick = {
      execution: asset.id,
      exit: result.exit,
      pass,
      stdout: result.stdout.slice(0, 2000),
      stderr: result.stderr.slice(0, 2000),
    }
    if (pass) m.status = "quick_checked"
    else {
      m.status = "failed"
      m.review.findings = [
        {
          id: `${m.id}-quick`,
          target: m.id,
          detail: `程序化快检失败（exit ${result.exit}）：${result.stdout.slice(-240) || result.stderr.slice(-240)}`,
          evidence: [asset.id],
          repair: "solve",
          blocking: true,
        },
      ]
    }
    this.store.save(run)
    this.store.event(run, "stage", {
      stage: "quick",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary: pass
        ? `里程碑 ${m.id} 快检通过（exit 0）→ 进入深审（与下游求解并行）`
        : `里程碑 ${m.id} 快检失败（exit ${result.exit}）→ triage`,
    })
  }

  async taskAdversarial(run, m, controller) {
    const version = m.version
    const sub = run.plan.subproblems.find((item) => item.id === m.subproblem)
    const report = run.subreports[m.subproblem]
    const challenged = await this.runner.call(
      run,
      "adversarial",
      this.packet(
        run,
        {
          milestone: { id: m.id, statement: m.statement, scope: m.scope, branches: m.branches },
          subproblem: { id: sub.id, goal: sub.goal },
          work: { report: run.subreports[m.subproblem] ?? null, result: run.subresults[m.subproblem] ?? null },
          premises: this.premises(run).filter((p) => p.status === "verified"),
        },
        [...new Set([...(m.artifacts ?? []), ...(report ? [report] : [])])],
      ),
      (value) => {
        const ids = value.challenges.map((c) => c.id)
        if (new Set(ids).size !== ids.length) throw new Error("质疑 id 必须唯一")
        if (value.challenges.length > this.cfg.challenges)
          throw new Error(`质疑数超过上限 ${this.cfg.challenges}；丢弃重要性最低或理由不充分的质疑`)
        for (const c of value.challenges)
          if (!c.hypothesis.trim() || !c.reason.trim())
            throw new Error(`质疑 ${c.id} 缺少失败模式假设或理由——理由不充分的质疑不应提交`)
      },
      m.id,
      controller,
    )
    if (this.staleResult(run, m, version, "adversarial")) return
    const value = challenged.value
    const must = value.challenges.filter((c) => c.importance === "must").map((c) => c.id)
    const spot = value.challenges
      .filter((c) => c.importance === "spot")
      .map((c) => c.id)
      .slice(0, this.cfg.spot)
    m.review.adversarial = value
    m.review.challenges = value.challenges
    m.review.unitPlan = [...new Set([...must, ...spot, ...m.highRisk.map((r) => `hr-${r.id}`)])]
    m.review.units = []
    this.store.save(run)
    this.checkComplete(run, m)
    this.store.event(run, "stage", {
      stage: "adversarial",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary: `里程碑 ${m.id} 过程质疑：${value.challenges.length} 条（must ${must.length}、spot ${spot.length}、高风险步骤 ${m.highRisk.length}）→ unit 复核清单 ${m.review.unitPlan.length} 项`,
    })
  }

  async taskE2E(run, m, controller) {
    // 隔离最大化：e2e 只看命题、根资产与已验证结论，不看 solve 推导产物。
    const roots = run.assets.filter((id) => {
      try {
        return ["input", "source"].includes(this.store.asset(id).kind)
      } catch {
        return false
      }
    })
    const version = m.version
    const value = await this.runner.call(
      run,
      "verify",
      this.packet(
        run,
        {
          mode: "e2e",
          anchor: m.verification.anchor,
          spec: m.verification.spec,
          milestone: { id: m.id, statement: m.statement, scope: m.scope, values: m.values },
          premises: this.premises(run).filter((p) => p.status === "verified"),
          instruction:
            m.verification.anchor === "rederivation"
              ? "用与原推导不同的方法独立重推该命题并比对；同方法重走不算独立验证。"
              : m.verification.anchor === "limit"
                ? "在已知极限/特例下独立检验该命题。"
                : "以文献数值/已知结果为独立基准检验该命题。",
        },
        roots,
      ),
      (value) => review(value, this.cfg.checks.verify),
      m.id,
      controller,
    )
    if (this.staleResult(run, m, version, "e2e")) return
    m.review.e2e = value.value
    this.store.save(run)
    this.store.event(run, "stage", {
      stage: "e2e",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary: `里程碑 ${m.id} 端到端验证（${m.verification.anchor === "rederivation" ? "独立重推导" : m.verification.anchor === "limit" ? "极限/特例" : "文献基准"}）判定 ${value.value.verdict}`,
    })
    this.checkComplete(run, m)
  }

  async taskBranch(run, m, branchId, controller) {
    const version = m.version
    const branch = m.branches.find((item) => item.id === branchId)
    const value = await this.runner.call(
      run,
      "verify",
      this.packet(
        run,
        {
          mode: "branch",
          milestone: { id: m.id },
          branch: { id: branch.id, statement: branch.statement, inputs: branch.inputs },
          premises: this.premises(run),
          instruction: "给定分支输入，独立验证分支结论；不要查看分支内部推导。",
        },
        m.artifacts,
      ),
      (value) => review(value, this.cfg.checks.verify),
      `${m.id}#${branch.id}`,
      controller,
    )
    if (this.staleResult(run, m, version, "branch")) return
    m.review.branches = [...(m.review.branches ?? []), { id: branch.id, report: value.value }]
    this.store.save(run)
    this.store.event(run, "stage", {
      stage: "branch",
      round: run.round,
      cycle: run.cycle,
      detail: `${m.id}#${branch.id}`,
      summary: `里程碑 ${m.id} 分支 ${branch.id} 独立验证判定 ${value.value.verdict}`,
    })
    this.checkComplete(run, m)
  }

  async taskUnit(run, m, unitId, controller) {
    const version = m.version
    const challenge = (m.review.challenges ?? []).find((c) => c.id === unitId)
    const risk = unitId.startsWith("hr-") ? m.highRisk.find((r) => `hr-${r.id}` === unitId) : null
    const target = challenge
      ? {
          id: challenge.id,
          kind: challenge.kind,
          hypothesis: challenge.hypothesis,
          at: challenge.target,
          evidence: challenge.evidence,
        }
      : { id: unitId, kind: "declared", what: risk?.what, why: risk?.why }
    const value = await this.runner.call(
      run,
      "verify",
      this.packet(
        run,
        {
          mode: "unit",
          milestone: { id: m.id, statement: m.statement },
          target,
          premises: this.premises(run).filter((p) => p.status === "verified"),
          instruction: "对该重点步骤做条件式独立复核：暂定其输入成立，检验该步骤本身是否正确。",
        },
        [...new Set([...m.artifacts, ...(challenge?.evidence ?? [])])],
      ),
      (value) => review(value, this.cfg.checks.unit),
      `${m.id}@${unitId}`,
      controller,
    )
    if (this.staleResult(run, m, version, "unit")) return
    m.review.units = [...(m.review.units ?? []), { id: unitId, report: value.value }]
    this.store.save(run)
    this.store.event(run, "stage", {
      stage: "unit",
      round: run.round,
      cycle: run.cycle,
      detail: `${m.id}@${unitId}`,
      summary: `里程碑 ${m.id} 重点步骤复核（${unitId}）判定 ${value.value.verdict}`,
    })
    this.checkComplete(run, m)
  }

  async taskCompat(run, m, controller) {
    const version = m.version
    const clashes = contradictions(run, m)
    if (clashes.length) this.store.event(run, "contradiction", { milestone: m.id, clashes })
    const adjacent = new Set(run.plan.subproblems.find((s) => s.id === m.subproblem)?.expectedRefs ?? [])
    const neighbors = Object.values(run.milestones)
      .filter(
        (other) =>
          other.id !== m.id &&
          other.status !== "superseded" &&
          (adjacent.has(other.subproblem) || other.criteria.some((c) => m.criteria.includes(c))),
      )
      .slice(0, 8)
      .map((other) => ({
        id: other.id,
        statement: other.statement.slice(0, 200),
        values: other.values,
        status: other.status,
      }))
    const value = await this.runner.call(
      run,
      "compat",
      this.packet(
        run,
        {
          milestone: { id: m.id, statement: m.statement, scope: m.scope, values: m.values, criteria: m.criteria },
          neighbors,
          programmatic: clashes,
          instruction:
            "审查新里程碑与注册表的语义相容性。宁可过敏：发现矛盾嫌疑时作为阻断 finding 报告（不裁决对错），由后续复核收口。",
        },
        m.artifacts,
      ),
      (value) => review(value, this.cfg.checks.compat),
      m.id,
      controller,
    )
    if (this.staleResult(run, m, version, "compat")) return
    m.review.compat = value.value
    this.store.save(run)
    this.store.event(run, "stage", {
      stage: "compat",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary:
        value.value.verdict === "pass"
          ? `里程碑 ${m.id} 相容性审查通过（与注册表无矛盾）`
          : `里程碑 ${m.id} 相容性审查发现矛盾嫌疑：${(value.value.findings[0]?.detail ?? "").slice(0, 120)}`,
    })
    this.checkComplete(run, m)
  }

  checkComplete(run, m) {
    if (m.status !== "quick_checked") return
    if (!reviewComplete(run, m)) return
    const result = aggregate(run, m)
    if (!result.done) return
    if (result.bypasses?.length) this.store.event(run, "drift_bypass", { milestone: m.id, notes: result.bypasses })
    this.store.event(run, "stage", {
      stage: m.status === "verified" ? "verified" : "failed",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary:
        m.status === "verified"
          ? `里程碑 ${m.id} v${m.version} 深审通过（强度 ${m.strength}）`
          : `里程碑 ${m.id} v${m.version} 深审失败：${(result.findings ?? []).filter((f) => f.blocking).length} 个阻断发现 → triage`,
    })
    this.report(run, `${m.status}-${m.id}`, [
      "## 本阶段完成的工作",
      `里程碑 **${m.id} v${m.version}** 深审聚合判定：**${m.status === "verified" ? `通过（证据强度 ${m.strength}）` : "失败"}**。`,
      "",
      "### 命题",
      m.statement.slice(0, 400),
      ...(m.status !== "verified"
        ? [
            "",
            "### 阻断发现",
            ...(result.findings ?? []).filter((f) => f.blocking).map((f) => `- **${f.id}**：${f.detail.slice(0, 200)}`),
          ]
        : []),
    ])
  }

  async taskTriage(run, m, controller) {
    // 调度到执行之间里程碑可能被回滚/刷新改写：只对当前仍 failed 且未分类的里程碑 triage
    if (m.status !== "failed" || m.impact) {
      this.store.event(run, "stale_result_dropped", { milestone: m.id, status: m.status, where: "triage" })
      return
    }
    const consumers = Object.values(run.milestones)
      .filter((other) => other.id !== m.id && other.status !== "superseded")
      .map((other) => ({
        id: other.id,
        status: other.status,
        consumes: run.ledger.some(
          (e) => e.consumer === other.id && (e.consumed === m.id || e.consumed === m.id.split(":").pop()),
        ),
      }))
    const value = await this.runner
      .call(
        run,
        "triage",
        this.packet(
          run,
          {
            milestone: { id: m.id, statement: m.statement, version: m.version },
            findings: m.review.findings ?? [],
            consumers,
            plan: run.plan.subproblems.map((sub) => ({
              id: sub.id,
              status: run.subresults[sub.id]?.status ?? "unattempted",
              goal: sub.goal.slice(0, 160),
              expectedRefs: sub.expectedRefs,
            })),
            classes: {
              A: "结论不变，存在需要补充的漏洞（缺支撑/缺验证）",
              B: "结论将改变，但下游子问题目标只引用其槽位，方法路线不变",
              C: "结论改变且下游目标定义/方法路线/优先级失效",
            },
          },
          m.artifacts,
        ),
        (value) => {
          const known = new Set([...Object.keys(run.milestones), ...run.plan.subproblems.map((s) => s.id)])
          for (const impact of value.impacts)
            for (const id of impact.affected)
              if (!known.has(id)) throw new Error(`影响分析引用未知对象 ${id}；已知对象为里程碑与子问题 id`)
        },
        m.id,
        controller,
      )
      .catch((error) => {
        if (/Workflow cancelled|STALE|LOCA_TASK_ABORTED/.test(String(error))) throw error
        // triage 失败兜底：按破坏最小的 A 类处置（补洞重审）。此前用 C 类会
        // replan+回滚已完成结构——triage 不可用时选 C 反而是最大破坏；A 处置
        // 错了，后续审核与 triage 恢复后仍会抓
        m.impact = {
          impacts: [
            { finding: "triage-infra", class: "A", affected: [], goalChange: false, note: String(error).slice(0, 200) },
          ],
          reason: "triage 角色调用失败，保守按 A 类补洞处理",
          class: "A",
        }
        m.conservativeCount = (m.conservativeCount ?? 0) + 1
        if (m.conservativeCount >= 2) {
          m.review.findings = [
            ...(m.review.findings ?? []),
            {
              id: `${m.id}-triage-unavailable`,
              target: m.id,
              detail: `triage 连续 ${m.conservativeCount} 次不可用，无法自动分类审核失败`,
              evidence: m.artifacts.slice(0, 4),
              repair: "human",
              blocking: true,
            },
          ]
          this.store.save(run)
          this.store.move(run, "needs_human", { milestone: m.id, reason: "triage-unavailable" })
          this.store.event(run, "conservative_triage", { milestone: m.id, class: "A", escalated: true })
          return null
        }
        // 清空 impact：允许下一轮审核失败再次进入 triage（若其恢复可用则正确分类）
        m.impact = null
        this.reopen(
          run,
          m.subproblem,
          "patch",
          `里程碑 ${m.id} 审核失败且 triage 不可用，按 A 类补洞重审（第 ${m.conservativeCount} 次）`,
        )
        this.store.save(run)
        this.store.event(run, "conservative_triage", { milestone: m.id, class: "A" })
        return null
      })
    // 兜底路径已自行处置（返回 null）：直接返回，不走正常分类流程
    if (!value) return
    m.impact = value.value
    // triage 正常完成：连续不可用计数归零（"连续"语义）
    m.conservativeCount = 0
    const klass = value.value.impacts.some((i) => i.class === "C")
      ? "C"
      : value.value.impacts.some((i) => i.class === "B")
        ? "B"
        : "A"
    m.impact.class = klass
    this.store.save(run)
    const findings = (m.review.findings ?? []).filter((f) => f.blocking)
    this.store.event(run, "stage", {
      stage: "triage",
      round: run.round,
      cycle: run.cycle,
      detail: m.id,
      summary: `里程碑 ${m.id} 影响分类 ${klass}：${value.value.impacts.map((i) => `${i.finding}→${i.class}`).join("；")}`,
    })
    this.report(run, `triage-${m.id}`, [
      "## 本阶段完成的工作",
      `里程碑 **${m.id}** 审核失败处置分类：**${klass} 类**。`,
      "",
      "### 逐发现分类",
      ...value.value.impacts.map(
        (i) => `- ${i.finding} → **${i.class}**（受影响：${i.affected.join("、") || "无"}）：${i.note.slice(0, 200)}`,
      ),
      "",
      ...(klass === "A"
        ? ["### 处置", "重开所属子问题做补洞（patch），推测执行不打断；补证后重跑快检与深审。"]
        : klass === "B"
          ? [
              "### 处置",
              "重开所属子问题做局部重做（refine）；新版本落地后下游按三态刷新（验证器重跑通过即止 / stale 复核 / 计划边自动消费新版本）。推测执行不打断。",
            ]
          : [
              "### 处置",
              "中止依赖失效前提的推测性任务并选择性回滚（仅丢弃依赖闭包内的结论）；planner 重规划（计划版本 +1）。",
            ]),
    ])
    // 快检失败的 A/B 类：验证器本身可能有问题——重置验证方案强制重新实现/审计
    if (klass !== "C" && m.review.quick && m.review.quick.pass !== true) {
      m.verification.verifier = null
      delete run.verifiers[m.id]
      m.status = "proposed"
    }
    if (klass === "A") {
      this.reopen(
        run,
        m.subproblem,
        "patch",
        `里程碑 ${m.id} 审核判定 A 类（结论不变，补洞）：${findings.map((f) => f.id).join("、")}`,
      )
      this.store.save(run)
    } else if (klass === "B") {
      this.reopen(
        run,
        m.subproblem,
        "refine",
        `里程碑 ${m.id} 审核判定 B 类（结论需修正）：${findings.map((f) => f.id).join("、")}；修正后新版本将触发下游三态刷新`,
      )
      this.store.save(run)
    } else {
      // C 类：选择性回滚 + 重规划
      const set = rollbackSet(run, m.id)
      for (const id of set.milestones) {
        const target = run.milestones[id]
        if (target) {
          target.history.push({
            version: target.version,
            statement: target.statement,
            scope: target.scope,
            status: target.status,
          })
          target.status = "superseded"
          target.supersededBy = `rollback:${m.id}`
        }
      }
      for (const subId of set.subs) {
        const result = run.subresults[subId]
        if (result && result.status !== "blocked") {
          result.rolledBack = true
          result.status = "working"
          result.feedback = {
            kind: "continue",
            note: `前提 ${m.id} 被 C 类推翻，本子问题结论已回滚；将在新计划下重做`,
            findings: [],
          }
        }
      }
      run.planInvalid = true
      // 中止范围：账本回滚集 + owner 传递闭包内所有未完成子问题（它们的在飞
      // 推测性 solve 尚未注册里程碑，不在账本中，但同样建立在失效前提上）
      const doomed = new Set(set.subs)
      for (const sub of run.plan.subproblems) {
        if (run.subresults[sub.id]?.status === "completed") continue
        if (closure(sub.id, run.plan).has(m.subproblem)) doomed.add(sub.id)
      }
      run.pendingRollback = [...doomed]
      run.feedback = { verdict: "fail", milestone: m.id, klass, impacts: value.value.impacts, findings }
      this.store.save(run)
      // 失败里程碑自身的 owner 也重开：新计划下重新申报（版本递增清除 failed 态）
      this.reopen(run, m.subproblem, "continue", `里程碑 ${m.id} 被 C 类推翻：在新计划下重新求解该子问题`)
      this.store.save(run)
      // 在飞推测性 solve 由 frontier 在下一轮迭代按 pendingRollback 中止
      this.store.event(run, "rollback", { milestone: m.id, subs: set.subs, milestones: set.milestones })
    }
  }

  assess(run) {
    const subs = run.plan.subproblems
    const blocked = subs.filter((sub) => run.subresults[sub.id]?.status === "blocked")
    if (blocked.length)
      return {
        reason: `子问题被阻塞：${blocked.map((s) => `${s.id}——${run.subresults[s.id].reason.slice(0, 160)}`).join("；")}`,
      }
    const incomplete = subs.filter((sub) => run.subresults[sub.id]?.status !== "completed")
    const unresolved = Object.values(run.milestones).filter(
      (m) => !["verified", "superseded"].includes(m.status) && m.status !== "draft",
    )
    if (!incomplete.length && !unresolved.length) {
      const covered = new Set(
        Object.values(run.milestones)
          .filter((m) => m.status === "verified")
          .flatMap((m) => m.criteria),
      )
      const missing = run.contract.criteria.filter((c) => !covered.has(c.id))
      if (!missing.length) return "done"
      return {
        replan: true,
        reason: `标准未被任何已验证里程碑覆盖：${missing.map((c) => c.id).join("、")}`,
        feedback: {
          verdict: "fail",
          findings: missing.map((c, i) => ({
            id: `G${i + 1}`,
            target: c.id,
            detail: `标准 ${c.id} 尚无已验证里程碑负责`,
            evidence: [],
            repair: "plan",
            blocking: true,
          })),
        },
      }
    }
    // infra 重试耗尽的子问题：给 planner 一次重排机会（换路或收缩），
    // 由 cycles 预算兜底；其余子问题都完成且无未决里程碑时才触发
    const starved = incomplete.filter(
      (sub) => run.subresults[sub.id]?.failed && (run.subresults[sub.id].attempts ?? 0) >= this.cfg.subattempts,
    )
    // 下游子问题若只被 starved 链阻塞（pre-flight 不过），同样需要 replan 解锁
    if (starved.length && !unresolved.length)
      return {
        replan: true,
        reason: `子问题 infra 重试耗尽：${starved.map((s) => `${s.id}（${run.subresults[s.id].reason?.slice(0, 120) ?? ""}）`).join("；")}`,
        feedback: {
          verdict: "fail",
          findings: starved.map((sub, i) => ({
            id: `S${i + 1}`,
            target: sub.id,
            detail: `子问题 ${sub.id} 连续 ${this.cfg.subattempts} 次执行失败：${run.subresults[sub.id].reason?.slice(0, 160) ?? ""}`,
            evidence: [],
            repair: "plan",
            blocking: true,
          })),
        },
      }
    // 无任务可调度且未完成：给出具体卡点
    const pending = incomplete.map((sub) => `${sub.id}（${run.subresults[sub.id]?.status ?? "未开工"}）`).join("、")
    const states = unresolved.map((m) => `${m.id}:${m.status}`).join("、")
    return {
      reason: `frontier 停滞：未完成子问题 [${pending}]；未决里程碑 [${states}]。可能是前提链阻塞或预算耗尽。`,
    }
  }

  async integratePhase(run) {
    const store = this.store
    store.move(run, "integrating")
    const verified = Object.values(run.milestones).filter((m) => m.status === "verified")
    const strengths = new Map(verified.map((m) => [m.id, strengthName(chainStrength(run, m))]))
    const result = await this.runner.call(
      run,
      "integrate",
      this.packet(
        run,
        {
          milestones: verified.map((m) => ({
            id: m.id,
            version: m.version,
            statement: m.statement.slice(0, 240),
            criteria: m.criteria,
            strength: strengths.get(m.id),
            artifacts: m.artifacts,
            review: {
              quick: m.review.quick?.execution ?? null,
              e2e: m.review.e2e ? "report" : null,
              branches: (m.review.branches ?? []).length,
              units: (m.review.units ?? []).length,
            },
          })),
          ledger: run.ledger,
          checks: this.cfg.checks.integrate,
        },
        verified.flatMap((m) => m.artifacts),
      ),
      (value) => {
        review(value, this.cfg.checks.integrate)
        exact(
          value.criteria.map((item) => item.id),
          run.contract.criteria.map((item) => item.id),
          "delivery criteria",
        )
        value.criteria.forEach((item) => {
          if (item.milestones.some((id) => !verified.some((m) => m.id === id)))
            throw new Error(
              `Delivery references an unverified milestone: ${item.milestones.find((id) => !verified.some((m) => m.id === id))}; verified ids are [${verified.map((m) => m.id).join(", ")}] — copy one exactly`,
            )
          const rank = { programmatic: 0, independent: 1, crosscheck: 2, weak: 3 }
          const computed = Math.max(...item.milestones.map((id) => rank[strengths.get(id)]))
          if (rank[item.strength] !== computed)
            throw new Error(
              `标准 ${item.id} 强度标注 ${item.strength} 与链式计算结果（最弱环节 ${["programmatic", "independent", "crosscheck", "weak"][computed]}）不一致`,
            )
          if (
            item.artifacts.some((id) => {
              try {
                return ["source", "input"].includes(this.store.asset(id).kind)
              } catch {
                return true
              }
            })
          )
            throw new Error("Delivery artifacts must be produced work, not frozen inputs")
        })
      },
    )
    if (result.value.verdict !== "pass") {
      run.feedback = result.value
      store.save(run)
      return false
    }
    run.integrated = result.value
    store.save(run)
    await this.deliver(run, result)
    return true
  }

  async deliver(run, result) {
    const dir = path.join(
      this.root,
      "loca/results",
      run.id,
      `round-${run.round}`,
      `plan-${run.cycle}-${result.record.hash.slice(0, 10)}`,
    )
    await mkdir(dir, { recursive: true })
    await mkdir(path.join(dir, "evidence"), { recursive: true })
    const verified = Object.values(run.milestones).filter((m) => m.status === "verified")
    const artifacts = [...new Set(verified.flatMap((m) => m.artifacts))]
    const files = await Promise.all(
      artifacts.map(async (id, index) => {
        const asset = this.store.asset(id)
        const file = path.join(dir, `${index + 1}-${path.basename(asset.name)}`)
        await writeFile(file, asset.content, { flag: "w" })
        return { id, file, hash: asset.hash }
      }),
    )
    const text = [
      `LOCA 第 ${run.round} 轮已完成里程碑审核，等待你验收。计划版本 ${run.cycle}，已验证里程碑 ${verified.length} 个。`,
      result.value.summary,
      ...result.value.criteria.map((item) => {
        const criterion = run.contract.criteria.find((c) => c.id === item.id)
        const weak = item.strength === "weak" ? "⚠️ 前提链最弱环节为 weak（无独立锚点），请人类重点裁决" : ""
        return `- **${item.id}：${criterion.text}**\n  里程碑：${item.milestones.join("、")}\n  成果：${item.artifacts
          .map((id) => {
            const file = files.find((file) => file.id === id)
            return file ? `[${path.basename(file.file)}](${file.file})` : id
          })
          .join("、")}\n  证据强度：${item.strength}${weak}\n  范围：${item.scope}\n  建议亲自审核：${item.review}`
      }),
      `审核记录：[audit.json](${path.join(dir, "audit.json")})`,
      "如需修改，直接输入意见或使用 /loca 输入补充标准；明确通过请使用 /loca-accept。",
    ].join("\n\n")
    const contents = new Map(
      run.assets.map((id) => {
        const asset = this.store.asset(id)
        return [asset.hash, asset.content]
      }),
    )
    await Promise.all(
      [...contents].map(([digest, content]) => writeFile(path.join(dir, "evidence", `${digest}.txt`), content)),
    )
    const evidence = run.assets.flatMap((id) => {
      try {
        const asset = this.store.asset(id)
        const { content, ...metadata } = asset
        return [{ ...metadata, file: `evidence/${asset.hash}.txt` }]
      } catch {
        return []
      }
    })
    await writeFile(
      path.join(dir, "audit.json"),
      JSON.stringify(
        {
          contract: run.contract,
          plan: run.plan,
          milestones: run.milestones,
          ledger: run.ledger,
          verifiers: run.verifiers,
          subresults: run.subresults,
          integration: result.value,
          files,
          evidence,
          jobs: this.store.jobs(run),
          events: this.store.events(run),
        },
        null,
        2,
      ),
    )
    await writeFile(path.join(dir, "summary.md"), text)
    this.guard(run)
    run.summary = text
    run.delivery = result.record.id
    run.directory = dir
    this.store.save(run)
  }

  assume(run, job, list) {
    run.assumptions ??= []
    for (const item of list) {
      run.assumptions.push({
        id: `A${run.assumptions.length + 1}`,
        role: job.role,
        step: `R${job.round}C${job.cycle}`,
        reason: item.reason,
        content: item.content,
        evidence: item.evidence ?? [],
      })
    }
    this.store.save(run)
    this.store.event(run, "assumption", { total: run.assumptions.length })
  }

  renderAssumptions(run) {
    const list = run.assumptions ?? []
    if (!list.length)
      return "尚未记录任何假设。合约与各角色在自行消解歧义时会记录假设；总体进度可用 /loca-status 查看。"
    const rows = list.map(
      (a) =>
        `| ${a.id} | ${a.role} ${a.step} | ${a.reason} | ${a.content}${a.evidence.length ? `（依据：${a.evidence.join("、")}）` : ""} |`,
    )
    return [
      `LOCA 假设清单（第 ${run.round} 轮，共 ${list.length} 条）`,
      "",
      "| ID | 角色/步骤 | 原因 | 假设内容 |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
      "假设是对歧义的合理默认解释；如需纠正，直接在会话中补充意见（未被明确撤销的旧标准继续有效）。",
    ].join("\n")
  }

  renderClarification(questions, review) {
    const lines = ["需要你决定的事项（无法采用合理默认，已暂停）："]
    questions.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.question}${item.evidence?.length ? `（依据：${item.evidence.join("、")}）` : ""}`,
      )
    })
    if (review.verdict !== "pass") {
      lines.push("", `合约保真复核未通过（${review.verdict}）：`)
      for (const finding of review.findings)
        lines.push(`- ${finding.target}：${finding.detail}（修复方向：${finding.repair}）`)
    }
    lines.push("", "已采用的默认解释可用 /loca-assumptions 查看；在会话中答复后，工作将从合约阶段继续。")
    return lines.join("\n")
  }

  static explain(error) {
    const text = String(error ?? "")
    if (!text) return ""
    const clean = (part) =>
      part
        .replace(/(did you mean:?)[^;。]*/gi, "$1 <nearest-match>")
        .replace(/; registered ids this session:.*$/s, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240)
    const lines = text
      .split("Error: ")
      .map((part) => clean(part))
      .filter((part) => part.length)
    const generic =
      /^(Role .+ exhausted protocol retries|Aether API error|Round role-call budget exhausted|frontier 停滞)[:：]?/
    const lead = lines.find((part) => !generic.test(part)) ?? lines[0] ?? clean(text)
    const more = Math.max(0, lines.length - 1 - (lead === lines[0] ? 0 : 1))
    return lead + (more > 0 ? `（另有 ${more} 条同类错误，详见 state.sqlite）` : "")
  }

  status(run) {
    const jobs = this.store.jobs(run)
    const open = run.questions?.filter((item) => !item.blocking) ?? []
    const stages = this.store
      .events(run)
      .filter((row) => row.kind === "stage" && row.data?.summary)
      .slice(-8)
      .map((row) => row.data.summary)
    const verified = Object.values(run.milestones).filter((m) => m.status === "verified")
    const reasons = {
      unfinished: "本轮在可重试错误后停止；进度已保全",
      cancelled: "本轮已取消；进度已保全",
      needs_human: "等待你的输入",
    }
    return [
      `LOCA 第 ${run.round} 轮 / 计划版本 ${run.cycle}：${LABELS[run.phase] ?? run.phase}${reasons[run.phase] ? `——${reasons[run.phase]}` : ""}`,
      `角色调用 ${run.calls}/${this.cfg.calls}；已验收执行 ${jobs.filter((job) => job.status === "accepted").length}；里程碑 ${Object.values(run.milestones).filter((m) => m.status !== "superseded").length} 个（已验证 ${verified.length}）；假设 ${run.assumptions?.length ?? 0} 条（/loca-assumptions 查看）；待处理用户输入 ${run.pending.length}。`,
      ...(Engine.explain(run.error) ? [`主要原因：${Engine.explain(run.error)}`] : []),
      ...(stages.length ? ["", "最近阶段纪要：", ...stages.map((line) => `- ${line}`)] : []),
      `记录：${this.store.dir}/state.sqlite`,
      ...(run.phase === "accepted"
        ? [`本轮已由人类验收。成果与审核包：${run.directory}`]
        : run.summary
          ? ["", run.summary]
          : ["尚未产生通过审核的交付结果。"]),
    ].join("\n")
  }

  static ask(ctx, request, ms = 60000) {
    return Promise.race([
      ctx.ask(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Permission request unanswered in isolated context")), ms),
      ),
    ])
  }

  async source(context, args, ctx) {
    this.guard(context.run, context.epoch)
    if (/^https?:\/\//.test(args.path)) {
      await Engine.ask(ctx, { permission: "webfetch", patterns: [args.path], always: [], metadata: { url: args.path } })
      const response = await fetch(args.path, {
        redirect: "error",
        signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(30000)]),
      })
      if (!response.ok) throw new Error(`Source HTTP ${response.status}`)
      const reader = response.body.getReader()
      const chunks = []
      const size = { bytes: 0 }
      while (true) {
        const item = await reader.read()
        if (item.done) break
        size.bytes += item.value.length
        if (size.bytes > this.cfg.bytes) {
          await reader.cancel()
          throw new Error("Source too large")
        }
        chunks.push(Buffer.from(item.value))
      }
      return this.register(context, "source", args.path, Buffer.concat(chunks).toString("utf8"), {
        url: args.path,
        retrieved: Date.now(),
      })
    }
    const file = await realpath(path.resolve(this.root, args.path.replace(/^file:\/\//, "")))
    if (file !== this.root && !file.startsWith(this.root + path.sep))
      await Engine.ask(ctx, {
        permission: "external_directory",
        patterns: [path.dirname(file) + "/*"],
        always: [],
        metadata: { path: file },
      })
    await Engine.ask(ctx, { permission: "read", patterns: [file], always: [], metadata: { path: file } })
    if (Bun.file(file).size > this.cfg.bytes)
      throw new Error("Source too large; provide a smaller, explicitly scoped source")
    const content = await Bun.file(file).arrayBuffer()
    if (content.byteLength > this.cfg.bytes) throw new Error("Source grew beyond the size limit")
    if (Buffer.from(content).includes(0) || file.toLowerCase().endsWith(".pdf"))
      throw new Error(
        "This version accepts UTF-8 sources; extract binary/PDF sources with a trusted external tool and include provenance",
      )
    return this.register(context, "source", path.basename(file), Buffer.from(content).toString("utf8"), { path: file })
  }

  register(context, kind, name, content, metadata = {}) {
    this.guard(context.run, context.epoch)
    if (Buffer.byteLength(content) > this.cfg.bytes) throw new Error("Asset size limit exceeded")
    const asset = this.store.put(context.run, kind, name, content, { ...metadata, job: context.job.id })
    context.allowed.add(asset.id)
    context.produced.push(asset.id)
    return asset
  }

  async compute(context, args, ctx) {
    this.guard(context.run, context.epoch)
    if (!["solve", "verify", "vaudit", "anchor"].includes(context.role))
      throw new Error("This role cannot execute code")
    // 角色级沙箱执行预算（防对照实验失控）：超限即拒绝并引导交卷
    const budgets = { anchor: 6, vaudit: 8, verify: 10, solve: 20 }
    context.execCount = (context.execCount ?? 0) + 1
    const cap = budgets[context.role] ?? 8
    if (context.execCount > cap)
      throw new Error(
        `沙箱执行预算已用尽（${context.role} 上限 ${cap} 次）：停止新实验，整理已有结果并立即调用 StructuredOutput 提交——审计发现缺陷就直接 rejected，不要继续验证`,
      )
    const frozen = args.inputs.map((id) => {
      try {
        return this.store.asset(id)
      } catch {
        return null
      }
    })
    if (frozen.some((asset) => !asset))
      throw new Error(
        `Execution attempted to introduce undeclared inputs: ${args.inputs
          .filter((_, i) => !frozen[i])
          .join(", ")} are not frozen run assets — register them via loca_artifact/loca_source first`,
      )
    if (frozen.length > 64) throw new Error("Execution inputs are capped at 64 frozen assets per run")
    await ctx.ask({
      permission: "bash",
      patterns: ["loca:python-sandbox", `${this.cfg.execution.python} -I -S <frozen-code>`],
      always: [],
      metadata: { code: args.code, inputs: args.inputs },
    })
    const code = this.register(context, "code", "verification.py", args.code)
    // 执行心跳：watchdog 的 executing ceiling 依赖 activity[:exec] 判活；
    // 工具启动只 set 一次，长时健康执行（如大工况对照）会被误判 stall 杀掉。
    // 沙盒进程存活期间定期续期心跳。
    const beat = context.job.session
      ? setInterval(() => this.activity.set(`${context.job.session}:exec`, Date.now()), 30000)
      : null
    let result
    try {
      result = await this.executor(args.code, frozen, this.cfg.execution, ctx.abort)
    } finally {
      if (beat) clearInterval(beat)
    }
    return this.register(
      context,
      "execution",
      "execution.json",
      JSON.stringify({ ...result, code: code.id, codehash: hash(args.code) }),
    )
  }
}
