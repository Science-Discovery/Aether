import { milestonesOf } from "./graph.js"

// 里程碑注册表与传播逻辑。全部纯函数：状态在 run 行内，任何中断后 frontier
// 都可以从这些投影重建。

const STRENGTH = { programmatic: 0, independent: 1, crosscheck: 2, weak: 3 }
export const strengthOrder = ["programmatic", "independent", "crosscheck", "weak"]

// 输入解析：from → {type, id}。milestone 精确 id 或 <sub>:<local> 唯一短名；
// 资产按注册名/id；"internal" 字面量表示本子问题内部工作。
export function resolveInput(run, from, nameIndex) {
  if (from === "internal") return { type: "internal", id: from }
  if (run.milestones[from] && run.milestones[from].status !== "superseded") return { type: "milestone", id: from }
  const shorthand = Object.keys(run.milestones).filter((id) => id.endsWith(`:${from}`))
  if (shorthand.length === 1) return { type: "milestone", id: shorthand[0] }
  const group = nameIndex?.get(from) ?? nameIndex?.get(from.trim())
  if (group?.length === 1) return { type: "asset", id: group[0].id }
  return null
}

// 判据 2（前提可封闭）的程序检查：每个输入可解析，且里程碑输入的状态
// 为 verified/quick_checked（quick 之下不允许被消费——推测执行的下界）。
export function closureOk(run, m, nameIndex) {
  for (const input of m.inputs) {
    const resolved = resolveInput(run, input.from, nameIndex)
    if (!resolved) return { ok: false, reason: `unresolvable input ${input.from}` }
    if (resolved.type === "milestone") {
      const premise = run.milestones[resolved.id]
      if (!["verified", "quick_checked"].includes(premise.status))
        return { ok: false, reason: `premise ${resolved.id} is ${premise.status}` }
    }
  }
  return { ok: true }
}

// 判据 4（预期引用）：映射验收标准，或被任一计划子问题预期引用（含未落地）。
export function referenced(run, m) {
  if (m.criteria.length) return true
  return run.plan.subproblems.some((sub) => sub.expectedRefs.includes(m.subproblem) && sub.id !== m.subproblem)
}

function resolveShorthand(run, from) {
  const hits = Object.keys(run.milestones).filter((id) => id.endsWith(`:${from}`))
  return hits.length === 1 ? run.milestones[hits[0]] : null
}

// 前提版本漂移：注册后前提又前进了（B 类修正落地）→ 本里程碑不能直接 verified。
export function premiseDrift(run, m) {
  for (const input of m.inputs) {
    if (input.from === "internal") continue
    const premise = run.milestones[input.from] ?? resolveShorthand(run, input.from)
    if (!premise || premise.status === "superseded") continue
    // 前提状态退化（stale/failed/draft 等）与版本漂移同样阻断验证：
    // gate 时刻的封闭性检查不能保证深审完成时前提仍然成立
    if (!["verified", "quick_checked"].includes(premise.status))
      return `${premise.id} 状态已退化为 ${premise.status}（申报时为可用前提）`
    const entry = run.ledger.find((e) => e.consumer === m.id && e.consumed === input.from)
    if (entry?.pv != null && premise.version !== entry.pv)
      return `${premise.id} 已更新至 v${premise.version}（本里程碑申报基于 v${entry.pv}）`
  }
  return null
}

// 注册 solve 输出中的里程碑提案。
// 规则：每个子问题的第一个提案视为计划主里程碑（使用 planner 预注册的验证方案，
// anchor 按实现模式工作）；其余为涌现里程碑（anchor 按提案模式独立提出方案）。
// 重复申报同一 local id → 版本递增；命题文本不变则沿用已 trusted 的验证方案，
// 仅重跑快检与深审；命题变化则验证方案重置（重新 anchor/vaudit）。
export function registerProposals(run, sub, value) {
  const primarySeen = milestonesOf(run, sub.id).some((m) => m.kind === "planned")
  const planned = sub.verification
  value.milestones.forEach((proposal, index) => {
    const id = `${sub.id}:${proposal.id}`
    const existing = run.milestones[id]
    if (existing && existing.status !== "superseded") {
      const sameStatement = existing.statement === proposal.statement
      const prev = existing.status
      existing.history.push({
        version: existing.version,
        statement: existing.statement,
        scope: existing.scope,
        status: existing.status,
      })
      existing.version++
      existing.statement = proposal.statement
      existing.scope = proposal.scope
      existing.criteria = proposal.criteria
      existing.branches = proposal.branches
      existing.highRisk = proposal.highRisk
      existing.artifacts = proposal.artifacts
      existing.values = proposal.values
      existing.review = {}
      existing.impact = null
      if (!sameStatement) {
        existing.verification = existing.kind === "planned" ? { ...planned, mode: "implement" } : { mode: "propose" }
      }
      // gate continue 后的重新申报必须重新过 gate，即使命题文本未变
      existing.status = sameStatement && existing.verification.verifier && prev !== "draft" ? "gated" : "proposed"
      run.ledger = run.ledger.filter((entry) => entry.consumer !== id)
    } else {
      const kind = index === 0 && !primarySeen ? "planned" : "emergent"
      run.milestones[id] = {
        id,
        kind,
        subproblem: sub.id,
        version: 1,
        statement: proposal.statement,
        scope: proposal.scope,
        criteria: proposal.criteria,
        inputs: proposal.inputs,
        branches: proposal.branches,
        highRisk: proposal.highRisk,
        artifacts: proposal.artifacts,
        values: proposal.values,
        verification: kind === "planned" ? { ...planned, mode: "implement" } : { mode: "propose" },
        status: "proposed",
        strength: null,
        review: {},
        impact: null,
        history: [],
      }
    }
    const record = run.milestones[id]
    run.ledger = run.ledger.filter((entry) => entry.consumer !== id)
    record.inputs.forEach((input) => {
      if (input.from === "internal") return
      // pv：注册时前提的版本。聚合时的版本漂移检查依赖它——
      // 前提前进后完成深审的里程碑不得直接 verified。
      const premise = run.milestones[input.from] ?? resolveShorthand(run, input.from)
      run.ledger.push({
        consumer: id,
        consumed: input.from,
        use: input.use,
        version: record.version,
        pv: premise ? premise.version : null,
      })
    })
  })
}

// gate 裁决落账。
export function gateDecision(run, m, value) {
  if (value.decision === "promote") {
    // gated = 程序锚待审计/快检；非程序锚直接进入深审就绪态
    m.status = m.verification.anchor === "programmatic" ? "gated" : "quick_checked"
    return "promote"
  }
  if (value.decision === "merge") {
    const parent = milestonesOf(run, m.subproblem).find((item) => item.id !== m.id)
    if (parent) {
      parent.branches.push({ id: m.id.split(":").pop(), statement: m.statement, inputs: m.inputs.map((i) => i.from) })
      // 父级已 verified 时退回 quick_checked：新分支必须补验证后重新聚合
      if (parent.status === "verified") {
        parent.status = "quick_checked"
        parent.strength = null
      }
      m.status = "superseded"
      m.mergedInto = parent.id
      return "merged"
    }
  }
  m.status = "draft"
  return "continue"
}

// anchor 落账：验证方案与（programmatic 时）验证器代码资产 id。
export function anchorResult(run, m, value, verifierAssetId) {
  m.verification = {
    mode: m.verification.mode,
    anchor: value.anchor,
    spec: value.spec,
    verifier: verifierAssetId ?? null,
    verifierInputs: value.inputs,
    anchorReport: value.reason,
  }
  if (verifierAssetId) run.verifiers[m.id] = { asset: verifierAssetId, status: "draft", controls: [] }
}

// 深审组件规格：按锚类型给出必需组件。
// adversarial 与 compat 恒有；unit 由质疑清单 + 高风险步骤派生；
// e2e 仅非程序锚；crosscheck 的强度依赖分支（无分支降为 weak）。
export function deepSpec(run, m) {
  const anchor = m.verification.anchor
  const spec = {
    quick: anchor === "programmatic",
    e2e: ["rederivation", "limit", "literature"].includes(anchor),
    adversarial: true,
    compat: true,
    branches: m.branches.map((branch) => branch.id),
  }
  spec.units = [] // engine 在 adversarial 完成后填充（质疑 + highRisk）
  return spec
}

export function anchorStrength(m) {
  switch (m.verification.anchor) {
    case "programmatic":
      return "programmatic"
    case "rederivation":
      return "independent"
    case "crosscheck":
      return m.branches.length ? "crosscheck" : "weak"
    default:
      return "weak"
  }
}

// 链式强度：结论强度 = min(自身锚点强度, 前提链最弱环节)。
// rank 越大越弱，因此取 max(rank)。
export function chainStrength(run, m, seen = new Set()) {
  if (seen.has(m.id)) return STRENGTH[m.verification.anchor] ?? STRENGTH.weak
  seen.add(m.id)
  let rank = STRENGTH[anchorStrength(m)] ?? STRENGTH.weak
  for (const input of m.inputs) {
    const resolved = run.milestones[input.from]
    if (!resolved || resolved.status === "superseded") continue
    rank = Math.max(rank, chainStrength(run, resolved, seen))
  }
  return rank
}

export function strengthName(rank) {
  return strengthOrder[rank]
}

// 程序层矛盾检测：同一符号声明了不同字面值 → 冲突事件（compat 席复核，不自动裁决）。
export function contradictions(run, m) {
  const out = []
  for (const other of Object.values(run.milestones)) {
    if (other.id === m.id || other.status === "superseded" || other.status === "draft") continue
    for (const a of m.values ?? [])
      for (const b of other.values ?? [])
        if (a.symbol === b.symbol && a.value !== b.value)
          out.push({ symbol: a.symbol, left: { id: m.id, value: a.value }, right: { id: other.id, value: b.value } })
  }
  return out
}

// 账本消费者：直接消费该里程碑的全部里程碑。
export function consumersOf(run, milestoneId) {
  const target = run.milestones[milestoneId]
  const keys = new Set([milestoneId])
  // 短名引用（solve 可能写 <local> 简写）也计入
  const local = milestoneId.split(":").pop()
  for (const entry of run.ledger) {
    if (entry.consumed === milestoneId || entry.consumed === local) keys.add(entry.consumer)
  }
  return [...keys].map((id) => run.milestones[id]).filter((m) => m && m.status !== "superseded" && m.id !== target?.id)
}

// B 类三态传播。返回 engine 需要执行的动作集：
//   rerun       — 消费者有 trusted 验证器且原为 verified：标记 stale，由 frontier 调度
//                 验证器重跑；通过即回到 verified（stale 传播的停止条件）
//   staleManual — 消费者无 trusted 验证器：标 stale，重开其 owner 子问题（refresh 模式），传播继续
//   planStale   — 未开工的计划预期消费者：计划边标 stale（调度时天然消费最新版本）
export function propagateB(run, changedId) {
  const effects = { rerun: [], staleManual: [], planStale: [] }
  const owner = run.milestones[changedId]?.subproblem
  const visited = new Set([changedId])
  const queue = [changedId]
  while (queue.length) {
    const id = queue.pop()
    for (const consumer of consumersOf(run, id)) {
      if (visited.has(consumer.id)) continue
      visited.add(consumer.id)
      // 在飞（proposed/gated）消费者不标 stale：标了会卡死其调度。
      // 它们的前提版本漂移由 aggregate() 的 pv 检查兜底。
      if (!["verified", "quick_checked", "stale"].includes(consumer.status)) continue
      const verifier = run.verifiers[consumer.id]
      if (verifier?.status === "trusted" && consumer.status !== "stale") {
        consumer.status = "stale"
        effects.rerun.push(consumer.id)
      } else {
        consumer.status = "stale"
        effects.staleManual.push(consumer.id)
        queue.push(consumer.id)
      }
    }
  }
  for (const sub of run.plan.subproblems)
    if (sub.expectedRefs.includes(owner) && !run.subresults[sub.id]) effects.planStale.push(sub.id)
  return effects
}

// C 类选择性回滚集：沿账本传递依赖失效里程碑的全部下游里程碑与 owner 子问题。
// 独立子问题的结论（不在依赖闭包内）保留。
export function rollbackSet(run, failedId) {
  const milestones = new Set()
  const subs = new Set()
  const queue = [failedId]
  const visited = new Set([failedId])
  while (queue.length) {
    const id = queue.pop()
    for (const consumer of consumersOf(run, id)) {
      if (visited.has(consumer.id)) continue
      visited.add(consumer.id)
      milestones.add(consumer.id)
      subs.add(consumer.subproblem)
      queue.push(consumer.id)
    }
  }
  return { milestones: [...milestones], subs: [...subs] }
}

// 深审聚合：全部必需组件通过 → verified（记录链式强度）；否则 failed 并收集阻断发现。
export function aggregate(run, m) {
  const spec = deepSpec(run, m)
  const review = m.review
  const findings = []
  if (spec.quick && review.quick?.pass !== true)
    findings.push({
      id: `${m.id}-quick`,
      target: m.id,
      detail: `程序化快检未通过：exit ${review.quick?.exit ?? "n/a"}`,
      evidence: review.quick?.execution ? [review.quick.execution] : m.artifacts,
      repair: "solve",
      blocking: true,
    })
  if (spec.e2e && review.e2e) {
    if (review.e2e.verdict !== "pass")
      findings.push(
        ...(review.e2e.findings ?? []).map((f) => ({ ...f, id: `${m.id}-e2e-${f.id}` })),
        ...(!review.e2e.findings?.some((f) => f.blocking)
          ? [
              {
                id: `${m.id}-e2e`,
                target: m.id,
                detail: `独立验证判定 ${review.e2e.verdict}：${review.e2e.summary?.slice(0, 160)}`,
                evidence: review.e2e.checks.flatMap((c) => c.evidence).slice(0, 8),
                repair: "solve",
                blocking: true,
              },
            ]
          : []),
      )
  }
  for (const branch of review.branches ?? [])
    if (branch.report.verdict !== "pass")
      findings.push(
        ...(branch.report.findings ?? []).map((f) => ({ ...f, id: `${m.id}-${branch.id}-${f.id}` })),
        ...(!branch.report.findings?.some((f) => f.blocking)
          ? [
              {
                id: `${m.id}-${branch.id}`,
                target: `${m.id}#${branch.id}`,
                detail: `分支验证判定 ${branch.report.verdict}：${branch.report.summary?.slice(0, 160)}`,
                evidence: branch.report.checks.flatMap((c) => c.evidence).slice(0, 8),
                repair: "solve",
                blocking: true,
              },
            ]
          : []),
      )
  for (const unit of review.units ?? [])
    if (unit.report.verdict !== "pass")
      findings.push(
        ...(unit.report.findings ?? []).map((f) => ({ ...f, id: `${m.id}-u-${unit.id}-${f.id}` })),
        ...(!unit.report.findings?.some((f) => f.blocking)
          ? [
              {
                id: `${m.id}-u-${unit.id}`,
                target: `${m.id}@${unit.id}`,
                detail: `重点步骤复核判定 ${unit.report.verdict}：${unit.report.summary?.slice(0, 160)}`,
                evidence: unit.report.checks.flatMap((c) => c.evidence).slice(0, 8),
                repair: "solve",
                blocking: true,
              },
            ]
          : []),
      )
  if (review.compat && review.compat.verdict !== "pass")
    findings.push(
      ...(review.compat.findings ?? []).map((f) => ({ ...f, id: `${m.id}-compat-${f.id}`, repair: "verify" })),
      ...(!review.compat.findings?.some((f) => f.blocking)
        ? [
            {
              id: `${m.id}-compat`,
              target: m.id,
              detail: `相容性审查判定 ${review.compat.verdict}`,
              evidence: review.compat.checks.flatMap((c) => c.evidence).slice(0, 8),
              repair: "verify",
              blocking: true,
            },
          ]
        : []),
    )
  const unresolved = (review.challenges ?? [])
    .filter((c) => c.importance === "must")
    .filter((c) => !(review.units ?? []).some((u) => u.id === c.id && u.report.verdict === "pass"))
  for (const challenge of unresolved)
    findings.push({
      id: `${m.id}-q-${challenge.id}`,
      target: `${m.id}@${challenge.id}`,
      detail: `必须处置的质疑未通过复核：${challenge.hypothesis.slice(0, 160)}`,
      evidence: challenge.evidence,
      repair: "solve",
      blocking: true,
    })
  const complete =
    (!spec.quick || review.quick) &&
    (!spec.e2e || review.e2e) &&
    review.adversarial &&
    review.compat &&
    spec.branches.every((id) => (review.branches ?? []).some((b) => b.id === id)) &&
    (review.units ?? []).length >= (review.unitPlan?.length ?? 0) &&
    (review.unitPlan ?? []).every((id) => (review.units ?? []).some((u) => u.id === id))
  if (!complete) return { done: false }
  // 前提版本漂移：本里程碑注册后前提又前进了（B 类修正落地），
  // 不能在旧前提上直接 verified——作为失败交 triage 重做。
  const drift = premiseDrift(run, m)
  if (drift)
    findings.push({
      id: `${m.id}-drift`,
      target: m.id,
      detail: `前提版本漂移：${drift}`,
      evidence: m.artifacts.slice(0, 4),
      repair: "solve",
      blocking: true,
    })
  if (findings.some((f) => f.blocking)) {
    m.status = "failed"
    m.review.findings = findings
    return { done: true, failed: true, findings }
  }
  m.status = "verified"
  m.strength = strengthName(chainStrength(run, m))
  m.review.findings = []
  return { done: true, failed: false }
}

// milestone 深审是否全部组件到齐（frontier 判定用）。
export function reviewComplete(run, m) {
  const spec = deepSpec(run, m)
  const review = m.review
  return (
    (!spec.quick || review.quick) &&
    (!spec.e2e || review.e2e) &&
    review.adversarial &&
    review.compat &&
    spec.branches.every((id) => (review.branches ?? []).some((b) => b.id === id)) &&
    (review.unitPlan ?? []).every((id) => (review.units ?? []).some((u) => u.id === id))
  )
}

// ---- 问题保留与克隆合并（v2 solved()/mergeProblems 防线的移植）----

// 克隆重名合并：模型每轮把同一未决缺口克隆成新 id（"P-G7b" → "P-G7b-c7" → …），
// 防静默删除的继承会把每个克隆永远留在清单里。id 前缀延续或 detail 点名前身
// 即视为同一缺口，折叠回最短 id；open 状态粘滞（任一侧 open 则合并后 open）。
export function mergeProblems(problems) {
  const pass = (input) => {
    const list = (input ?? []).map((problem) => ({
      ...problem,
      status: problem.status === "closed" && (!problem.evidence || !problem.evidence.length) ? "open" : problem.status,
    }))
    const merged = []
    for (const problem of list) {
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
  let current = pass(problems)
  while (true) {
    const next = pass(current)
    if (next.length === current.length) return current
    current = next
  }
}

// 防静默删除：solve 结果缺失的旧未决问题自动继承为 open（未被提及的问题不可能
// 已被解决）；已关闭问题必须有证据；随后做克隆合并。
export function retainProblems(value, prior) {
  if (!prior?.problems?.length) return
  prior.problems.forEach((item) => {
    if (!value.problems.some((next) => next.id === item.id))
      value.problems.push({ id: item.id, detail: item.detail, status: "open", evidence: [] })
  })
  value.problems = mergeProblems(value.problems)
}
