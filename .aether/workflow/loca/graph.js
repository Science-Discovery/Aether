import { schemas } from "./schema.js"

// 计划图校验：zod 之上的结构检查。planner 输出必须满足：
// 子问题 id 唯一；criteria/depends/expectedRefs 可解析；每条验收标准至少有一个
// 负责子问题（覆盖缺口直接打回，不允许"没人负责的标准"进入工作阶段）。
export function planCheck(value, contract) {
  schemas.planner.parse(value)
  const ids = value.subproblems.map((sub) => sub.id)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate subproblem IDs")
  const known = new Set(ids)
  const criteria = new Set(contract.criteria.map((item) => item.id))
  for (const sub of value.subproblems) {
    sub.criteria.forEach((id) => {
      if (!criteria.has(id)) throw new Error(`Subproblem ${sub.id} references unknown criterion ${id}`)
    })
    sub.depends.forEach((id) => {
      if (!known.has(id)) throw new Error(`Subproblem ${sub.id} depends on unknown subproblem ${id}`)
    })
    sub.expectedRefs.forEach((id) => {
      if (!known.has(id)) throw new Error(`Subproblem ${sub.id} expected-references unknown subproblem ${id}`)
      if (id === sub.id) throw new Error(`Subproblem ${sub.id} cannot expected-reference itself`)
    })
    if (!sub.robustness.trim()) throw new Error(`Subproblem ${sub.id} lacks a goal-robustness statement`)
    if (!sub.verification.spec.trim()) throw new Error(`Subproblem ${sub.id} lacks a pre-registered verification spec`)
  }
  for (const criterion of contract.criteria)
    if (!value.subproblems.some((sub) => sub.criteria.includes(criterion.id)))
      throw new Error(`No subproblem is responsible for criterion ${criterion.id}`)
  // 预期引用环：S1↔S2 互为前提会让双方 pre-flight 永久互锁，必须打回重排
  const graph = new Map(ids.map((id) => [id, value.subproblems.find((s) => s.id === id).expectedRefs]))
  const state = new Map()
  const visit = (id) => {
    if (state.get(id) === 1) throw new Error(`expectedRefs cycle detected at ${id}`)
    if (state.get(id) === 2) return
    state.set(id, 1)
    for (const next of graph.get(id) ?? []) visit(next)
    state.set(id, 2)
  }
  for (const id of ids) visit(id)
  return true
}

// 传递闭包（沿 expectedRefs 消费边）。用于回滚与推测深度统计。
export function closure(subId, plan) {
  const out = new Set()
  const queue = [subId]
  while (queue.length) {
    const id = queue.pop()
    const sub = plan.subproblems.find((item) => item.id === id)
    if (!sub) continue
    for (const ref of sub.expectedRefs)
      if (!out.has(ref)) {
        out.add(ref)
        queue.push(ref)
      }
  }
  return out
}

// 一个子问题名下的当前（未 superseded）里程碑。
export function milestonesOf(run, subId) {
  return Object.values(run.milestones).filter((m) => m.subproblem === subId && m.status !== "superseded")
}

// Pre-flight（T2）：子问题可调度的条件。
// 直接前提 = expectedRefs 指向的子问题的全部当前里程碑：
//   verified          → 硬前提成立；
//   quick_checked     → 推测前提，计入推测预算；
//   其他状态          → 阻塞（连快检都没过，不允许消费）。
// 前提子问题未完成且尚无里程碑 → 阻塞（等它产出并过检）。
// 前提子问题已完成但无里程碑 → 无硬前提，放行（覆盖缺口由集成期兜底）。
export function preflight(run, subId) {
  const sub = run.plan.subproblems.find((item) => item.id === subId)
  if (!sub) return { ok: false, reason: `unknown subproblem ${subId}` }
  let speculative = 0
  for (const ref of sub.expectedRefs) {
    // draft 是被 gate 拒绝的提案，从未被接受为前提：不参与前提检查，
    // 否则它会永远阻塞依赖该子问题的下游（其 owner 可能已 completed）
    const produced = milestonesOf(run, ref).filter((m) => m.status !== "draft")
    for (const m of produced) {
      if (m.status === "verified") continue
      if (m.status === "quick_checked") {
        speculative++
        continue
      }
      return { ok: false, reason: `premise ${m.id} is ${m.status}` }
    }
    const done = run.subresults[ref]?.status === "completed"
    if (!produced.length && !done)
      return { ok: false, reason: `premise subproblem ${ref} has produced no milestone yet` }
  }
  return { ok: true, speculative }
}

// 推测预算：依赖闭包内"仅快检未深审"的里程碑总数 ≤ depth 才放行。
// 直接前提用 preflight（硬阻塞语义）；闭包内任何未过快检的前提同样硬阻塞——
// 否则 S3→S2→S1 链可以在多个未深审前提上叠加推测，违背"只越过 1 个"的设计。
export function speculationOk(run, subId, depth) {
  const flight = preflight(run, subId)
  if (!flight.ok) return flight
  let speculative = flight.speculative
  for (const dep of closure(subId, run.plan)) {
    if (run.plan.subproblems.find((item) => item.id === subId)?.expectedRefs.includes(dep)) continue
    const produced = milestonesOf(run, dep).filter((m) => m.status !== "draft")
    for (const m of produced) {
      if (m.status === "verified") continue
      if (m.status === "quick_checked") {
        speculative++
        continue
      }
      return { ok: false, reason: `transitive premise ${m.id} is ${m.status}` }
    }
    if (!produced.length && run.subresults[dep]?.status !== "completed")
      return { ok: false, reason: `premise subproblem ${dep} has produced no milestone yet` }
  }
  if (speculative > depth)
    return { ok: false, reason: `speculative depth ${speculative} exceeds budget ${depth}` }
  return { ok: true, speculative }
}

// 计划边 staleness 快照：B/C 类传播后，哪些预期消费边涉及旧版本。
export function staleEdges(run, changedSubs) {
  const changed = new Set(changedSubs)
  return run.plan.subproblems
    .filter((sub) => sub.expectedRefs.some((ref) => changed.has(ref)) && !run.subresults[sub.id])
    .map((sub) => ({ consumer: sub.id, premise: sub.expectedRefs.filter((ref) => changed.has(ref)) }))
}
