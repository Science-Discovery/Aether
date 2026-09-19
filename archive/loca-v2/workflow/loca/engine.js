import path from "node:path"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { Store, hash } from "./store.js"
import { Runner, parallel } from "./runner.js"
import { exact, review } from "./schema.js"
import { aggregate, graph, mergeProblems, solved } from "./graph.js"
import { execute } from "./execute.js"

export const engines = new Map()

export class Engine {
  constructor(root, cfg, client, dir = path.join(root, "loca/.runtime")) {
    if (cfg.reviewers < 2 || cfg.concurrency < 1 || cfg.attempts < 1 || cfg.questions < 1)
      throw new Error("Invalid workflow limits")
    this.root = root
    this.cfg = cfg
    this.store = new Store(dir)
    this.runner = new Runner(this, client)
    this.active = new Map()
    this.children = new Map()
    this.requests = new Map()
    this.commands = new Map()
    this.activity = new Map()
    // Sessions running as the loca-agent bridge (orchestration only, gated away
    // from normal tools); distinct from mere drivers, which keep their toolkit.
    this.orchestrates = new Set()
    this.owner = randomUUID()
    // Some clients pre-render command markdown into the prompt text and bypass
    // command.execute.before; capture() strips these known template prefixes so
    // such paths degrade to the bare arguments instead of polluting human input.
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

  // Layered user reporting: every completed stage writes a human-readable report to
  // loca/.runtime/reports/ so the user can follow the work outside the GUI — what the
  // stage did, what it produced, where the detailed texts live, what happens next.
  report(run, stage, lines) {
    const dir = path.join(this.store.dir, "reports")
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `R${run.round}C${run.cycle}-${stage}.md`)
    const text = [
      `# LOCA 阶段报告：${stage}（第 ${run.round} 轮 / 修复 ${run.cycle}）`,
      `时间：${new Date().toISOString()}`,
      "",
      ...lines,
      "",
      "---",
      `阶段纪要全集与本报告同目录：${dir}`,
      `机器可读状态：${this.store.dir}/state.sqlite（runs/jobs/events/assets 四表）`,
    ].join("\n")
    writeFileSync(file, text, { flag: "w" })
    this.store.event(run, "report_written", { stage, file })
    return file
  }

  // One-line pointer for GUI metadata: the newest report file path.
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
    // Guard by run ID: run.session is informational (latest driver) and may be
    // re-keyed by another driving session at any moment; identity is the run row.
    if (this.store.byId(run.id)?.epoch !== epoch) throw new Error("STALE: newer user input supersedes this work")
    if (this.active.get(run.id)?.controller.signal.aborted) throw new Error("Workflow cancelled")
  }

  capture(session, message, model) {
    const command = this.commands.get(session)
    this.commands.delete(session)
    if (command && command.action !== "work") {
      this.requests.set(session, command.action)
      const run = this.current()
      // A status query never creates or claims a run: the project's current run is
      // the machine's single source of truth, sessions are just drivers.
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
    // Project-state-first: the run this message feeds is the project's CURRENT run
    // (active/leased/latest), regardless of which session is typing. A new run row
    // is only created when a real goal arrives and no run exists.
    const bare = !text.trim() || text.trim() === "continue"
    let run = this.current()
    if (!run && bare) return
    // Never create a second run row while ANY run exists (current() misses happen
    // under transient lease expiry — latest() is the definitive existence check).
    if (!run) {
      if (this.store.latest()) run = this.store.latest()
      else run = this.store.create(session)
    }
    // Record the latest driver informationally (not ownership): keep BOTH the
    // session column and the JSON data consistent.
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
    // Concurrent inputs race the CAS: the newer epoch wins and this older message is
    // superseded — the hook must not explode (the message pipeline still needs to
    // deliver the tool call; the engine will report staleness on its own).
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
    // Tolerate a missing asset row (manual recovery surgery can prune the registry):
    // an unreadable id is simply dropped from the packet rather than poisoning the
    // whole role call.
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
    // Stubs must stay tiny: long-running rounds accumulate 100+ assets and fat
    // stub metadata alone can blow the packet cap. Content stays one call away.
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
      // Slim callers (assemble) already carry goal/criteria in their value: skip
      // the duplicate full contract spread.
      ...(value && value.slim ? {} : { contract: run.contract }),
      ...value,
    }
    // Inline budget: long-running rounds accumulate dozens of assets whose full
    // contents would blow the packet cap. Newest assets keep inline content;
    // older ones degrade to referenceable stubs (never silently truncated).
    const resolved = [...new Set(ids)].map((id) => this.store.asset(id))
    // Budget in BYTES: the runner caps the serialized packet by byte length and
    // CJK content makes char counts undercount by up to 3x.
    // Keep generous headroom: correction feedback, JSON overhead and stub
    // metadata ride on top of inline content in the serialized packet.
    // Stub overhead is REAL: hundreds of accumulated assets contribute ~200 bytes
    // each even when nothing inlines — deduct it first or long rounds exceed the
    // pre-flight packet cap and abort the call entirely.
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

  // Incremental repair: re-attack a "working" sub-problem with its own prior
  // result inlined as the baseline. The attack role then extends/repairs instead
  // of redoing; claims reference existing artifacts that remain valid.
  async refine(run, sub, prior) {
    const plan = run.plan
    const priors = plan.subproblems
      .filter((item) => run.subresults[item.id])
      .map((item) => ({
        id: item.id,
        status: run.subresults[item.id].status,
        artifacts: run.subresults[item.id].artifacts,
        claims: run.subresults[item.id].claims,
      }))
    const result = await this.runner
      .call(
        run,
        "attack",
        this.packet(
          run,
          {
            plan: {
              strategy: plan.strategy,
              subproblem: sub,
              priors: priors.filter((item) => item.id !== sub.id),
            },
            prior,
            feedback: run.feedback ?? null,
            history: run.history,
          },
          [...new Set([...sub.evidence, ...prior.artifacts, ...priors.flatMap((item) => item.artifacts)])],
        ),
        (value) => {
          // Same reroute semantics as the main attack path: foreign-criterion claims
          // from a repair are progress, not violations.
          const foreign = value.claims.filter((claim) => claim.criteria.some((id) => !new Set(sub.criteria).has(id)))
          if (foreign.length) {
            this.store.event(run, "claim_reroute", {
              job: sub.id,
              claims: foreign.map((claim) => claim.id),
              note: "refine claim targets foreign criteria; routed into feedback",
            })
            run.feedback = run.feedback ?? { verdict: "fail", findings: [] }
            run.feedback.findings.push(
              ...foreign.map((claim) => ({
                id: `R-${claim.id}`,
                target: "candidate",
                detail: `子问题 ${sub.id} 修复中已建立断言 ${claim.id}（${claim.text.slice(0, 120)}），其标准属于其他子问题——由负责该标准的子问题在下一轮吸收采纳`,
                evidence: claim.artifact ? [claim.artifact] : [],
                repair: "solve",
                blocking: false,
              })),
            )
          }
        },
      )
      .catch(() => prior)
    return result.value
  }

  node(run, node, extra = {}, ids = []) {
    const parents = node.inputs
      .filter((input) => input.port !== "asset")
      .map((input) => {
        const parent = run.dag.nodes.find((item) => item.id === input.from)
        const output = parent.outputs.find((item) => item.port === input.port)
        const asset = this.store.put(run, "port", `${parent.id}.${input.port}`, JSON.stringify(output), {
          node: parent.id,
          cycle: run.cycle,
        })
        return { id: parent.id, output, evidence: asset.id }
      })
    const roots = node.inputs.filter((input) => input.port === "asset").map((input) => input.from)
    const materials = node.material.map((range) => {
      const original = this.store.asset(range.asset)
      const asset = this.store.put(run, "fragment", original.name, original.content.slice(range.start, range.end), {
        original: original.id,
        start: range.start,
        end: range.end,
      })
      return { ...range, evidence: asset.id }
    })
    // Materials are the object under review, never implicit additional premises.
    const criteria = run.contract.criteria.filter((item) => node.criteria.includes(item.id))
    return this.packet(
      run,
      { contract: { goal: run.contract.goal, criteria }, node: { ...node, material: materials }, parents, ...extra },
      [...roots, ...materials.map((range) => range.evidence), ...parents.map((parent) => parent.evidence), ...ids],
    )
  }

  // The parent session stays busy for the whole round; other sessions of the
  // same project can query progress with /loca-status, resolved here.
  current() {
    // Identity is the run row: active is keyed by run id (an in-flight run wins),
    // leases name driver sessions (resolve through the run row or jobs ledger),
    // otherwise the latest run row.
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

  // Reverse lookup: a session whose run row was re-keyed elsewhere still maps to its
  // run via the jobs ledger (job.parent recorded the driving session at creation).
  byDriver(session) {
    const row = this.store.db
      .query("SELECT run FROM jobs WHERE json_extract(data, '$.parent') = ? ORDER BY rowid DESC LIMIT 1")
      .get(session)
    return row ? this.store.byId(row.run) : null
  }

  async act(session, ctx) {
    const action = this.requests.get(session)
    const query = action === "status" || action === "assumptions"
    // PROJECT-STATE-FIRST (no session ownership): the machine's single source of
    // truth is the project's current run row in state.sqlite. Any session of the
    // project resolves THE SAME run; run.session records only the latest driver,
    // informationally. There is no adoption, no claiming, no stranding.
    const run = this.current()
    if (!run) {
      if (query || action === "work") return "当前项目没有进行中的 LOCA 工作；可用 /loca 输入目标与验收标准。"
      return "请先使用 /loca 输入目标和验收标准。"
    }
    // Record the driver channel for in-flight control (leases/abort); identity is
    // NOT derived from it.
    if (run.session !== session) {
      const previous = run.session
      run.session = session
      this.store.save(run)
      this.store.event(run, "driver", { from: previous, to: session })
    }
    if (this.active.has(run.id) && this.active.get(run.id).session !== session) {
      // Already running under another driving session: report, don't double-drive.
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
    // Interrupted recovery: an unfinished/cancelled run resuming WITHOUT new human
    // input is an infra resume, not a quality-repair cycle. Roll the cycle counter
    // back to where it stood when the interruption happened so numbering keeps its
    // "quality repair rounds" semantics and resume does not burn cycle budget.
    // Infra-resume detection: a run interrupted MID-WORK (crash/kill — phase stuck
    // in a work phase, no pending human input, no quality feedback waiting) continues
    // its own cycle instead of burning a new one. A quality-repair cycle is excluded
    // by the feedback/planInvalid flags it carries.
    const midwork = ["split", "structure", "inputs", "validate", "review", "integrate", "assemble", "explore", "solve"]
    if (
      run.cycle > 0 &&
      (!run.pending.length || run.pending.length === 0) &&
      !run.feedback &&
      !run.planInvalid &&
      (midwork.includes(run.phase) || ["unfinished", "cancelled"].includes(run.phase))
    ) {
      run.cycle--
      run.error = null
      this.store.save(run)
      this.store.event(run, "resume", { cycle: run.cycle, phase: run.phase })
    }
    const acquired = this.store.db.transaction(() => {
      const lease = this.store.db.query("SELECT * FROM leases WHERE session = ?").get(session)
      if (lease && lease.expires > Date.now()) return false
      this.store.db.query("INSERT OR REPLACE INTO leases VALUES (?, ?, ?)").run(session, this.owner, Date.now() + 90000)
      return true
    })()
    if (!acquired) return "该会话的工作正由另一插件实例执行；请用 /loca-status 查看记录。"
    const heartbeat = setInterval(
      () =>
        this.store.db
          .query("UPDATE leases SET expires = ? WHERE session = ? AND owner = ?")
          .run(Date.now() + 90000, session, this.owner),
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
        this.store.db.query("DELETE FROM leases WHERE session = ? AND owner = ?").run(session, this.owner)
        this.requests.delete(session)
      })
  }

  async work(run) {
    const store = this.store
    // Entry phase (before cycle bookkeeping overwrites it): a run that crashed
    // mid-audit-pipeline resumes INTO the pipeline, not back through assembly.
    const entryPhase = run.phase
    // Resume always restarts from immutable artifacts. Never silently reuse an interrupted approval.
    await parallel(
      store.jobs(run).filter((job) => ["preparing", "running", "checking", "correcting"].includes(job.status)),
      this.cfg.concurrency,
      async (job) => {
        if (job.session)
          await this.runner.client.session.abort({ path: { id: job.session }, query: { directory: job.directory } })
        store.job(run, job, "stale", { reason: "Interrupted execution recovered" })
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
      run.plan = null
      run.subresults = {}
      run.planInvalid = false
      store.save(run)
      store.put(run, "policy", "workflow.json", JSON.stringify(this.cfg))
    }
    if (!run.contract) {
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
          // Origins may quote human input verbatim or any evidence the
          // contract itself froze while reading (documents the user pointed at).
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
            if (
              !value.criteria.some((next) => next.id === item.id) &&
              !value.removed.some((next) => next.id === item.id)
            )
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
      // Proceed by documented assumption; stop only for blocking questions or
      // review failures. Resolvable ambiguity is never a reason to halt.
      const blocking = contract.value.questions.filter((item) => item.blocking)
      run.questions = contract.value.questions.filter((item) => !item.blocking)
      if (blocking.length || fidelity.value.verdict !== "pass") {
        store.move(run, "needs_human", { questions: blocking, review: fidelity.value })
        throw new Error(this.renderClarification(blocking, fidelity.value))
      }
      run.contract = contract.value
      store.save(run)
      // Stage digest: the user sees what the contract phase actually established.
      store.event(run, "stage", {
        stage: "contract",
        round: run.round,
        cycle: run.cycle,
        summary: `合约已确立：目标「${run.contract.goal.slice(0, 80)}」，验收标准 ${run.contract.criteria.length} 条（${run.contract.criteria.map((c) => c.id).join("、")}）${run.questions.length ? `；${run.questions.length} 个非阻塞问题已按默认继续` : ""}`,
      })
      this.report(run, "contract", [
        "## 本阶段完成的工作",
        `根据你的输入确立了合约（goal）与验收标准（criteria）。`,
        "",
        "### 目标",
        run.contract.goal,
        "",
        "### 验收标准",
        ...run.contract.criteria.map((c) => `- **${c.id}**：${c.text}（验证方式：${c.method}）`),
        "",
        "## 如何阅读更详细的输出",
        "各子问题的详细成果（如每部分证明）在工作流后续阶段会以 artifact 形式注册；",
        "届时在本目录的阶段报告中会列出对应的阅读路径。",
        "",
        "## 下一阶段计划",
        "勘察规划（explore）：通读合约与已有材料，产出粗粒度串行攻坚计划（子问题划分）。",
      ])
    }
    for (; run.cycle < this.cfg.cycles; ) {
      this.guard(run)
      run.cycle++
      store.move(run, "explore")
      // Sub-phase 1: explore + plan. The plan survives infra failures: it is only
      // re-planned on new human input (round), quality feedback (planInvalid) or
      // an assemble "working" verdict — never because a cycle crashed midway.
      if (!run.plan || run.planInvalid || run.plan.round !== run.round) {
        // Failed attacks get a fresh retry on plan reuse; completed ones persist.
        for (const [id, result] of Object.entries(run.subresults ?? {})) if (result.failed) delete run.subresults[id]
        const priorPlan =
          run.plan && run.plan.round === run.round
            ? {
                strategy: run.plan.strategy,
                subproblems: run.plan.subproblems.map((sub) => ({
                  id: sub.id,
                  goal: sub.goal,
                  status: run.subresults?.[sub.id]?.status ?? "unattempted",
                })),
              }
            : null
        const explore = await this.runner.call(
          run,
          "explore",
          this.packet(run, {
            previous: run.candidate ?? null,
            priorPlan,
            feedback: run.feedback ?? null,
            history: run.history,
          }),
          (value) => {
            exact(
              value.subproblems.map((item) => item.id),
              [...new Set(value.subproblems.map((item) => item.id))],
              "subproblems",
            )
            const contractIds = new Set(run.contract.criteria.map((item) => item.id))
            for (const item of value.subproblems) {
              if (item.criteria.some((id) => !contractIds.has(id)))
                throw new Error(`Subproblem ${item.id} references unknown criterion`)
              // Cross-subproblem dependencies are the planner's architecture call,
              // not a protocol violation: a forward dependency is recorded and the
              // serial executor treats it as ordering advice (the dep's artifacts
              // become readable evidence whenever they exist). Only UNKNOWN deps
              // (not in the plan at all) are malformed.
              if (item.depends.some((id) => !value.subproblems.some((sub) => sub.id === id)))
                throw new Error(`Subproblem ${item.id} depends on unknown subproblem ${id}`)
            }
          },
        )
        run.plan = { cycle: run.cycle, round: run.round, ...explore.value }
        run.subresults = run.subresults ?? {}
        // The invalid signal is consumed by this replan: leaving it set would
        // force a fresh explore on every subsequent cycle/continue even while
        // attacks on this very plan are mid-flight.
        run.planInvalid = false
        store.save(run)
        // Stage digest: planning outcome (reuses are silent — nothing happened).
        store.event(run, "stage", {
          stage: "explore",
          round: run.round,
          cycle: run.cycle,
          summary: `规划完成：${explore.value.subproblems.length} 个子问题——${explore.value.subproblems.map((s) => s.id).join("、")}；已完成 ${Object.keys(run.subresults).length} 项沿用`,
        })
        this.report(run, "explore", [
          "## 本阶段完成的工作",
          `产出了攻坚计划：${explore.value.subproblems.length} 个粗粒度子问题（串行执行）。`,
          "",
          "### 求解策略",
          explore.value.strategy.slice(0, 800),
          "",
          "### 子问题划分",
          ...explore.value.subproblems.map(
            (sub) => `- **${sub.id}**（负责标准 ${sub.criteria.join("、")}）：${sub.goal.slice(0, 120)}`,
          ),
          "",
          "## 下一阶段计划",
          `逐题攻坚（attack）：按 ${explore.value.subproblems.map((s) => s.id).join(" → ")} 顺序，每个子问题一个独立会话完成；已完成的子问题自动跳过。`,
        ])
      }
      // Sub-phase 2: serial attack. Each sub-problem gets a fresh bounded session;
      // every accepted result is a durable checkpoint (resume skips finished subs).
      // Incremental repair semantics: a "working" sub-result from an earlier cycle
      // is kept and refined, never re-attacked from zero — only failed attempts
      // (infra errors) or genuinely unattempted subs consume a new attack call.
      const plan = run.plan
      for (const sub of plan.subproblems) {
        if (run.subresults[sub.id]) {
          const done = run.subresults[sub.id]
          if (done.failed || !done.status || done.status === "completed") continue
          // working: keep prior artifacts as the baseline; the feedback packet tells
          // attack exactly which gaps to close on top of existing work.
          if (run.feedback) {
            const prior = {
              ...done,
              incremental: true,
              note: "此前结果保留为基线：只补做缺口/修复指错，禁止重做已完成内容",
            }
            run.subresults[sub.id] = await this.refine(run, sub, prior)
            store.save(run)
          }
          continue
        }
        const priors = plan.subproblems
          .filter((item) => run.subresults[item.id])
          .map((item) => ({
            id: item.id,
            status: run.subresults[item.id].status,
            artifacts: run.subresults[item.id].artifacts,
            claims: run.subresults[item.id].claims,
          }))
        const attack = await this.runner
          .call(
            run,
            "attack",
            this.packet(run, { plan: { strategy: plan.strategy, subproblem: sub, priors }, history: run.history }, [
              ...new Set([...sub.evidence, ...priors.flatMap((prior) => prior.artifacts)]),
            ]),
            (value) => {
              // Claims are the model's judgement, not a protocol formality: an attack
              // that (while repairing) establishes a claim owned by ANOTHER subproblem's
              // criterion is genuine progress, not a violation. Accept it and route the
              // claim into feedback so the owner's next refine incorporates it.
              const foreign = value.claims.filter((claim) =>
                claim.criteria.some((id) => !new Set(sub.criteria).has(id)),
              )
              if (foreign.length) {
                this.store.event(run, "claim_reroute", {
                  job: value,
                  from: sub.id,
                  claims: foreign.map((claim) => claim.id),
                  note: "claim targets criteria outside this subproblem; routed into feedback",
                })
                run.feedback = run.feedback ?? { verdict: "fail", findings: [] }
                run.feedback.findings.push(
                  ...foreign.map((claim) => ({
                    id: `R-${claim.id}`,
                    target: "candidate",
                    detail: `子问题 ${sub.id} 攻坚中已建立断言 ${claim.id}（${claim.text.slice(0, 120)}），其标准属于其他子问题——由负责该标准的子问题在下一轮 refine 中吸收采纳`,
                    evidence: claim.artifact ? [claim.artifact] : [],
                    repair: "solve",
                    blocking: false,
                  })),
                )
              }
            },
          )
          .catch((error) => ({
            value: {
              status: "working",
              failed: true,
              artifacts: [],
              claims: [],
              problems: [
                {
                  id: `${sub.id}-E1`,
                  detail: `Attack attempts exhausted: ${String(error).slice(0, 200)}`,
                  status: "open",
                  evidence: [],
                },
              ],
              reason: String(error).slice(0, 500),
            },
          }))
        run.subresults[sub.id] = attack.value
        store.save(run)
        // Stage digest: one line per sub-problem, its verdict and what it produced.
        store.event(run, "stage", {
          stage: "attack",
          round: run.round,
          cycle: run.cycle,
          detail: sub.id,
          summary: `子问题 ${sub.id}（${sub.goal.slice(0, 60)}…）：${attack.value.status === "completed" ? "✅ 已解决" : attack.value.status === "working" ? "⏳ 有进展未完成" : "⛔ 被阻塞"}；产出 ${attack.value.artifacts.length} 个工件、${attack.value.claims.length} 条断言${attack.value.problems.filter((p) => p.status === "open").length ? `、${attack.value.problems.filter((p) => p.status === "open").length} 个未决问题` : ""}`,
        })
        this.report(run, `attack-${sub.id}`, [
          "## 本阶段完成的工作",
          `子问题 **${sub.id}** 攻坚会话结束，判定：**${attack.value.status === "completed" ? "已解决" : attack.value.status === "working" ? "有进展未完成" : "被阻塞"}**。`,
          "",
          `### 目标`,
          sub.goal,
          "",
          "### 产出",
          ...(attack.value.artifacts.length
            ? attack.value.artifacts.map((aid) => {
                const asset = this.store.asset(aid)
                return `- 工件「${asset.name}」（${asset.bytes} 字节；详细内容用 loca_evidence 读取 id：${aid}）`
              })
            : ["（无工件产出）"]),
          ...(attack.value.claims.length
            ? [
                "",
                "### 断言（对合约标准的声称）",
                ...attack.value.claims.map(
                  (claim) => `- **${claim.id}**（标准 ${claim.criteria.join("、")}）：${claim.text.slice(0, 150)}`,
                ),
              ]
            : []),
          ...(attack.value.problems.filter((p) => p.status === "open").length
            ? [
                "",
                "### 未决问题",
                ...attack.value.problems
                  .filter((p) => p.status === "open")
                  .map((p) => `- **${p.id}**：${p.detail.slice(0, 200)}`),
              ]
            : []),
          "",
          "## 下一阶段计划",
          `继续后续子问题攻坚；全部子问题结束后进入汇编（assemble）做覆盖检查与候选组装。`,
        ])
        if (attack.value.status === "blocked") {
          run.planInvalid = true
          run.feedback = {
            verdict: "fail",
            findings: [
              { id: "F1", target: sub.id, detail: attack.value.reason, evidence: [], repair: "solve", blocking: true },
            ],
          }
          store.save(run)
          break
        }
      }
      // Sub-phase 3: assemble. Combines sub-results into the final candidate and
      // decides completed/working against the full contract.
      // RESUME SHORT-CIRCUIT: a crash mid-pipeline (phase already split/structure/
      // inputs/validate/review/integrate) with a COMPLETED candidate re-enters the
      // audit pipeline directly — re-running assemble would risk a quality-verdict
      // regression on accepted work and burn a full assembly for nothing.
      const PIPELINE = ["split", "structure", "inputs", "validate", "review", "integrate"]
      const resumedPipeline =
        (PIPELINE.includes(entryPhase) || ((entryPhase === "cancelled" || entryPhase === "unfinished") && run.candidate?.status === "completed")) &&
        !run.feedback &&
        !run.planInvalid
      let assemble
      if (resumedPipeline) {
        assemble = { value: run.candidate, record: { id: run.dagrecord ?? null }, resuming: true }
        store.event(run, "pipeline_resume", { phase: run.phase, cycle: run.cycle })
      } else {
        store.move(run, "assemble")
        // The cycle's attacks have consumed the feedback (refine/attack packets
        // carried it): clear it now — stale findings would re-trigger refine rounds
        // and the reroute appends would grow the list without bound. The next verdict
        // installs a fresh feedback if gaps remain.
        run.feedback = null
        store.save(run)
        // SLIM assemble packet: the prompt carries only what coverage-checking needs
        // to PLAN (goal + criteria full text, subproblem one-liners, per-sub status and
        // id-level inventories, deliverables). Prose (claim texts, problem details,
        // full goal specs) lives in frozen report assets the agent reads on demand via
        // loca_evidence — the earlier full-payload prompt (60%+ subresult narrative,
        // ~67K input tokens) correlated with provider stream stalls.
        const subReports = new Map()
        for (const job of store.jobs(run)) {
          if (job.role === "attack" && job.status === "accepted" && job.report) {
            try {
              const raw = JSON.parse(this.store.asset(job.request).content)
              const pk = raw.packet ?? raw
              if (pk?.plan?.subproblem?.id) subReports.set(pk.plan.subproblem.id, job.report)
            } catch {}
          }
        }
        const slim = {
          slim: true,
          goal: run.contract.goal,
          criteria: run.contract.criteria,
          plan: {
            strategy: plan.strategy,
            subproblems: plan.subproblems.map((sub) => ({
              id: sub.id,
              goal: sub.goal.slice(0, 120),
              criteria: sub.criteria,
              full: "(完整任务书与依据在下方证据清单的 plan 资产中，用 loca_evidence 分段读取)",
            })),
          },
          subresults: plan.subproblems.map((sub) => {
            const result = run.subresults[sub.id] ?? null
            return {
              sub: sub.id,
              status: result?.status ?? null,
              artifacts: result?.artifacts ?? [],
              claims: (result?.claims ?? []).map((claim) => ({
                id: claim.id,
                criteria: claim.criteria,
                artifact: claim.artifact,
              })),
              problems: (result?.problems ?? []).map((problem) => ({ id: problem.id, status: problem.status })),
              detail: subReports.get(sub.id) ?? null,
            }
          }),
          candidate: run.candidate
            ? {
                status: run.candidate.status,
                artifacts: run.candidate.artifacts,
                claims: run.candidate.claims.map((claim) => ({
                  id: claim.id,
                  criteria: claim.criteria,
                  artifact: claim.artifact,
                })),
                problems: run.candidate.problems.map((problem) => ({ id: problem.id, status: problem.status })),
              }
            : null,
          feedback: run.feedback ?? null,
          history: run.history,
          // Retry economics: physical assembly outputs already on disk from earlier
          // attempts (candidate deliveries + role-written files). Retrying an assemble
          // should VERIFY or EXTEND these, never rebuild from scratch — that was the
          // top token sink (80 bash calls re-concatenating the same PART files).
          deliverables: this.deliverables(run),
          howToRead:
            "各子问题的完整结果（断言全文、问题详情、理由）已冻结为 report 证据资产：subresults[].detail 字段给出资产 id，用 loca_evidence(id,start,end) 分段读取（每次≤12000字符）。断言/问题的 id 已列出，需要正文时按 id 在 report 中查找。",
        }
        assemble = await this.runner.call(
          run,
          "assemble",
          this.packet(run, slim, [
            ...new Set([...run.assets.filter((id) => this.store.asset(id).kind === "report"), ...subReports.values()]),
          ]),
          (value) => {
            solved(value, run.contract, new Map(run.assets.map((id) => [id, store.asset(id)])), run.candidate)
          },
        )
      } // end non-resume assemble
      if (!resumedPipeline) {
        // Candidate ledger: the previous candidate is archived by cycle (never
        // overwritten in place) so superseded artifacts stay recoverable — the model
        // has full freedom to retire prior work, the engine guarantees history.
        if (run.candidate && run.candidate !== assemble.value) {
          run.candidates = run.candidates ?? []
          run.candidates.push({
            cycle: run.cycle,
            round: run.round,
            archived: new Date().toISOString(),
            status: run.candidate.status,
            artifacts: run.candidate.artifacts,
            claims: run.candidate.claims,
            problems: run.candidate.problems,
            superseded_by: assemble.value.status,
          })
        }
        run.candidate = assemble.value
        store.save(run)
        // Stage digest: the assemble verdict is the cycle's quality gate — say what
        // stands and what is missing, so a re-plan reads as incremental repair.
        {
          const open = assemble.value.problems.filter((p) => p.status === "open")
          store.event(run, "stage", {
            stage: "assemble",
            round: run.round,
            cycle: run.cycle,
            summary:
              assemble.value.status === "completed"
                ? `汇编完成：候选满足全部 ${run.contract.criteria.length} 条标准（${assemble.value.artifacts.length} 个工件、${assemble.value.claims.length} 条断言），进入审核流水线`
                : `汇编部分完成：候选含 ${assemble.value.artifacts.length} 个工件、${assemble.value.claims.length} 条断言；${open.length} 个缺口（${open
                    .slice(0, 3)
                    .map((p) => p.id)
                    .join("、")}${open.length > 3 ? "…" : ""}）将反馈回下一轮增量补做，已完成的子问题不会重跑`,
          })
          this.report(run, "assemble", [
            "## 本阶段完成的工作",
            `汇编会话结束，判定：**${assemble.value.status === "completed" ? "满足全部合约标准" : assemble.value.status === "working" ? "部分完成，仍有缺口" : "被阻塞"}**。`,
            "",
            `### 候选内容`,
            `- 工件 ${assemble.value.artifacts.length} 个、断言 ${assemble.value.claims.length} 条`,
            ...(assemble.value.artifacts.length
              ? assemble.value.artifacts.slice(0, 30).map((aid) => {
                  const asset = this.store.asset(aid)
                  return `  - 「${asset.name}」（详细内容用 loca_evidence 读取 id：${aid}）`
                })
              : []),
            ...(assemble.value.problems.filter((p) => p.status === "open").length
              ? [
                  "",
                  "### 未闭合缺口（将反馈回下一轮增量修复）",
                  ...assemble.value.problems
                    .filter((p) => p.status === "open")
                    .map((p) => `- **${p.id}**：${p.detail.slice(0, 200)}`),
                ]
              : []),
            "",
            "## 如何阅读更详细的输出",
            "候选的每个工件都是不可变注册文件：上表中 loca_evidence 的 id 即为阅读入口。",
            "",
            "## 下一阶段计划",
            assemble.value.status === "completed"
              ? "进入分步审核流水线：拆分（split）→ 结构审核 → 输入审核 → 验证 → 面板审核 → 集成 → 待人工验收。"
              : "重开缺口归属的子问题做增量修复（已完成部分不重做），然后再次汇编。",
          ])
        }
      } // end non-resume bookkeeping
      if (assemble.value.status === "blocked") throw new Error(`Solve blocked: ${assemble.value.reason}`)
      if (assemble.value.status === "completed") {
        const ready = { value: false, repair: false }
        for (const index of Array.from({ length: this.cfg.splits }, (_, index) => index)) {
          store.move(run, "split", { index })
          const split = await this.runner.call(
            run,
            "split",
            this.packet(run, { candidate: run.candidate, previous: run.dag ?? null, feedback: run.feedback ?? null }),
            (value) =>
              graph(value, run.contract, run.candidate, new Map(run.assets.map((id) => [id, store.asset(id)]))),
          )
          run.dag = split.value
          run.dagrecord = split.record.id
          store.save(run)
          store.move(run, "structure")
          const structure = await this.runner.call(
            run,
            "structure",
            this.packet(run, { checks: this.cfg.checks.structure, candidate: run.candidate, dag: run.dag }, [
              ...run.assets.filter(
                (id) => !["report", "port", "packet", "prompt", "policy", "fragment"].includes(store.asset(id).kind),
              ),
              run.dagrecord,
            ]),
            (value) => review(value, this.cfg.checks.structure),
          )
          if (structure.value.verdict !== "pass") {
            run.feedback = structure.value
            store.save(run)
            if (structure.value.findings.some((item) => item.repair === "solve")) {
              ready.repair = true
              break
            }
            continue
          }
          store.move(run, "inputs")
          const inputs = await parallel(run.dag.nodes, this.cfg.concurrency, async (node) => {
            const result = await this.runner.call(
              run,
              "inputs",
              this.node(run, node, { checks: this.cfg.checks.inputs }),
              (value) => review(value, this.cfg.checks.inputs),
            )
            return { node: node.id, ...result.value }
          })
          run.transfer = Object.fromEntries(inputs.map((item) => [item.node, item.verdict]))
          if (inputs.some((item) => item.verdict !== "pass")) {
            run.feedback = inputs
            store.save(run)
            if (inputs.some((item) => item.findings.some((issue) => issue.repair === "solve"))) {
              ready.repair = true
              break
            }
            continue
          }
          ready.value = true
          break
        }
        if (ready.repair) continue
        if (!ready.value) throw new Error("DAG repair budget exhausted")
        store.move(run, "validate")
        const validation = await parallel(
          run.dag.nodes.filter((node) => node.purpose === "acceptance"),
          this.cfg.concurrency,
          async (node) => {
            const result = await this.runner.call(run, "validate", this.node(run, node), (value, context) => {
              exact(
                value.criteria.map((item) => item.id),
                node.criteria,
                "validation criteria",
              )
              if (value.verdict === "pass" && value.findings.some((item) => item.blocking))
                throw new Error("Validation pass contradicts blocking findings")
              if (value.verdict !== "pass" && !value.findings.some((item) => item.blocking))
                throw new Error("Failed validation must explain the blocking problem")
              if (
                node.type === "computation" &&
                value.verdict === "pass" &&
                !value.evidence.some(
                  (id) =>
                    context.produced.includes(id) &&
                    store.asset(id).kind === "execution" &&
                    JSON.parse(store.asset(id).content).exit === 0,
                )
              )
                throw new Error("Computational validation requires a new successful execution, not solver testimony")
            })
            return [node.id, result]
          },
        )
        run.validations = Object.fromEntries(validation.map(([id, result]) => [id, result.value]))
        store.save(run)
        store.move(run, "review")
        // One shared queue bounds all model calls, including panels and dialogues.
        const tasks = run.dag.nodes.flatMap((node) =>
          Array.from({ length: this.cfg.reviewers }, (_, slot) => ({ node, slot })),
        )
        const panels = await parallel(tasks, this.cfg.concurrency, async ({ node, slot }) => {
          const evidence = validation.find(([id]) => id === node.id)?.[1]
          const packet = this.node(
            run,
            node,
            { checks: this.cfg.checks[node.type], slot, validation: evidence?.value ?? null },
            evidence ? [evidence.record.id, ...evidence.produced] : [],
          )
          const result = await this.runner.call(
            run,
            node.type,
            packet,
            (value) => review(value, this.cfg.checks[node.type]),
            String(slot),
          )
          return { node, slot, result, packet }
        })
        // Dialogues run after blind panels; no participant sees any other panel's verdict.
        await parallel(
          run.dag.nodes.filter((node) => node.type === "reasoning"),
          this.cfg.concurrency,
          async (node) => {
            const transcript = []
            const records = []
            for (const turn of Array.from({ length: this.cfg.questions }, (_, index) => index + 1)) {
              const question = await this.runner.call(
                run,
                "questioner",
                this.node(run, node, { turn, transcript }, records),
                (value) => {
                  const ids = [
                    ...transcript.flatMap((item) => item.questions.map((question) => question.id)),
                    ...value.questions.map((item) => item.id),
                  ]
                  if (new Set(ids).size !== ids.length || value.questions.length > 16)
                    throw new Error("Questions need unique IDs; at most 16 per turn (keep each question substantive)")
                },
              )
              records.push(question.record.id)
              const answer = await this.runner.call(
                run,
                "defender",
                this.node(run, node, { transcript, questions: question.value.questions }, records),
                (value) =>
                  exact(
                    value.answers.map((item) => item.id),
                    question.value.questions.map((item) => item.id),
                    "defender answers",
                  ),
              )
              records.push(answer.record.id)
              transcript.push({ ...question.value, ...answer.value })
            }
            // Sequential slots inside each node preserve the global concurrency bound.
            for (const panel of panels.filter((item) => item.node.id === node.id)) {
              const closing = await this.runner.call(
                run,
                "closing",
                this.node(run, node, { checks: this.cfg.checks.reasoning, transcript, initial: panel.result.value }, [
                  ...records,
                  panel.result.record.id,
                ]),
                (value) => {
                  review(value, this.cfg.checks.reasoning)
                  exact(
                    value.answers.map((item) => item.id),
                    transcript.flatMap((item) => item.questions.map((question) => question.id)),
                    "closing answers",
                  )
                  if (
                    value.verdict === "pass" &&
                    (value.answers.some((item) => item.status !== "resolved") ||
                      transcript.some((item) => item.answers.some((answer) => answer.status !== "defended")))
                  )
                    throw new Error("Conceded, unanswered or newly introduced premises cannot pass")
                  // A closing report may elaborate an initial finding, but may not erase it by voting.
                  panel.result.value.findings
                    .filter((item) => item.blocking)
                    .forEach((issue) => {
                      if (!value.findings.some((item) => item.id === issue.id && item.blocking))
                        throw new Error("An initial blocking finding requires a repaired candidate and a new cycle")
                    })
                },
                String(panel.slot),
              )
              panel.result = closing
            }
          },
        )
        run.reports = Object.fromEntries(
          run.dag.nodes.map((node) => [
            node.id,
            panels.filter((item) => item.node.id === node.id).map((item) => item.result.value),
          ]),
        )
        run.nodes = aggregate(run.dag.nodes, run.reports, this.cfg.reviewers, run.validations)
        store.save(run)
        if (Object.values(run.nodes).some((node) => node.effective !== "pass")) {
          run.feedback = { panels: run.reports, validations: run.validations, nodes: run.nodes }
          store.save(run)
          continue
        }
        store.move(run, "integrate")
        const integration = await this.runner.call(
          run,
          "integrate",
          this.packet(run, {
            candidate: run.candidate,
            dag: run.dag,
            reports: run.reports,
            validations: run.validations,
            nodes: run.nodes,
            checks: this.cfg.checks.integrate,
          }),
          (value) => {
            review(value, this.cfg.checks.integrate)
            exact(
              value.criteria.map((item) => item.id),
              run.contract.criteria.map((item) => item.id),
              "delivery criteria",
            )
            value.criteria.forEach((item) => {
              if (item.artifacts.some((id) => !run.candidate.artifacts.includes(id)))
                throw new Error("Delivery references an artifact outside the candidate")
              if (
                item.nodes.some(
                  (id) =>
                    !run.dag.nodes.some(
                      (node) =>
                        node.id === id &&
                        node.purpose === "acceptance" &&
                        node.criteria.includes(item.id) &&
                        run.nodes[id].effective === "pass",
                    ),
                )
              )
                throw new Error("Delivery lacks effective independent validation")
            })
          },
        )
        if (integration.value.verdict !== "pass") {
          run.feedback = integration.value
          store.save(run)
          continue
        }
        this.guard(run)
        await this.deliver(run, integration)
        store.move(run, "awaiting_human", { delivery: run.delivery })
        return run.summary
      }
      // working: quality verdict — re-plan the remaining work next cycle
      run.planInvalid = true
      // Merge duplicate problems BEFORE building feedback: models clone a persistent
      // gap into a new id every cycle ("P-G7b", "P-G7b-c7", "-c8"…), and the
      // anti-silent-removal inheritance then keeps every clone open forever. Merge
      // rule: a problem whose detail declares it continues/supersedes another problem
      // (same gap) collapses onto the ORIGINAL id; the clone is dropped, not inherited.
      const openGaps = mergeProblems(assemble.value.problems)
      // Rewrite the candidate problem list to the merged set so future cycles inherit
      // the deduplicated list instead of re-expanding it.
      assemble.value.problems = openGaps
      run.candidate = assemble.value
      run.feedback = {
        verdict: "fail",
        findings: openGaps
          .filter((item) => item.status === "open")
          .map((item, index) => ({
            id: `P${index + 1}`,
            target: "candidate",
            detail: item.detail,
            evidence: item.evidence,
            repair: "solve",
            blocking: false,
          })),
      }
      // Reopen owners of open gaps. A completed sub-problem is SKIPPED by attack, so
      // any gap it owns would persist forever — reopen it as "working" with its
      // artifacts as the incremental baseline. Owner resolution prefers explicit
      // problem-id naming (P-<sub>-…), then evidence-id membership in the sub's
      // claims/artifacts, then criteria responsibility from the plan.
      const subs = (run.plan?.subproblems ?? []).map((sub) => sub.id)
      const gapOwners = new Set()
      for (const problem of openGaps) {
        const named = subs.find((id) => problem.id.startsWith(`P-${id}`) || problem.id.startsWith(`${id}-`))
        if (named) {
          gapOwners.add(named)
          continue
        }
        const byEvidence = subs.find((id) => {
          const result = run.subresults[id]
          if (!result) return false
          const owned = new Set([...(result.artifacts ?? []), ...(result.claims ?? []).map((claim) => claim.artifact)])
          return problem.evidence.some((ev) => owned.has(ev))
        })
        if (byEvidence) gapOwners.add(byEvidence)
      }
      for (const id of gapOwners) {
        const result = run.subresults[id]
        if (result?.status === "completed")
          run.subresults[id] = {
            ...result,
            status: "working",
            note: "已重开：assemble 反馈仍有该子问题相关的未闭合缺口，按增量基线修复",
          }
      }
      store.save(run)
    }
    throw new Error("Repair cycle budget exhausted; no accepted result was produced")
  }

  // Retry economics for assemble: list physical outputs that already exist so a
  // retry verifies/extends instead of rebuilding (measured: 37-80 bash calls per
  // retry were re-concatenation of identical PART files).
  deliverables(run) {
    const entries = []
    for (const base of [
      path.join(this.root, "loca", "results"),
      path.join(this.root, "code"),
      path.join(this.root, "proof"),
    ]) {
      try {
        for (const name of readdirSync(base)) entries.push(path.join(base, name))
      } catch {}
    }
    return entries.slice(0, 60)
  }

  async deliver(run, result) {
    const dir = path.join(
      this.root,
      "loca/results",
      run.id,
      `round-${run.round}`,
      `cycle-${run.cycle}-${result.record.hash.slice(0, 10)}`,
    )
    await mkdir(dir, { recursive: true })
    await mkdir(path.join(dir, "evidence"), { recursive: true })
    const files = await Promise.all(
      run.candidate.artifacts.map(async (id, index) => {
        const asset = this.store.asset(id)
        const file = path.join(dir, `${index + 1}-${path.basename(asset.name)}`)
        // 'w' (overwrite-safe): the dir name carries the report hash so distinct
        // deliveries never collide, but a crash-resumed delivery re-writes the same
        // deterministic content — 'wx' would crash on the leftover file.
        await writeFile(file, asset.content, { flag: "w" })
        return { id, file, hash: asset.hash }
      }),
    )
    const text = [
      `LOCA 第 ${run.round} 轮已完成内部审核，等待你验收。`,
      result.value.summary,
      ...result.value.criteria.map((item) => {
        const criterion = run.contract.criteria.find((criterion) => criterion.id === item.id)
        return `- **${item.id}：${criterion.text}**\n  成果：${item.artifacts
          .map((id) => {
            const file = files.find((file) => file.id === id)
            return `[${path.basename(file.file)}](${file.file})`
          })
          .join("、")}\n  独立验证：${item.nodes.join("、")}；范围：${item.scope}\n  建议亲自审核：${item.review}`
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
    // Tolerate pruned asset rows (recovery surgery): skip unreadable ids instead
    // of failing the delivery on the whole evidence inventory.
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
          candidate: run.candidate,
          dag: run.dag,
          transfer: run.transfer,
          validations: run.validations,
          nodes: run.nodes,
          reports: run.reports,
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

  // Record role-side interpretations of ambiguity as first-class run state so
  // users can audit and override them at any time (/loca-assumptions).
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

  // Human-readable run status. The raw correction chain (nested retry errors,
  // full asset id inventories) is machine-facing detail: lead with the first
  // CONCRETE cause — the "Role X exhausted retries" wrapper is generic and
  // tells the user nothing — ids elided to short tokens, capped length.
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
    const generic = /^(Role .+ exhausted protocol retries|Aether API error|Round role-call budget exhausted)[:：]?$/
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
    const reasons = {
      unfinished: "本轮在可重试错误后停止；进度已保全",
      cancelled: "本轮已取消；进度已保全",
      needs_human: "等待你的输入",
    }
    const label = {
      new: "启动",
      contract: "合约",
      explore: "勘察规划",
      solve: "逐题攻坚",
      assemble: "汇编",
      split: "拆分",
      structure: "结构审核",
      inputs: "输入审核",
      validate: "验证",
      review: "面板审核",
      integrate: "集成",
      awaiting_human: "待人工验收",
      accepted: "已验收",
      cancelled: "已取消",
      unfinished: "未完成",
      needs_human: "需人工输入",
    }
    return [
      `LOCA 第 ${run.round} 轮 / 修复 ${run.cycle}：${label[run.phase] ?? run.phase}${reasons[run.phase] ? `——${reasons[run.phase]}` : ""}`,
      `角色调用 ${run.calls}/${this.cfg.calls}；已验收执行 ${jobs.filter((job) => job.status === "accepted").length}；假设 ${run.assumptions?.length ?? 0} 条（/loca-assumptions 查看）${open.length ? `；待澄清 ${open.length} 项（已按默认继续）` : ""}；待处理用户输入 ${run.pending.length}。`,
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

  // Isolated child sessions have no human to answer permission asks; fail fast
  // with an actionable message instead of hanging the role call forever.
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
    // Assemble only combines and coverage-checks; all verification computation
    // belongs to attack/validate/computation roles (assemble offload).
    if (!["attack", "validate", "computation"].includes(context.role)) throw new Error("This role cannot execute code")
    // Execution inputs must be FROZEN run assets — the integrity boundary is the
    // project's asset store, not this session's packet scope: earlier sessions'
    // artifacts are legitimate inputs (an aggregate re-run over 9 frozen files was
    // once rejected wholesale here and forced a wasteful re-freeze workaround).
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
    // Inputs ride the sandbox manifest; cap the count to keep it sane.
    if (frozen.length > 64) throw new Error("Execution inputs are capped at 64 frozen assets per run")
    await ctx.ask({
      permission: "bash",
      patterns: ["loca:python-sandbox", `${this.cfg.execution.python} -I -S <frozen-code>`],
      always: [],
      metadata: { code: args.code, inputs: args.inputs },
    })
    const code = this.register(context, "code", "verification.py", args.code)
    const result = await execute(args.code, frozen, this.cfg.execution, ctx.abort)
    return this.register(
      context,
      "execution",
      "execution.json",
      JSON.stringify({ ...result, code: code.id, codehash: hash(args.code) }),
    )
  }
}
