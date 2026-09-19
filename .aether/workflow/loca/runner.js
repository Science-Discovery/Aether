import { randomUUID } from "node:crypto"
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { schema, references, byName, closest } from "./schema.js"
import { hash } from "./store.js"

export async function parallel(items, count, fn) {
  const queue = items.map((item, index) => ({ item, index }))
  const results = []
  const failures = []
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async () => {
      while (queue.length) {
        const next = queue.shift()
        await fn(next.item, next.index).then(
          (result) => {
            results[next.index] = result
          },
          (error) => {
            failures.push(error)
          },
        )
      }
    }),
  )
  if (failures.length)
    throw new AggregateError(failures, "One or more required jobs failed; no review slots were dropped")
  return results
}

export function unwrap(result) {
  if (result.error || !result.data)
    throw new Error(`Aether API error: ${JSON.stringify(result.error ?? "empty response")}`)
  return result.data
}

export class Runner {
  constructor(engine, client) {
    this.engine = engine
    this.client = client
  }

  // controller：任务级中止信号（C 类回滚/推测中止用）；engine.active 的 run 级
  // 取消信号在内部与之合并。
  async call(run, role, packet, check = () => {}, slot = "", controller = null) {
    const engine = this.engine
    const store = engine.store
    const cfg = engine.cfg
    const epoch = run.epoch
    const frozen = JSON.stringify(packet)
    if (Buffer.byteLength(frozen) > cfg.packet)
      throw new Error("Context packet exceeds limit; split into smaller blocks (no silent truncation)")
    const errors = []
    const limit = cfg.timeout?.[role] ?? null
    let timeout = null
    for (const attempt of Array.from({ length: cfg.attempts }, (_, index) => index + 1)) {
      engine.guard(run, epoch)
      if (++run.calls > cfg.calls) throw new Error("Round role-call budget exhausted")
      store.save(run)
      const job = {
        id: randomUUID(),
        parent: run.session,
        role,
        slot,
        attempt,
        round: run.round,
        cycle: run.cycle,
        epoch,
        packet: hash(frozen),
        session: null,
      }
      job.request = store.put(run, "packet", `${job.id}.json`, frozen).id
      store.job(run, job, "queued")
      store.job(run, job, "preparing")
      const dir = path.join(store.dir, "contexts", job.id)
      const context = {
        run,
        job,
        dir,
        role,
        epoch,
        packet,
        allowed: new Set(packet.assets?.map((asset) => asset.id) ?? []),
        produced: [],
        controller: controller ?? engine.active.get(run.id).controller,
      }
      const result = await (async () => {
        const base = unwrap(await this.client.config.get({ query: { directory: engine.root } }))
        const prompt = await readFile(path.join(engine.root, ".aether", "agent", `loca-${role}.md`), "utf8")
        const front = Bun.YAML.parse(prompt.match(/^---\n([\s\S]*?)\n---/)[1])
        job.definition = store.put(run, "prompt", `${role}.md`, prompt).id
        context.system = prompt.replace(/^---[\s\S]*?---\s*/, "")
        await mkdir(path.join(dir, ".aether"), { recursive: true })
        await writeFile(
          path.join(dir, ".aether", "aether.json"),
          JSON.stringify({
            model: base.model,
            small_model: base.small_model,
            provider: base.provider,
            enabled_providers: base.enabled_providers,
            disabled_providers: base.disabled_providers,
            plugin: [
              ...(base.plugin ?? []).filter((file) => !file.endsWith("/plugins/loca.js")),
              pathToFileURL(path.join(engine.root, ".aether/plugins/loca.js")).href,
            ],
            agent: { [`loca-${role}`]: { ...front, prompt: context.system } },
            memory: { enabled: false },
            skills: { evolution_enabled: false },
            snapshot: false,
            share: "disabled",
            cron: { enabled: false },
            mcp: Object.fromEntries(Object.keys(base.mcp ?? {}).map((name) => [name, { enabled: false }])),
          }),
          { mode: 0o600 },
        )
        await chmod(path.join(dir, ".aether"), 0o555)
        const effective = unwrap(await this.client.config.get({ query: { directory: dir } }))
        if (effective.memory?.enabled !== false || effective.skills?.evolution_enabled !== false)
          throw new Error("Context isolation config was overridden")
        const parent = unwrap(
          await this.client.session.get({ path: { id: run.session }, query: { directory: engine.root } }),
        )
        const agents = unwrap(await this.client.app.agents({ query: { directory: engine.root } }))
        const permissions = [
          ...(agents.find((agent) => agent.name === "loca")?.permission ?? []),
          ...(parent.permission ?? []),
        ]
        // Aether assigns subdirectories their own project DB. Cross-project parentID
        // is invalid; the durable job.parent relation is the controller's link.
        const child = unwrap(
          await this.client.session.create({
            query: { directory: dir },
            body: {
              title: `LOCA R${run.round} ${role} ${slot}`,
              permission: [
                ...permissions,
                { permission: "read", pattern: "**", action: "allow" },
                { permission: "read", pattern: "*", action: "allow" },
                { permission: "glob", pattern: "**", action: "allow" },
                { permission: "glob", pattern: "*", action: "allow" },
                { permission: "grep", pattern: "**", action: "allow" },
                { permission: "grep", pattern: "*", action: "allow" },
                { permission: "bash", pattern: "*", action: "allow" },
                { permission: "bash", pattern: "**", action: "allow" },
                { permission: "loca_source", pattern: "**", action: "allow" },
                { permission: "loca_source", pattern: "*", action: "allow" },
                { permission: "loca_evidence", pattern: "**", action: "allow" },
                { permission: "edit", pattern: `${engine.root}/loca/results/**`, action: "allow" },
                { permission: "edit", pattern: `${engine.root}/loca/results/*/**`, action: "allow" },
                { permission: "external_directory", pattern: "*", action: "allow" },
                { permission: "external_directory", pattern: "**", action: "allow" },
                { permission: "webfetch", pattern: "*", action: "allow" },
                { permission: "webfetch", pattern: "**", action: "allow" },
              ],
            },
          }),
        )
        job.session = child.id
        engine.children.set(child.id, context)
        store.job(run, job, "running", { directory: dir, prompt: hash(prompt), policy: hash(cfg) })
        timeout = typeof limit === "number" ? AbortSignal.timeout(limit) : null
        const runwide = engine.active.get(run.id).controller.signal
        const signal = timeout
          ? AbortSignal.any([timeout, runwide, ...(controller ? [controller.signal] : [])])
          : controller
            ? AbortSignal.any([runwide, controller.signal])
            : runwide
        const stop = () => {
          void this.client.session.abort({ path: { id: child.id }, query: { directory: dir } }).catch(() => {})
        }
        signal.addEventListener("abort", stop, { once: true })
        context.text = JSON.stringify({ packet, correction: errors.at(-1) ?? null })
        const turns = Math.max(1, Math.min(3, cfg.attempts))
        for (let turn = 1; ; turn++) {
          const aborted = new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  new Error(
                    controller?.signal.aborted && !runwide.aborted
                      ? "LOCA_TASK_ABORTED"
                      : timeout?.aborted && !runwide.aborted
                        ? "Role backstop timeout"
                        : "LOCA_CALL_ABORTED",
                  ),
                ),
              { once: true },
            )
          })
          const began = Date.now()
          let stallReject
          const stalled = new Promise((_, reject) => (stallReject = reject))
          const watchdog = setInterval(() => {
            const idle = Date.now() - Math.max(engine.activity.get(child.id) ?? 0, began)
            const executing = (engine.activity.get(child.id + ":exec") ?? 0) > 0
            const ceiling = executing ? Math.max(cfg.idle ?? 600000, 600000) : (cfg.idle ?? 600000)
            store.event(run, "watchdog", {
              job: job.id,
              role,
              idle: Math.round(idle / 1000),
              limit: Math.round(ceiling / 1000),
              executing,
            })
            if (idle > ceiling) {
              stop()
              stallReject(
                executing
                  ? new Error(
                      `Sandbox execution timeout after ${Math.round(ceiling / 60000)} minutes (killed): likely an infinite loop or an unbounded single run. Rewrite the computation as bounded stages (each well under 5 minutes): add explicit loop bounds/iteration caps, verify small cases first, and print intermediate results between stages.`,
                    )
                  : new Error(`Role stall timeout: no stream activity for ${Math.round(idle / 1000)}s`),
              )
            }
          }, 15000)
          const pending = this.client.session.prompt({
            path: { id: child.id },
            query: { directory: dir },
            body: {
              agent: `loca-${role}`,
              ...(!front.model && run.model ? { model: run.model } : {}),
              parts: [{ type: "text", text: context.text }],
              format: { type: "json_schema", schema: z.toJSONSchema(schema(role)), retryCount: 0 },
            },
          })
          pending.catch(() => {})
          const response = await Promise.race([pending, aborted, stalled]).finally(() => {
            clearInterval(watchdog)
          })
          signal.throwIfAborted()
          engine.guard(run, epoch)
          store.job(run, job, "checking")
          const data = unwrap(response)
          const correction = (text) => {
            if (turn >= turns) throw new Error(text)
            context.text = JSON.stringify({
              correction: text,
              instruction:
                "Your previous StructuredOutput was rejected. Fix ONLY the reported problems and call StructuredOutput again with the complete corrected object. Do not redo finished work.",
            })
            store.job(run, job, "correcting", { turn, error: text })
            return null
          }
          if (data.info?.structured === undefined) {
            if (
              correction(
                "Structured output missing: you MUST finish this task by calling the StructuredOutput tool with an object matching the provided schema. Never end with plain text, and keep enough steps in reserve for that final call.",
              ) === null
            )
              continue
          }
          const raw = data.info?.structured
          let value
          try {
            value = schema(role).parse(raw)
          } catch (error) {
            if (error?.issues) {
              const lines = error.issues.map(
                (issue) =>
                  `Field "${issue.path.join(".")}" ${issue.code === "invalid_type" ? `must be ${issue.expected} (got ${typeof issue.input})` : `fails ${issue.code}`}: ${issue.message}`,
              )
              if (
                correction(
                  `StructuredOutput rejected by schema (${lines.length} field problems): ${lines.join("; ")}. Fix these fields and resubmit with StructuredOutput.`,
                ) === null
              )
                continue
            }
            throw error
          }
          const ids = [...new Set([...context.allowed, ...context.produced, ...run.assets])]
          const records = ids.map((id) => {
            try {
              return engine.store.asset(id)
            } catch {
              return null
            }
          })
          const registered = records.filter(Boolean)
          const nameIndex = byName(registered)
          const repair = (ref) => {
            if (ids.includes(ref)) return ref
            if (typeof ref === "string" && !ref.includes(":")) {
              const group = nameIndex.get(ref) ?? nameIndex.get(ref.trim())
              if (group?.length === 1) return group[0].id
            }
            const match = closest(ref, registered, nameIndex)
            if (match && match.id.startsWith(ref.slice(0, ref.indexOf(":") + 1))) return match.id
            return ref
          }
          const REF_KEYS = new Set(["evidence", "artifacts", "artifact"])
          const heal = (x, key = null) => {
            if (typeof x === "string") return REF_KEYS.has(key) ? repair(x) : x
            if (Array.isArray(x)) return key && REF_KEYS.has(key) ? x.map(repair) : x.map((item) => heal(item))
            if (x && typeof x === "object")
              return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, heal(v, k)]))
            return x
          }
          const value2 = heal(value)
          if (JSON.stringify(value2) !== JSON.stringify(value))
            store.event(run, "id_repair", {
              job: job.id,
              role,
              note: "near-miss asset ids auto-corrected to unique nearest matches",
            })
          try {
            references(value2, new Set(ids), registered, nameIndex)
            await check(value2, context)
          } catch (error) {
            if (correction(`${String(error)} Fix the reported problems and resubmit with StructuredOutput.`) === null)
              continue
            throw error
          }
          const record = store.put(run, "report", `${role}-${job.id}.json`, JSON.stringify(value2), {
            job: job.id,
            packet: job.packet,
          })
          store.job(run, job, "accepted", { report: record.id, verdict: value2.verdict ?? value2.status ?? null })
          if (value2.assumptions?.length) engine.assume(run, job, value2.assumptions)
          return { value: value2, record, job, produced: context.produced }
        }
      })()
        .catch((error) => {
          const current = store.byId(run.id)
          if (current.phase === "cancelled") {
            store.job(run, job, "cancelled", { error: String(error) })
            throw error
          }
          if (current.epoch !== epoch) {
            store.job(run, job, "stale", { error: String(error) })
            throw error
          }
          if (String(error).includes("LOCA_TASK_ABORTED")) {
            store.job(run, job, "cancelled", { error: String(error) })
            throw error
          }
          // 任务级 controller 引入后，runwide 中止不再反映在 context.controller 上：
          // 两者任一中止都应归类为 cancelled（而不是 error）
          if (context.controller.signal.aborted || engine.active.get(run.id)?.controller.signal.aborted) {
            store.job(run, job, "cancelled", { error: String(error) })
            throw error
          }
          if (timeout?.aborted || /timeout|timed out/i.test(String(error))) {
            store.job(run, job, "timeout", { error: String(error) })
            errors.push(String(error))
            store.job(run, job, attempt < cfg.attempts ? "retrying" : "exhausted")
            return null
          }
          if (job.status !== "checking" && job.status !== "correcting") {
            store.job(run, job, "error", { error: String(error) })
            throw error
          }
          store.job(run, job, "rejected", { error: String(error) })
          errors.push(String(error))
          store.job(run, job, attempt < cfg.attempts ? "retrying" : "exhausted")
          return null
        })
        .finally(async () => {
          if (job.session) {
            engine.children.delete(job.session)
            engine.activity.delete(job.session)
          }
          await Promise.race([
            this.client.instance
              ?.dispose({ query: { directory: dir } })
              .catch((error) => store.event(run, "cleanup_error", { job: job.id, error: String(error) })),
            new Promise((resolve) => setTimeout(resolve, 10_000)),
          ])
        })
      if (result) return result
    }
    throw new Error(`Role ${role} exhausted protocol retries: ${errors.join("; ")}`)
  }
}
