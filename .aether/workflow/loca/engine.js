import path from "node:path"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Store, hash } from "./store.js"
import { Runner, parallel } from "./runner.js"
import { exact, review } from "./schema.js"
import { aggregate, graph, solved } from "./graph.js"
import { execute } from "./execute.js"

export const engines = new Map()

export class Engine {
  constructor(root, cfg, client, dir = path.join(root, ".aether/workflow/loca/.runtime")) {
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
    this.owner = randomUUID()
    this.store.db.exec("CREATE TABLE IF NOT EXISTS leases (session TEXT PRIMARY KEY, owner TEXT, expires INTEGER)")
  }

  guard(run, epoch = run.epoch) {
    if (this.store.run(run.session)?.epoch !== epoch) throw new Error("STALE: newer user input supersedes this work")
    if (this.active.get(run.session)?.controller.signal.aborted) throw new Error("Workflow cancelled")
  }

  capture(session, message, model) {
    const run = this.store.run(session) ?? this.store.create(session)
    const command = this.commands.get(session)
    this.commands.delete(session)
    if (command && command.action !== "work") {
      this.requests.set(session, command.action)
      if (command.action === "cancel") {
        const expected = run.epoch
        run.epoch++
        this.store.save(run, expected)
        this.store.move(run, "cancelled")
        this.active.get(session)?.controller.abort()
      }
      return
    }
    this.requests.set(session, "work")
    const text =
      command?.text ??
      message.parts
        .filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
    if (!text.trim() || text.trim() === "continue") return
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
    this.store.save(run, expected)
    this.store.event(run, "human_input", { epoch: run.epoch, message: message.id, text })
    this.active.get(session)?.controller.abort()
  }

  packet(
    run,
    value,
    ids = run.assets.filter(
      (id) => !["report", "port", "packet", "prompt", "policy", "fragment"].includes(this.store.asset(id).kind),
    ),
  ) {
    return {
      version: this.cfg.version,
      round: run.round,
      cycle: run.cycle,
      contract: run.contract,
      ...value,
      assets: [...new Set(ids)].map((id) => {
        const asset = this.store.asset(id)
        if (asset.content.length <= 8000) return asset
        return {
          ...asset,
          content: undefined,
          total: asset.content.length,
          read: "Full content is available via loca_evidence(id,start,end). No excerpt has been substituted for the original.",
        }
      }),
    }
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

  async act(session, ctx) {
    const action = this.requests.get(session)
    const run = this.store.run(session)
    if (!run) return "请先使用 /loca 输入目标和验收标准。"
    if (action === "status") return this.status(run)
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
      this.active.get(session)?.controller.abort()
      this.requests.delete(session)
      return "LOCA 工作已取消；已有成果和审核记录已保留。"
    }
    if (this.active.has(session)) return this.status(run)
    if (!run.pending.length && run.phase === "accepted") return this.status(run)
    if (!run.pending.length && run.phase === "awaiting_human") return run.summary
    if (!run.pending.length && !run.history.length) return "请输入目标与验收标准。"
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
    this.active.set(session, { controller })
    const stop = () => controller.abort()
    ctx.abort?.addEventListener("abort", stop, { once: true })
    if (ctx.abort?.aborted) stop()
    return this.work(run)
      .catch((error) => {
        const current = this.store.run(session)
        if (current.epoch !== run.epoch) {
          this.store.event(current, "superseded", { previous: run.epoch })
          return current.phase === "cancelled"
            ? "工作已取消，旧结果不会推进流程。"
            : "已保存新意见，并停止旧轮次。请使用 /loca continue 开始新一轮。"
        }
        this.store.move(
          run,
          controller.signal.aborted ? "cancelled" : run.phase === "needs_human" ? "needs_human" : "unfinished",
          { error: String(error) },
        )
        run.error = String(error)
        this.store.save(run)
        return this.status(run)
      })
      .finally(() => {
        clearInterval(heartbeat)
        ctx.abort?.removeEventListener("abort", stop)
        this.active.delete(session)
        this.store.db.query("DELETE FROM leases WHERE session = ? AND owner = ?").run(session, this.owner)
        this.requests.delete(session)
      })
  }

  async work(run) {
    const store = this.store
    // Resume always restarts from immutable artifacts. Never silently reuse an interrupted approval.
    await parallel(
      store.jobs(run).filter((job) => ["preparing", "running", "checking"].includes(job.status)),
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
          const text = run.history.map((item) => item.text).join("\n")
          if (value.criteria.some((item) => !text.includes(item.origin)))
            throw new Error("Criterion origin must quote actual human input")
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
        this.packet(run, { history: run.history, previous: run.previous ?? null, proposed: contract.value }, [
          raw.id,
          contract.record.id,
        ]),
        (value) => review(value, this.cfg.checks.contract),
      )
      if (contract.value.questions.length || fidelity.value.verdict !== "pass") {
        store.move(run, "needs_human", { questions: contract.value.questions, review: fidelity.value })
        throw new Error(
          `Contract needs clarification: ${JSON.stringify({ questions: contract.value.questions, findings: fidelity.value.findings })}`,
        )
      }
      run.contract = contract.value
      store.save(run)
    }
    for (; run.cycle < this.cfg.cycles; ) {
      this.guard(run)
      run.cycle++
      store.move(run, "solve")
      const completed = { value: false }
      for (const index of Array.from({ length: this.cfg.solves }, (_, index) => index)) {
        const result = await this.runner.call(
          run,
          "solve",
          this.packet(run, { previous: run.candidate ?? null, feedback: run.feedback ?? null, history: run.history }),
          (value) => {
            solved(value, run.contract, new Map(run.assets.map((id) => [id, store.asset(id)])), run.candidate)
          },
        )
        run.candidate = result.value
        store.save(run)
        if (result.value.status === "blocked") throw new Error(`Solve blocked: ${result.value.reason}`)
        if (result.value.status === "completed") {
          completed.value = true
          break
        }
        store.event(run, "solve_continues", { index, problems: result.value.problems })
      }
      if (!completed.value) throw new Error("Solve budget exhausted with known unfinished work")
      const ready = { value: false, repair: false }
      for (const index of Array.from({ length: this.cfg.splits }, (_, index) => index)) {
        store.move(run, "split", { index })
        const split = await this.runner.call(
          run,
          "split",
          this.packet(run, { candidate: run.candidate, previous: run.dag ?? null, feedback: run.feedback ?? null }),
          (value) => graph(value, run.contract, run.candidate, new Map(run.assets.map((id) => [id, store.asset(id)]))),
        )
        run.dag = split.value
        run.dagrecord = split.record.id
        store.save(run)
        store.move(run, "structure")
        const structure = await this.runner.call(
          run,
          "structure",
          this.packet(run, { candidate: run.candidate, dag: run.dag }, [
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
          const result = await this.runner.call(run, "inputs", this.node(run, node), (value) =>
            review(value, this.cfg.checks.inputs),
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
                if (new Set(ids).size !== ids.length || value.questions.length > 8)
                  throw new Error("Questions need unique IDs; max 8 per turn")
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
    throw new Error("Repair cycle budget exhausted; no accepted result was produced")
  }

  async deliver(run, result) {
    const dir = path.join(
      this.root,
      ".aether/workflow/loca/results",
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
        await writeFile(file, asset.content, { flag: "wx" })
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
    const evidence = run.assets.map((id) => {
      const asset = this.store.asset(id)
      const { content, ...metadata } = asset
      const file = `evidence/${asset.hash}.txt`
      return { ...metadata, file }
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

  status(run) {
    const jobs = this.store.jobs(run)
    return `LOCA 第 ${run.round} 轮 / 修复 ${run.cycle}：${run.phase}\n角色调用 ${run.calls}/${this.cfg.calls}；已验收执行 ${jobs.filter((job) => job.status === "accepted").length}；待处理用户输入 ${run.pending.length}。${run.error ? `\n原因：${run.error}` : ""}\n记录：${this.store.dir}/state.sqlite${run.phase === "accepted" ? `\n本轮已由人类验收。成果与审核包：${run.directory}` : run.summary ? `\n\n${run.summary}` : "\n尚未产生通过审核的交付结果。"}`
  }

  async source(context, args, ctx) {
    if (context.role !== "solve") throw new Error("Only solve can introduce new sources")
    this.guard(context.run, context.epoch)
    if (/^https?:\/\//.test(args.path)) {
      await ctx.ask({ permission: "webfetch", patterns: [args.path], always: [], metadata: { url: args.path } })
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
    const file = await realpath(path.resolve(this.root, args.path))
    if (file !== this.root && !file.startsWith(this.root + path.sep))
      await ctx.ask({
        permission: "external_directory",
        patterns: [path.dirname(file) + "/*"],
        always: [],
        metadata: { path: file },
      })
    await ctx.ask({ permission: "read", patterns: [file], always: [], metadata: { path: file } })
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
    if (!["solve", "validate", "computation"].includes(context.role)) throw new Error("This role cannot execute code")
    if (args.inputs.some((id) => !context.allowed.has(id)))
      throw new Error("Execution attempted to introduce undeclared inputs")
    await ctx.ask({
      permission: "bash",
      patterns: ["loca:python-sandbox", `${this.cfg.execution.python} -I -S <frozen-code>`],
      always: [],
      metadata: { code: args.code, inputs: args.inputs },
    })
    const code = this.register(context, "code", "verification.py", args.code)
    const result = await execute(
      args.code,
      args.inputs.map((id) => this.store.asset(id)),
      this.cfg.execution,
      ctx.abort,
    )
    return this.register(
      context,
      "execution",
      "execution.json",
      JSON.stringify({ ...result, code: code.id, codehash: hash(args.code) }),
    )
  }
}
