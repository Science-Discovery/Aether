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

export function solved(value, contract, assets, previous) {
  schemas.solve.parse(value)
  previous?.problems.forEach((item) => {
    if (!value.problems.some((next) => next.id === item.id)) throw new Error(`Problem silently removed: ${item.id}`)
  })
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
    if (assets.get(id)?.kind !== "artifact") throw new Error(`Not a generated artifact: ${id}`)
  })
  value.claims.forEach((item) => {
    if (!value.artifacts.includes(item.artifact)) throw new Error("Claim outside candidate artifacts")
  })
  previous?.problems.forEach((item) => {
    if (!value.problems.some((next) => next.id === item.id && next.status === "closed" && next.evidence.length))
      throw new Error(`Problem silently removed: ${item.id}`)
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
