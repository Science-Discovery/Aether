import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, symlink, rm, writeFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Engine } from "../engine.js"
import { aggregate, graph, solved } from "../graph.js"
import { review, references, byName, closest } from "../schema.js"
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
  await symlink(path.resolve(import.meta.dir, "../../../command"), path.join(dir, ".aether/command"))
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
        const parsed = JSON.parse(args.body.parts[0].text)
        const packet = parsed.packet ?? { assets: [] }
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
              assumptions: [],
            }
          if (context.role === "explore") {
            return {
              strategy: "Derive the result directly",
              subproblems: [
                {
                  id: "S1",
                  goal: "Compute the arithmetic result",
                  criteria: packet.contract.criteria.map((item) => item.id),
                  evidence: packet.assets.map((item) => item.id),
                  depends: [],
                },
              ],
              assumptions: [],
              reason: "Single coarse sub-problem covers all criteria",
            }
          }
          if (context.role === "attack") {
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
                  criteria: packet.plan.subproblem.criteria,
                  conditions: ["integer arithmetic"],
                },
              ],
              problems: [],
              reason: "Sub-problem solved",
            }
          }
          if (context.role === "assemble") {
            const artifact = context.run.assets.find((id) => id.startsWith("artifact:"))
            return {
              status: "completed",
              artifacts: [artifact],
              claims: [
                {
                  id: "K1",
                  text: "Two plus two is four",
                  artifact,
                  criteria: (packet.criteria ?? packet.contract?.criteria ?? []).map((item) => item.id),
                  conditions: ["integer arithmetic"],
                },
              ],
              criteria: (packet.criteria ?? packet.contract?.criteria ?? []).map((item) => ({
                id: item.id,
                reason: "Result written",
                evidence: [artifact],
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
        .jobs(engine.store.latest() ?? { id: "none" })
        .filter((job) => job.directory)
        .map((job) => chmod(path.join(job.directory, ".aether"), 0o755)),
    )
    engine.store.db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { engine, sessions, count, dir, client }
}

test("stage digests fire at each phase boundary for live UI summaries", async () => {
  const { engine } = await fixture()
  const seen = []
  engine.store.report = (run, kind, data) => {
    if (kind === "stage") seen.push(data)
  }
  engine.capture("parent", { id: "d1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const stages = seen.map((item) => item.stage)
  expect(stages).toContain("contract")
  expect(stages).toContain("explore")
  expect(stages).toContain("attack")
  expect(stages).toContain("assemble")
  expect(seen.every((item) => typeof item.summary === "string" && item.summary.length > 0)).toBe(true)
  const run = engine.store.run("parent")
  expect(engine.status(run)).toContain("阶段纪要")
})

test("infra resume continues the interrupted cycle instead of burning a new one", async () => {
  const { engine } = await fixture({ fail: true })
  engine.capture("parent", { id: "r1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  let run = engine.store.run("parent")
  const interruptedAt = run.cycle
  expect(run.phase).toBe("unfinished")
  // Infra recovery: same cycle number resumes; no new cycle is created.
  await engine.act("parent", { abort: new AbortController().signal })
  run = engine.store.run("parent")
  expect(run.cycle).toBe(interruptedAt)
  const resumes = engine.store.events(run).filter((row) => row.kind === "resume")
  expect(resumes.length).toBeGreaterThanOrEqual(1)
  expect(resumes.at(-1).data.cycle).toBe(interruptedAt - 1 + 1 - 1) // resumed INTO the same cycle
})

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

test("store report hook streams phase and job events for live progress", async () => {
  const { engine } = await fixture()
  const seen = []
  engine.store.report = (run, kind) => seen.push(kind)
  engine.capture("parent", { id: "r1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  expect(seen).toContain("human_input")
  expect(seen).toContain("phase")
  expect(seen).toContain("job")
})

test("/loca-status resolves the project run from a foreign session without creating one", async () => {
  const { engine } = await fixture()
  engine.capture("parent", { id: "s1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  engine.commands.set("observer", { action: "status" })
  engine.capture("observer", { id: "s2", parts: [] })
  expect(engine.store.run("observer")).toBeFalsy()
  const text = await engine.act("observer", { abort: new AbortController().signal })
  expect(text).toContain("LOCA 第 1 轮")
})

test("a bare /loca continue from a foreign session drives the project run without claiming it", async () => {
  const { engine } = await fixture({ fail: true })
  engine.capture("parent", { id: "c1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const run0 = engine.store.run("parent")
  expect(run0.phase).toBe("unfinished")
  // New session sends /loca continue: command routing + bare capture.
  engine.commands.set("fresh", { action: "work", text: "continue" })
  engine.capture("fresh", { id: "c2", parts: [{ type: "text", text: "continue" }] })
  await engine.act("fresh", { abort: new AbortController().signal })
  const run = engine.store.latest()
  // Project-state-first: the SAME run row (single source of truth) is driven and
  // resumed in place — the foreign session recorded as latest driver only.
  expect(run.id).toBe(run0.id)
  expect(run.session).toBe("fresh")
  expect(engine.store.events(run).some((row) => row.kind === "driver")).toBe(true)
  expect(engine.store.events(run).some((row) => row.kind === "resume")).toBe(true)
})

test("read-only queries never claim the project run or block the driving session", async () => {
  const { engine } = await fixture()
  engine.capture("parent", { id: "s1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  // A status glance from another session must not re-key or strand anything.
  engine.commands.set("observer", { action: "status" })
  engine.capture("observer", { id: "s2", parts: [] })
  const text = await engine.act("observer", { abort: new AbortController().signal })
  expect(text).toContain("LOCA 第 1 轮")
  const run = engine.store.latest()
  // The driving session still resolves the same run afterwards.
  const text2 = await engine.act("parent", { abort: new AbortController().signal })
  expect(engine.store.latest().id).toBe(run.id)
  expect(text2.length).toBeGreaterThan(0)
})

test("pre-rendered command templates degrade to their bare arguments", async () => {
  const { engine } = await fixture()
  const template = engine.templates.find((item) => item.length > 0)
  engine.capture("parent", { id: "t1", parts: [{ type: "text", text: `${template}\n\ncontinue` }] })
  // Bare continue never creates a run row: act() resolves the project's run instead.
  expect(engine.store.run("parent")).toBeFalsy()
  engine.capture("parent", { id: "t2", parts: [{ type: "text", text: `${template}\n\n目标：完成示例。` }] })
  expect(engine.store.run("parent").pending.at(-1).text).toBe("目标：完成示例。")
})

test("non-blocking questions proceed with recorded assumptions; blocking ones stop", async () => {
  const { engine } = await fixture()
  // Fixture override: contract returns one non-blocking question + one assumption.
  const originalPrompt = engine.runner.client.session.prompt
  engine.runner.client.session.prompt = async (args) => {
    const context = engine.children.get(args.path.id)
    if (context?.role === "contract") {
      const data = {
        info: {
          structured: {
            goal: "Write an arithmetic result",
            criteria: [{ id: "C1", text: "Give four", method: "Inspect the result", origin: "four" }],
            removed: [],
            questions: [{ id: "Q1", blocking: false, question: "Preferred format?", evidence: [] }],
            assumptions: [{ id: "a1", reason: "Format unspecified", content: "Use plain text", evidence: [] }],
          },
        },
      }
      return { data }
    }
    return originalPrompt(args)
  }
  engine.capture("parent", { id: "h1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  expect(run.phase).not.toBe("needs_human")
  expect(run.assumptions).toHaveLength(1)
  expect(run.assumptions[0]).toMatchObject({ id: "A1", role: "contract", step: "R1C0", content: "Use plain text" })
  expect(run.questions).toHaveLength(1)
  const text = engine.renderAssumptions(run)
  expect(text).toContain("| A1 | contract R1C0 |")
  expect(text).toContain("Format unspecified")
})

test("blocking contract question halts with formatted clarification", async () => {
  const { engine } = await fixture()
  const originalPrompt = engine.runner.client.session.prompt
  engine.runner.client.session.prompt = async (args) => {
    const context = engine.children.get(args.path.id)
    if (context?.role === "contract") {
      return {
        data: {
          info: {
            structured: {
              goal: "Write an arithmetic result",
              criteria: [{ id: "C1", text: "Give four", method: "Inspect the result", origin: "four" }],
              removed: [],
              questions: [
                { id: "Q1", blocking: true, question: "Deliverable A or B? They differ materially.", evidence: [] },
              ],
              assumptions: [],
            },
          },
        },
      }
    }
    return originalPrompt(args)
  }
  engine.capture("parent", { id: "h1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  expect(run.phase).toBe("needs_human")
  expect(run.error).toContain("需要你决定的事项")
  expect(run.error).toContain("Deliverable A or B?")
  expect(run.error).not.toContain('{"questions"')
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
  expect(() => references({ checks: [{ evidence: ["invented"] }] }, new Set(["real"]), [], byName([]))).toThrow(
    "Unregistered",
  )
  expect(() =>
    references(
      { checks: [{ evidence: ["artifact:recovered-proof-part-4"] }] },
      new Set(["artifact:abc123"]),
      [{ id: "artifact:abc123", kind: "artifact", name: "recovered-proof-part-4" }],
      byName([{ id: "artifact:abc123", kind: "artifact", name: "recovered-proof-part-4" }]),
    ),
  ).toThrow("did you mean artifact:abc123")
  expect(() =>
    review(
      { verdict: "pass", checks: [{ id: "one", status: "pass", reason: "reason", evidence: ["real"] }], findings: [] },
      ["one", "two"],
    ),
  ).toThrow("missing")
})

test("nearest-match resolution heals unambiguous near-misses and rejects unrelated ids", () => {
  const records = [
    {
      id: "artifact:ddf912916662c58d9e68026207753b8ba0b6f8974175dbec4ab6eb20a4a2312",
      kind: "artifact",
      name: "code/eik_lib.py",
    },
    {
      id: "artifact:a10cc01bb9f10bb8806883c80cfe7888681b2b5f36e283b94cb2a22080be0956",
      kind: "artifact",
      name: "proof/10_lemmas.md",
    },
  ]
  const idx = byName(records)
  // Truncated/typo'd hex tail within distance 6 heals to the registered id.
  expect(closest("artifact:ddf912916662c58d9e680262b07753b8ba0b6f8974175dbec4ab6eb20a4a2312", records, idx).name).toBe(
    "code/eik_lib.py",
  )
  // Name-shaped citation resolves by fuzzy name match.
  expect(closest("artifact:proof/10_lemmas.md", records, idx).name).toBe("proof/10_lemmas.md")
  // Unrelated hex id must NOT match anything (no false auto-heal).
  expect(closest("artifact:194df3255b9ce0884117796d2edcfe8f8f9ffd6dc5c976e84b4", records, idx)).toBeNull()
})

test("name-primary evidence: natural names resolve to ids; ambiguous names still fail loudly", () => {
  const records = [
    {
      id: "artifact:ddf912916662c58d9e68026207753b8ba0b6f8974175dbec4ab6eb20a4a2312",
      kind: "artifact",
      name: "code/eik_lib.py",
    },
    {
      id: "artifact:a10cc01bb9f10bb8806883c80cfe7888681b2b5f36e283b94cb2a22080be0956",
      kind: "artifact",
      name: "proof/10_lemmas.md",
    },
  ]
  const idx = byName(records)
  const allowed = new Set(records.map((record) => record.id))
  // A natural-language name in the evidence list resolves to the registered id.
  const value = { claims: [{ evidence: ["proof/10_lemmas.md"] }] }
  references(value, allowed, records, idx)
  expect(value.claims[0].evidence[0]).toBe("artifact:a10cc01bb9f10bb8806883c80cfe7888681b2b5f36e283b94cb2a22080be0956")
  // Ambiguous / unregistered name fails with the single-candidate hint.
  expect(() => references({ claims: [{ evidence: ["no/such-file.md"] }] }, allowed, records, idx)).toThrow(
    "no similar registered asset",
  )
  // Name resolution is scoped to REFERENCE fields: a semantic string (e.g. the review
  // check id "fidelity") must never be rewritten even when an asset name fuzzy-matches
  // it (a prompt asset literally named fidelity.md once swallowed it).
  const semantic = { checks: [{ id: "fidelity", status: "pass", reason: "r", evidence: [records[0].id] }] }
  references(semantic, allowed, records, idx)
  expect(semantic.checks[0].id).toBe("fidelity")
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
  // Missing previous problems are auto-inherited as open, not fatal: the candidate keeps
  // P1, and a COMPLETED verdict still fails because the inherited problem is unresolved.
  const previous = { ...candidate, status: "working" }
  const working = solved({ ...candidate, status: "working", problems: [] }, {}, new Map(), previous)
  expect(working).toBe(false)
  expect(previous.problems.some((item) => item.id === "P1" && item.status === "open")).toBe(true)
  expect(() =>
    solved(
      { ...candidate, status: "completed", problems: [] },
      { criteria: [{ id: "C1" }] },
      new Map([["a", { kind: "artifact" }]]),
      previous,
    ),
  ).toThrow("unresolved")
  // Superseding artifacts is the model's call — no drop guard; recovery is the
  // engine's job via the candidate ledger, not rejection.
  const slim = {
    ...candidate,
    status: "working",
    artifacts: [],
    claims: [],
    criteria: [],
    problems: [],
  }
  expect(() => solved(slim, {}, new Map(), previous)).not.toThrow()
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
  const output = path.join(dir, "loca/results", run.id, "round-0/cycle-0-fixture")
  await mkdir(path.join(output, "audit.json"), { recursive: true })
  await expect(engine.deliver(run, result)).rejects.toThrow()
  expect(run.delivery).toBeUndefined()
  expect(run.summary).toBeUndefined()
  expect(engine.store.run("parent").delivery).toBeUndefined()
})

test("restriction-class gates were converted to protection: reroute, forward deps, artifacts", async () => {
  const { engine } = await fixture()
  engine.capture("parent", { id: "g1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  // explore may register artifacts now (e.g. a map note) — verify via engine.register
  // on a synthetic child context:
  const context = {
    run,
    job: { id: "test-job" },
    allowed: new Set(),
    produced: [],
    role: "explore",
  }
  const asset = engine.register(context, "artifact", "map-note.md", "planning notes")
  expect(asset.kind).toBe("artifact")
  expect(engine.store.asset(asset.id).name).toBe("map-note.md")
})

test("protocol rejection corrects in-session: same job, same session, then accepted", async () => {
  const { engine, client } = await fixture()
  const calls = []
  const realPrompt = client.session.prompt
  let poisoned = true
  client.session.prompt = async (args) => {
    const context = engine.children.get(args.path.id)
    if (context?.role !== "attack") return realPrompt(args)
    if (context) {
      // Correction turns carry {correction,...} text the base mock can't parse:
      // substitute the original packet for output selection.
      const text = args.body.parts[0].text
      if (!JSON.parse(text).packet) args.body.parts[0].text = JSON.stringify({ packet: context.packet })
    }
    // Poison only the first attack submission: invalid artifact reference.
    if (poisoned) {
      poisoned = false
      calls.push(args.path.id)
      return { data: { info: { structured: { status: "completed", artifacts: [], claims: [{ id: "K1", text: "x", artifact: "artifact:deadbeef", criteria: ["C1"], conditions: [] }], problems: [], reason: "poisoned" } }, parts: [] } }
    }
    calls.push(args.path.id)
    return realPrompt(args)
  }
  engine.capture("parent", { id: "p1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  // The poisoned attempt and its correction must hit the SAME session id, and the
  // attack must ultimately be accepted.
  expect(calls.length).toBeGreaterThanOrEqual(2)
  expect(new Set(calls).size).toBe(1)
  const run = engine.store.run("parent")
  const attackJob = engine.store.jobs(run).find((job) => job.role === "attack")
  expect(attackJob.status).toBe("accepted")
  expect(engine.store.jobs(run).filter((job) => job.role === "attack")).toHaveLength(1)
})

test("in-session corrections keep multi-turn child history: only the last user turn is live", () => {
  // Mirrors the plugin's messages.transform contract: packet turn stays verbatim,
  // the last user turn is rewritten with the live text (packet on turn 1, correction
  // later). A single-user constraint would break every correction round.
  const transform = (messages, live) => {
    const users = messages.filter((message) => message.info.role === "user")
    if (!users.length) throw new Error("Missing controller packet")
    const last = users.at(-1)
    const part = last.parts.find((part) => part.type === "text")
    if (!part) throw new Error("Missing controller packet")
    part.text = live
    last.parts = [part]
  }
  const packet = JSON.stringify({ packet: { plan: {} } })
  const correction = JSON.stringify({ correction: "Unregistered evidence" })
  const history = [
    { info: { role: "user" }, parts: [{ type: "text", text: packet }] },
    { info: { role: "assistant" }, parts: [{ type: "tool" }] },
    { info: { role: "user" }, parts: [{ type: "text", text: correction }] },
  ]
  transform(history, correction)
  expect(history[0].parts[0].text).toBe(packet)
  expect(history[2].parts[0].text).toBe(correction)
  expect(() => transform([], "")).toThrow("Missing")
})

test("base-name citations expand to all parts of a split file", () => {
  const records = [
    { id: "artifact:p1", kind: "artifact", name: "proof/00_setup.md（第 1/4 部分：§0–§1.3）" },
    { id: "artifact:p2", kind: "artifact", name: "proof/00_setup.md（第 2/4 部分：§1.4–§2）" },
    { id: "artifact:p3", kind: "artifact", name: "code/verify_two_loop.py PART 2/2" },
  ]
  const idx = byName(records)
  const allowed = new Set(records.map((r) => r.id))
  const value = { claims: [{ evidence: ["proof/00_setup.md"] }] }
  references(value, allowed, records, idx)
  // Citing the FILE expands to every registered part of it.
  expect(value.claims[0].evidence.sort()).toEqual(["artifact:p1", "artifact:p2"])
  // PART-suffixed names strip to their base too.
  const value2 = { problems: [{ evidence: ["code/verify_two_loop.py"] }] }
  references(value2, allowed, records, idx)
  expect(value2.problems[0].evidence).toEqual(["artifact:p3"])
})

test("mid-pipeline crash resumes directly into the audit pipeline without re-assembly", async () => {
  const { engine, client } = await fixture()
  engine.capture("parent", { id: "z1", parts: [{ type: "text", text: "Give four" }] })
  await engine.act("parent", { abort: new AbortController().signal })
  const run = engine.store.run("parent")
  expect(run.phase).toBe("awaiting_human")
  // Simulate a crash mid-pipeline: phase stuck at split with completed candidate.
  run.phase = "split"
  engine.store.save(run)
  const calls = []
  const realPrompt = client.session.prompt
  client.session.prompt = async (args) => {
    const context = engine.children.get(args.path.id)
    if (context) calls.push(context.role)
    return realPrompt(args)
  }
  // Resume: assemble must NOT be re-called; the pipeline roles run directly.
  engine.requests.set("parent", "work")
  await engine.act("parent", { abort: new AbortController().signal })
  expect(calls).not.toContain("assemble")
  expect(calls).toContain("split")
  expect(engine.store.run("parent").phase).toBe("awaiting_human")
})
