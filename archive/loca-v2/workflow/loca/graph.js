import { exact, schemas } from "./schema.js"

export function graph(value, contract, candidate, assets) {
  schemas.split.parse(value)
  const nodes = new Map(value.nodes.map((node) => [node.id, node]))
  if (nodes.size !== value.nodes.length) throw new Error("Duplicate node IDs")
  const criteria = new Set(contract.criteria.map((item) => item.id))
  const claims = new Set(candidate.claims.map((item) => item.id))
  const seen = new Set()
  const active = new Set()
  const order = []
  function visit(node) {
    if (active.has(node.id)) throw new Error(`DAG cycle at ${node.id}`)
    if (seen.has(node.id)) return
    if (assets.has(node.id)) throw new Error("Node ID collides with an asset")
    active.add(node.id)
    if (new Set(node.outputs.map((item) => item.port)).size !== node.outputs.length)
      throw new Error("Duplicate output ports")
    node.material.forEach((range) => {
      const asset = assets.get(range.asset)
      if (!asset || range.start >= range.end || range.end > asset.content.length)
        throw new Error(`Invalid material range ${range.asset}`)
      if (asset.kind && !["input", "source", "artifact", "code", "execution"].includes(asset.kind))
        throw new Error("Audit reports and workflow instructions are not project materials")
    })
    node.criteria.forEach((id) => {
      if (!criteria.has(id)) throw new Error(`Unknown criterion ${id}`)
    })
    node.claims.forEach((id) => {
      if (!claims.has(id)) throw new Error(`Unknown claim ${id}`)
    })
    node.inputs.forEach((input) => {
      if (assets.has(input.from)) {
        if (input.port !== "asset") throw new Error("Root asset port must be asset")
        if (!["input", "source"].includes(assets.get(input.from).kind))
          throw new Error("Only human inputs and frozen external sources may be DAG roots")
        if (candidate.artifacts.includes(input.from))
          throw new Error("Generated candidate artifacts must enter as node outputs, not unchecked root premises")
        return
      }
      const parent = nodes.get(input.from)
      if (!parent || !parent.outputs.some((item) => item.port === input.port))
        throw new Error(`Missing input ${input.from}.${input.port}`)
      visit(parent)
    })
    if (
      node.purpose === "acceptance" &&
      (!node.criteria.length || !node.inputs.some((input) => nodes.get(input.from)?.purpose === "production"))
    )
      throw new Error("Acceptance node must independently consume production output and identify criteria")
    active.delete(node.id)
    seen.add(node.id)
    order.push(node.id)
  }
  value.nodes.forEach(visit)
  criteria.forEach((id) => {
    if (!value.nodes.some((node) => node.purpose === "acceptance" && node.criteria.includes(id)))
      throw new Error(`No acceptance validation for ${id}`)
  })
  claims.forEach((id) => {
    if (!value.nodes.some((node) => node.purpose === "production" && node.claims.includes(id)))
      throw new Error(`Uncovered claim ${id}`)
  })
  candidate.artifacts.forEach((id) => {
    const ranges = value.nodes
      .filter((node) => node.purpose === "production")
      .flatMap((node) => node.material.filter((range) => range.asset === id))
      .sort((a, b) => a.start - b.start)
    const content = assets.get(id).content
    const coverage = ranges.reduce((end, range) => {
      if (content.slice(end, range.start).trim())
        throw new Error(`Uncovered artifact range ${id}:${end}-${range.start}`)
      return Math.max(end, range.end)
    }, 0)
    if (content.slice(coverage).trim() || !ranges.length) throw new Error(`Uncovered artifact ${id}`)
  })
  return order
}

// Duplicate-problem merging. Models clone a persistent gap into a new id each cycle
// ("P-G7b" → "P-G7b-c7" → "-c8"…), and anti-silent-removal inheritance would keep
// every clone open forever. A problem merges into an EARLIER one when:
//  - its id extends the earlier id (P-G7b-c7 starts with P-G7b), or
//  - its detail explicitly declares continuation ("沿袭 X", "supersedes X", quotes X).
// The merged pair keeps the original id; if either side is open the merged problem
// stays open. Closing still requires evidence (enforced by solved()); a problem whose
// detail claims closure but whose status is open is treated as OPEN (detail cannot
// self-certify) — that kills the "（已关闭，历史确认维持）status=open" self-contradiction
// pattern that inflated the list.
// ... (docstring above)
export function mergeProblems(problems) {
  const pass = (input) => {
    const list = (input ?? []).map((problem) => ({
      ...problem,
      status: problem.status === "closed" && (!problem.evidence || !problem.evidence.length) ? "open" : problem.status,
    }))
    const merged = []
    for (const problem of list) {
      // A clone continues a SPECIFIC kept problem: its id extends the kept id (the
      // model's cycle-suffix convention), or its detail NAMES the kept id. A bare
      // "沿袭" without naming the original is not enough — different gaps also say 沿袭.
      const parent = merged.find((kept) => {
        if (kept.id === problem.id) return true
        if (problem.id.startsWith(kept.id) || kept.id.startsWith(problem.id)) return true
        const names = new RegExp(`${kept.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`)
        return names.test(problem.detail ?? "")
      })
      if (!parent) {
        merged.push(problem)
        continue
      }
      // Collapse onto the ORIGINAL identity: shortest id wins (P-G7b over -c7 clones).
      // Newest detail is kept (richest context), but open-status is sticky: if either
      // side is open the merged problem is open.
      const [keep, drop] = parent.id.length <= problem.id.length ? [parent, problem] : [problem, parent]
      merged.splice(merged.indexOf(parent), 1, {
        ...keep,
        status: keep.status === "open" || drop.status === "open" ? "open" : "closed",
        detail: drop.detail || keep.detail,
        evidence: [...new Set([...(keep.evidence ?? []), ...(drop.evidence ?? [])])],
      })
    }
    return merged
  }
  // Iterate to fixpoint: chains of clones (c12←c11←P-G7b) need multiple passes.
  let current = pass(problems)
  while (true) {
    const next = pass(current)
    if (next.length === current.length) return current
    current = next
  }
}

export function solved(value, contract, assets, previous) {
  schemas.assemble.parse(value)
  // Problem retention is the anti-silent-removal guard. Rather than burn a full retry
  // when the model forgets to restate a still-open previous problem, auto-inherit it:
  // a MISSING previous problem is re-inserted as open (it cannot have been solved
  // without being mentioned); anything the model closes still needs real evidence.
  previous?.problems.forEach((item) => {
    if (value.problems.some((next) => next.id === item.id)) return
    value.problems.push({ id: item.id, detail: item.detail, status: "open", evidence: [] })
  })
  // Artifact supersession is the MODEL's call, not the engine's: a revision may
  // legitimately retire prior artifacts it judged invalid for the goal. The engine
  // guarantees recoverability instead of blocking — the caller archives the previous
  // candidate (run.candidates ledger, one row per accepted cycle) so nothing is ever
  // destroyed and any retired artifact can be restored or inspected. No drop guard.
  if (value.status !== "completed") return false
  if (
    !value.artifacts.length ||
    !value.claims.length ||
    value.problems.some((item) => item.status !== "closed" || !item.evidence.length)
  )
    throw new Error("Completed candidate has no result or has unresolved problems")
  if (new Set(value.claims.map((item) => item.id)).size !== value.claims.length) throw new Error("Duplicate claims")
  exact(
    value.criteria.map((item) => item.id),
    contract.criteria.map((item) => item.id),
    "solve criteria",
  )
  value.artifacts.forEach((id) => {
    // Generated work product is citable as a candidate artifact: code assets
    // (sandbox verification scripts) and execution records are OUTPUTS the model
    // produced, exactly like documents. Only frozen INPUTS (source/input kinds) are
    // not deliverables — citing those confuses premises with results.
    const kind = assets.get(id)?.kind
    if (kind === "source" || kind === "input")
      throw new Error(
        `Frozen source cited as generated artifact: ${id} — candidate artifacts must be produced work (artifact/code/execution), sources belong in evidence`,
      )
    if (!kind) throw new Error(`Not a registered asset: ${id}`)
  })
  value.claims.forEach((item) => {
    if (!value.artifacts.includes(item.artifact)) throw new Error("Claim outside candidate artifacts")
  })
  previous?.problems.forEach((item) => {
    if (value.problems.some((next) => next.id === item.id && next.status === "closed" && next.evidence.length)) return
    const retention = previous.problems.map((prob) => `${prob.id}: ${prob.detail.slice(0, 80)}`).join(" | ")
    throw new Error(
      `Problem silently removed: ${item.id}. It must be retained with its ORIGINAL id and closed with real evidence; previous problems are: ${retention}`,
    )
  })
  return true
}

export function aggregate(nodes, reports, count, validations) {
  const state = Object.create(null)
  const pending = new Set(nodes.map((node) => node.id))
  while (pending.size) {
    const ready = nodes.filter((node) => pending.has(node.id) && node.inputs.every((input) => !pending.has(input.from)))
    if (!ready.length) throw new Error("Cannot aggregate cyclic graph")
    ready.forEach((node) => {
      const panel = reports[node.id] ?? []
      const local =
        panel.length === count &&
        panel.every((item) => item.verdict === "pass" && !item.findings.some((issue) => issue.blocking)) &&
        (node.purpose !== "acceptance" || validations[node.id]?.verdict === "pass")
      state[node.id] = {
        local: local ? "pass" : "fail",
        effective:
          local && node.inputs.every((input) => !state[input.from] || state[input.from].effective === "pass")
            ? "pass"
            : "blocked",
      }
      pending.delete(node.id)
    })
  }
  return state
}
