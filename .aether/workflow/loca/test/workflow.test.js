import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, symlink, rm, writeFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Engine } from "../engine.js"
import { aggregate, graph, solved } from "../graph.js"
import { review, references } from "../schema.js"
import { Store } from "../store.js"
import { parallel } from "../runner.js"

const cfg = await Bun.file(new URL("../workflow.json", import.meta.url)).json()
const cleanups = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loca-test-"))
  await mkdir(path.join(dir, ".aether"))
  await symlink(path.resolve(import.meta.dir, "../../../agent"), path.join(dir, ".aether/agent"))
  const sessions = []
  const count = { value: 0, live: 0, max: 0 }
  // Scripted API boundary: real Runner, store, validators, scheduling and artifacts execute.
  // It is intentionally not an evaluation of a model's scientific judgement.
  const client = {
    config: { get: async () => ({ data: { memory: { enabled: false }, skills: { evolution_enabled: false } } }) },
    app: {
      agents: async () => ({
        data: [{ name: "loca", permission: [{ permission: "read", pattern: "secret", action: "deny" }] }],
      }),
    },
    session: {
      get: async () => ({ data: { permission: [{ permission: "bash", pattern: "*", action: "ask" }] } }),
      create: async (args) => {
        const id = `child-${++count.value}`
        sessions.push({ id, ...args })
        return { data: { id } }
      },
      abort: async () => ({ data: true }),
      prompt: async (args) => {
        count.live++
        count.max = Math.max(count.max, count.live)
        await Bun.sleep(1)
        const context = engine.children.get(args.path.id)
        await options.before?.(context)
        const packet = JSON.parse(args.body.parts[0].text).packet
        const evidence = packet.assets[0]?.id
        const proof = [evidence]
        const checks =
          cfg.checks[context.role === "fidelity" ? "contract" : context.role === "closing" ? "reasoning" : context.role]
        const report = () => ({
          verdict: "pass",
          checks: checks.map((id) => ({
            id,
            status: "pass",
            reason: "Checked the immutable test fixture",
            evidence: proof,
          })),
          findings: [],
        })
        const output = (() => {
          if (context.role === "contract")
            return {
              goal: "Write an arithmetic result",
              criteria: [
                { id: "C1", text: "Give four", method: "Inspect the result", origin: "four" },
                ...(packet.history.length > 1
                  ? [{ id: "C2", text: "Explain", method: "Inspect explanation", origin: "explain" }]
                  : []),
              ],
              removed: [],
              questions: [],
            }
          if (context.role === "solve") {
            const artifact = engine.register(
              context,
              "artifact",
              "answer.txt",
              "2 + 2 = 4. Adding two pairs gives four.",
            )
            return {
              status: "completed",
              artifacts: [artifact.id],
              claims: [
                {
                  id: "K1",
                  text: "Two plus two is four",
                  artifact: artifact.id,
                  criteria: packet.contract.criteria.map((item) => item.id),
                  conditions: ["integer arithmetic"],
                },
              ],
              criteria: packet.contract.criteria.map((item) => ({
                id: item.id,
                reason: "Result written",
                evidence: [artifact.id],
              })),
              problems: [],
              reason: "All known work completed",
            }
          }
          if (context.role === "split") {
            const artifact = packet.candidate.artifacts[0]
            const criteria = packet.contract.criteria.map((item) => item.id)
            return {
              nodes: [
                {
                  id: "N1",
                  type: "reasoning",
                  purpose: "production",
                  objective: "Add",
                  criteria,
                  claims: ["K1"],
                  material: [
                    {
                      asset: artifact,
                      start: 0,
                      end: packet.assets.find((item) => item.id === artifact).content.length,
                    },
                  ],
                  inputs: [{ from: evidence, port: "asset", use: "user task", conditions: [] }],
                  outputs: [{ port: "answer", claim: "4", conditions: [] }],
                  method: "Count",
                },
                {
                  id: "V1",
                  type: "reasoning",
                  purpose: "acceptance",
                  objective: "Check the actual answer",
                  criteria,
                  claims: [],
                  material: [
                    {
                      asset: artifact,
                      start: 0,
                      end: packet.assets.find((item) => item.id === artifact).content.length,
                    },
                  ],
                  inputs: [{ from: "N1", port: "answer", use: "Verify answer", conditions: [] }],
                  outputs: [{ port: "verdict", claim: "Meets criteria", conditions: [] }],
                  method: "Independent counting",
                },
              ],
            }
          }
          if (context.role === "validate")
            return {
              verdict: "pass",
              criteria: packet.node.criteria.map((id) => ({ id, reason: "Inspected actual text", evidence: proof })),
              evidence: proof,
              findings: [],
            }
          if (context.role === "questioner")
            return {
              questions: [
                { id: `Q${packet.turn}`, target: packet.node.id, question: "What is addition?", evidence: proof },
              ],
            }
          if (context.role === "defender")
            return {
              answers: packet.questions.map((item) => ({
                id: item.id,
                status: options.concede ? "conceded" : "defended",
                answer: "Disjoint finite cardinality",
                evidence: proof,
              })),
            }
          if (context.role === "closing")
            return {
              ...report(),
              answers: packet.transcript.flatMap((item) =>
                item.questions.map((question) => ({
                  id: question.id,
                  status: "resolved",
                  reason: "Definition is explicit",
                  evidence: proof,
                })),
              ),
            }
          if (context.role === "integrate")
            return {
              ...report(),
              summary: "The arithmetic result is ready.",
              criteria: packet.contract.criteria.map((item) => ({
                id: item.id,
                artifacts: packet.candidate.artifacts,
                nodes: ["V1"],
                evidence: proof,
                scope: "this example",
                review: "Inspect answer.txt",
              })),
            }
          if (options.fail && context.role === "reasoning" && context.job.slot === "0")
            return {
              ...report(),
              verdict: "fail",
              checks: report().checks.map((item, index) => (index ? item : { ...item, status: "fail" })),
              findings: [
                {
                  id: "F1",
                  target: "N1",
                  detail: "Fixture counterexample",
                  evidence: proof,
                  repair: "solve",
                  blocking: true,
                },
              ],
            }
          return report()
        })()
        count.live--
        return { data: { info: { structured: output }, parts: [] } }
      },
    },
  }
  const engine = new Engine(dir, { ...cfg, questions: 1, cycles: 1, ...options.cfg }, client)
  cleanups.push(async () => {
    await Promise.all(
      engine.store
        .jobs(engine.store.run("parent") ?? { id: "none" })
        .filter((job) => job.directory)
        .map((job) => chmod(path.join(job.directory, ".aether"), 0o755)),
    )
    engine.store.db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { engine, sessions, count, dir, client }
}

test("complete workflow uses distinct sessions, bounded panels and independent acceptance", async () => {
  const { engine, sessions, count } = await fixture()
  engine.capture("parent", { id: "human-1", parts: [{ type: "text", text: "Give four" }] })
  const result = await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  expect(result).toContain("等待你验收")
  expect(run.phase).toBe("awaiting_human")
  expect(new Set(sessions.map((item) => item.id)).size).toBe(sessions.length)
  expect(count.max).toBeGreaterThan(1)
  expect(count.max).toBeLessThanOrEqual(cfg.concurrency)
  expect(engine.store.jobs(run).filter((job) => job.role === "reasoning")).toHaveLength(6)
  expect(engine.store.jobs(run).filter((job) => job.role === "closing")).toHaveLength(6)
  expect(
    sessions.every((item) => !item.body.parentID && item.body.permission.some((rule) => rule.action === "deny")),
  ).toBe(true)
  expect(engine.store.jobs(run).every((job) => job.parent === "parent")).toBe(true)
  expect(run.validations.V1.verdict).toBe("pass")
  expect(run.nodes.V1.effective).toBe("pass")
  expect(run.phase).not.toBe("accepted")
})

test("human feedback adds a round, retains old criteria, invalidates old approvals", async () => {
  const { engine } = await fixture()
  engine.capture("parent", { id: "h1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const old = engine.store.run("parent").epoch
  engine.capture("parent", { id: "h2", parts: [{ type: "text", text: "Also explain" }] })
  expect(() => engine.guard({ session: "parent", epoch: old })).toThrow("STALE")
  await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  expect(run.phase).toBe("awaiting_human")
  expect(run.round).toBe(2)
  expect(run.contract.criteria.map((item) => item.id)).toEqual(["C1", "C2"])
  expect(engine.store.jobs(run).some((job) => job.round === 1)).toBe(true)
  engine.commands.set("parent", { action: "accept" })
  engine.capture("parent", { id: "h3", parts: [] })
  await engine.act("parent", { abort: new AbortController().signal })
  expect(engine.store.run("parent").phase).toBe("accepted")
})

test("a well-formed reviewer FAIL is execution accepted, never retried into PASS", async () => {
  const { engine } = await fixture({ fail: true })
  engine.capture("parent", { id: "h1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  const jobs = engine.store.jobs(run).filter((job) => job.role === "reasoning" && job.slot === "0")
  expect(jobs).toHaveLength(2)
  expect(jobs.every((job) => job.status === "accepted" && job.verdict === "fail")).toBe(true)
  expect(run.phase).toBe("unfinished")
  expect(run.delivery).toBeNull()
})

test("a defender concession cannot be papered over by closing reviewers", async () => {
  const { engine } = await fixture({ concede: true })
  engine.capture("parent", { id: "h1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  expect(run.phase).toBe("unfinished")
  expect(engine.store.jobs(run).some((job) => job.role === "closing" && job.status === "exhausted")).toBe(true)
})

test("unknown evidence and incomplete checklists fail protocol validation", () => {
  expect(() => references({ checks: [{ evidence: ["invented"] }] }, new Set(["real"]))).toThrow("Unregistered")
  expect(() =>
    review(
      { verdict: "pass", checks: [{ id: "one", status: "pass", reason: "reason", evidence: ["real"] }], findings: [] },
      ["one", "two"],
    ),
  ).toThrow("missing")
})

test("late output after new human input is stale and cannot advance the round", async () => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { engine } = await fixture({
    before: async () => {
      started.resolve()
      await release.promise
    },
  })
  engine.capture("parent", { id: "h1", parts: [{ type: "text", text: "Give four" }] })
  const pending = engine.act("parent", { abort: new AbortController().signal })
  await started.promise
  engine.capture("parent", { id: "h2", parts: [{ type: "text", text: "Also explain" }] })
  release.resolve()
  await pending
  const run = engine.store.run("parent")
  expect(run.pending.map((item) => item.message)).toEqual(["h2"])
  expect(engine.store.jobs(run).map((job) => job.status)).toEqual(["stale"])
  expect(run.delivery).toBeNull()
})

test("cancel command immediately invalidates active work and preserves its ledger", async () => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { engine } = await fixture({
    before: async () => {
      started.resolve()
      await release.promise
    },
  })
  engine.capture("parent", { id: "h1", parts: [{ type: "text", text: "Give four" }] })
  const pending = engine.act("parent", { abort: new AbortController().signal })
  await started.promise
  engine.commands.set("parent", { action: "cancel" })
  engine.capture("parent", { id: "h2", parts: [] })
  expect(engine.store.run("parent").phase).toBe("cancelled")
  release.resolve()
  await pending
  expect(engine.store.jobs(engine.store.run("parent"))[0].status).toBe("cancelled")
})

test("an artifact tail outside the production DAG cannot escape review", () => {
  const node = {
    id: "a",
    type: "reasoning",
    purpose: "production",
    objective: "x",
    criteria: [],
    claims: ["k"],
    material: [{ asset: "asset", start: 0, end: 1 }],
    inputs: [],
    outputs: [{ port: "out", claim: "x", conditions: [] }],
    method: "m",
  }
  expect(() =>
    graph(
      { nodes: [node] },
      { criteria: [] },
      { claims: [{ id: "k" }], artifacts: ["asset"] },
      new Map([["asset", { content: "x hidden claim" }]]),
    ),
  ).toThrow("Uncovered artifact")
})

test("known work cannot be dropped or mislabeled as a completed candidate", () => {
  const candidate = {
    status: "completed",
    artifacts: ["a"],
    claims: [{ id: "k", text: "claim", artifact: "a", criteria: ["C1"], conditions: [] }],
    criteria: [{ id: "C1", reason: "ok", evidence: ["a"] }],
    problems: [{ id: "P1", detail: "Not solved", status: "open", evidence: [] }],
    reason: "done",
  }
  expect(() => solved(candidate, { criteria: [{ id: "C1" }] }, new Map([["a", { kind: "artifact" }]]))).toThrow(
    "unresolved",
  )
  expect(() => solved({ ...candidate, status: "working", problems: [] }, {}, new Map(), candidate)).toThrow(
    "silently removed",
  )
})

test("missing reviewers and failed ancestors block effective downstream approval", () => {
  const nodes = [
    { id: "a", purpose: "production", inputs: [] },
    { id: "b", purpose: "acceptance", inputs: [{ from: "a" }] },
  ]
  const pass = { verdict: "pass", findings: [] }
  const result = aggregate(nodes, { a: [pass, pass], b: [pass, pass, pass] }, 3, { b: { verdict: "pass" } })
  expect(result.a.local).toBe("fail")
  expect(result.b.local).toBe("pass")
  expect(result.b.effective).toBe("blocked")
})

test("DAG rejects cycles, missing conditions ports and missing criterion validation", () => {
  const node = {
    id: "a",
    type: "reasoning",
    purpose: "production",
    objective: "x",
    criteria: [],
    claims: ["k"],
    material: [{ asset: "asset", start: 0, end: 1 }],
    inputs: [],
    outputs: [{ port: "out", claim: "x", conditions: [] }],
    method: "m",
  }
  const candidate = { claims: [{ id: "k" }], artifacts: ["asset"] }
  expect(() =>
    graph({ nodes: [node] }, { criteria: [{ id: "C1" }] }, candidate, new Map([["asset", { content: "x" }]])),
  ).toThrow("No acceptance")
  expect(() =>
    graph(
      { nodes: [{ ...node, inputs: [{ from: "a", port: "out", use: "x", conditions: [] }] }] },
      { criteria: [] },
      candidate,
      new Map([["asset", { content: "x" }]]),
    ),
  ).toThrow("cycle")
  expect(() =>
    graph(
      { nodes: [{ ...node, inputs: [{ from: "missing", port: "out", use: "x", conditions: [] }] }] },
      { criteria: [] },
      candidate,
      new Map([["asset", { content: "x" }]]),
    ),
  ).toThrow("Missing input")
})

test("supervisor transition guard, immutable evidence and persistence survive reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "loca-store-"))
  const store = new Store(dir)
  const run = store.create("s")
  const asset = store.put(run, "artifact", "a", "original")
  const job = { id: "job" }
  expect(() => store.job(run, job, "accepted")).toThrow("queued")
  store.job(run, job, "queued")
  expect(() => store.job(run, job, "accepted")).toThrow("Illegal")
  expect(() => store.move(run, "awaiting_human")).toThrow("Illegal")
  store.db.close()
  const reopened = new Store(dir)
  expect(reopened.run("s").id).toBe(run.id)
  expect(reopened.asset(asset.id).content).toBe("original")
  await writeFile(path.join(dir, "blobs", asset.hash), "modified")
  expect(() => reopened.asset(asset.id)).toThrow("changed")
  reopened.db.close()
  await rm(dir, { recursive: true, force: true })
})

test("parallel queue does not drop remaining slots after a failure", async () => {
  const seen = []
  await expect(
    parallel([1, 2, 3, 4], 2, async (item) => {
      seen.push(item)
      if (item === 1) throw new Error("failure")
      return item
    }),
  ).rejects.toThrow("required jobs failed")
  expect(seen.sort()).toEqual([1, 2, 3, 4])
})

test("prototype-shaped node IDs remain visible to the effective-result gate", () => {
  const nodes = ["__proto__", "constructor", "ok"].map((id) => ({ id, purpose: "production", inputs: [] }))
  const pass = { verdict: "pass", findings: [] }
  const fail = { verdict: "fail", findings: [{ blocking: true }] }
  const reports = Object.fromEntries(nodes.map((node) => [node.id, Array(3).fill(node.id === "ok" ? pass : fail)]))
  const result = aggregate(nodes, reports, 3, {})
  expect(Object.keys(result)).toEqual(["__proto__", "constructor", "ok"])
  expect(Object.values(result).filter((node) => node.effective === "blocked")).toHaveLength(2)
  expect(JSON.parse(JSON.stringify(result))["__proto__"].effective).toBe("blocked")
})

test("a failed audit export cannot publish a delivery summary", async () => {
  const { engine, dir } = await fixture()
  const run = engine.store.create("parent")
  const artifact = engine.store.put(run, "artifact", "answer.txt", "4")
  run.candidate = { artifacts: [artifact.id] }
  run.contract = { criteria: [{ id: "C1", text: "Give four" }] }
  const result = {
    record: { id: "report:fixture", hash: "fixture" },
    value: {
      summary: "Result is four",
      criteria: [{ id: "C1", artifacts: [artifact.id], nodes: ["V1"], scope: "this example", review: "Check answer" }],
    },
  }
  const output = path.join(dir, ".aether/workflow/loca/results", run.id, "round-0/cycle-0-fixture")
  await mkdir(path.join(output, "audit.json"), { recursive: true })
  await expect(engine.deliver(run, result)).rejects.toThrow()
  expect(run.delivery).toBeUndefined()
  expect(run.summary).toBeUndefined()
  expect(engine.store.run("parent").delivery).toBeUndefined()
})
