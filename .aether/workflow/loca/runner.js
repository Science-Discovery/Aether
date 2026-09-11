import { randomUUID } from "node:crypto"
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { schema, references } from "./schema.js"
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
    throw new AggregateError(failures, "One or more required jobs failed; no panel slots were dropped")
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

  async call(run, role, packet, check = () => {}, slot = "") {
    const engine = this.engine
    const store = engine.store
    const cfg = engine.cfg
    const epoch = run.epoch
    const frozen = JSON.stringify(packet)
    if (Buffer.byteLength(frozen) > cfg.packet)
      throw new Error("Context packet exceeds limit; split into smaller blocks (no silent truncation)")
    const errors = []
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
        controller: engine.active.get(run.session).controller,
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
        // All dependencies resolve beside the plugin entry. A frozen config directory also
        // prevents Aether from running a redundant package install for every role attempt.
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
        // Aether assigns subdirectories their own project DB. Cross-project parentID is invalid;
        // the durable job.parent relation is the controller's explicit child-session link.
        const child = unwrap(
          await this.client.session.create({
            query: { directory: dir },
            body: { title: `LOCA R${run.round} ${role} ${slot}`, permission: permissions },
          }),
        )
        job.session = child.id
        engine.children.set(child.id, context)
        store.job(run, job, "running", { directory: dir, prompt: hash(prompt), policy: hash(cfg) })
        const timeout = AbortSignal.timeout(cfg.timeout)
        const signal = AbortSignal.any([timeout, context.controller.signal])
        const stop = () => {
          void this.client.session.abort({ path: { id: child.id }, query: { directory: dir } }).catch(() => {})
        }
        signal.addEventListener("abort", stop, { once: true })
        context.text = JSON.stringify({ packet, correction: errors.at(-1) ?? null })
        const response = await this.client.session
          .prompt({
            path: { id: child.id },
            query: { directory: dir },
            signal,
            body: {
              agent: `loca-${role}`,
              ...(!front.model && run.model ? { model: run.model } : {}),
              parts: [{ type: "text", text: context.text }],
              format: { type: "json_schema", schema: z.toJSONSchema(schema(role)), retryCount: 0 },
            },
          })
          .finally(() => signal.removeEventListener("abort", stop))
        signal.throwIfAborted()
        engine.guard(run, epoch)
        store.job(run, job, "checking")
        const data = unwrap(response)
        const value = schema(role).parse(data.info?.structured)
        references(value, new Set([...context.allowed, ...context.produced]))
        await check(value, context)
        const record = store.put(run, "report", `${role}-${job.id}.json`, JSON.stringify(value), {
          job: job.id,
          packet: job.packet,
        })
        store.job(run, job, "accepted", { report: record.id, verdict: value.verdict ?? value.status ?? null })
        return { value, record, job, produced: context.produced }
      })()
        .catch((error) => {
          const current = store.run(run.session)
          if (current.phase === "cancelled") {
            store.job(run, job, "cancelled", { error: String(error) })
            throw error
          }
          if (current.epoch !== epoch) {
            store.job(run, job, "stale", { error: String(error) })
            throw error
          }
          if (context.controller.signal.aborted) {
            store.job(run, job, "cancelled", { error: String(error) })
            throw error
          }
          if (job.status !== "checking") {
            store.job(run, job, "error", { error: String(error) })
            throw error
          }
          // Malformed execution is retryable; a well-formed business FAIL returns above without retry.
          store.job(run, job, "rejected", { error: String(error) })
          errors.push(String(error))
          store.job(run, job, attempt < cfg.attempts ? "retrying" : "exhausted")
          return null
        })
        .finally(async () => {
          if (job.session) engine.children.delete(job.session)
          await this.client.instance
            ?.dispose({ query: { directory: dir } })
            .catch((error) => store.event(run, "cleanup_error", { job: job.id, error: String(error) }))
        })
      if (result) return result
    }
    throw new Error(`Role ${role} exhausted protocol retries: ${errors.join("; ")}`)
  }
}
