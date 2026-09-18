import { z } from "zod"

export { z }

const text = z.string().min(1)
const refs = z.array(text)
const assumption = z
  .object({
    id: text,
    reason: text,
    content: text,
    evidence: refs,
  })
  .strict()
const question = z
  .object({
    id: text,
    blocking: z.boolean(),
    question: text,
    evidence: refs,
  })
  .strict()
const issue = z
  .object({
    id: text,
    target: text,
    detail: text,
    evidence: refs.min(1),
    repair: z.enum(["solve", "plan", "verify", "human"]),
    blocking: z.boolean(),
  })
  .strict()
const check = z
  .object({ id: text, status: z.enum(["pass", "fail", "inconclusive"]), reason: text, evidence: refs.min(1) })
  .strict()

export const report = z
  .object({
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    checks: z.array(check).min(1),
    findings: z.array(issue),
    assumptions: z.array(assumption).max(20).optional(),
  })
  .strict()

const anchors = ["programmatic", "rederivation", "limit", "literature", "crosscheck", "weak"]

export const schemas = {
  contract: z
    .object({
      goal: text,
      criteria: z
        .array(z.object({ id: text, text, method: text, origin: text, evidence: refs.optional() }).strict())
        .min(1),
      removed: z.array(z.object({ id: text, quote: text }).strict()),
      questions: z.array(question),
      assumptions: z.array(assumption).max(20),
    })
    .strict(),
  planner: z
    .object({
      strategy: text,
      subproblems: z
        .array(
          z
            .object({
              id: text,
              goal: text,
              criteria: refs.min(1),
              // 预期引用：本子问题消费哪些其他子问题的结论（计划图上的预期消费边，
              // 落地前即成立——里程碑审核可发生在下游任务落地之前）。
              expectedRefs: refs,
              depends: refs,
              // 预注册验证方案：锚类型 + 规格。防止看到答案后发明软验证。
              verification: z.object({ anchor: z.enum(anchors), spec: text }).strict(),
              // 目标抗失效性自检：说明目标陈述为何是结论无关的（或为何必须依赖具体结论）。
              robustness: text,
            })
            .strict(),
        )
        .min(1)
        .max(12),
      assumptions: z.array(assumption).max(20).optional(),
      reason: text,
    })
    .strict(),
  solve: z
    .object({
      status: z.enum(["completed", "working", "blocked"]),
      artifacts: refs.default([]),
      // 里程碑提案：逻辑封闭的可验证命题。inputs 是结论级消费边（账本来源）。
      milestones: z
        .array(
          z
            .object({
              id: text,
              statement: text,
              scope: text,
              criteria: refs.default([]),
              inputs: z.array(z.object({ from: text, use: text }).strict()).default([]),
              branches: z.array(z.object({ id: text, statement: text, inputs: refs }).strict()).default([]),
              highRisk: z.array(z.object({ id: text, what: text, why: text }).strict()).default([]),
              artifacts: refs.default([]),
              values: z.array(z.object({ symbol: text, value: text, unit: text }).strict()).default([]),
            })
            .strict(),
        )
        .default([]),
      claims: z
        .array(z.object({ id: text, text, artifact: text, criteria: refs, conditions: refs }).strict())
        .default([]),
      problems: z
        .array(z.object({ id: text, detail: text, status: z.enum(["open", "closed"]), evidence: refs }).strict())
        .default([]),
      assumptions: z.array(assumption).max(20).optional(),
      reason: text,
    })
    .strict(),
  gate: z
    .object({
      // promote 升格为里程碑进入审核；merge 并入父里程碑作为 semi-e2e 分支；
      // continue 未逻辑封闭，回到 solve 继续累积。
      decision: z.enum(["promote", "merge", "continue"]),
      checks: z.array(check).min(1),
      note: text,
      findings: z.array(issue),
      assumptions: z.array(assumption).max(20).optional(),
    })
    .strict(),
  anchor: z
    .object({
      anchor: z.enum(anchors),
      spec: text,
      // programmatic 锚：Python 验证器源码。运行协议：exit 0 = pass。
      verifier: z.string().optional(),
      // 验证器消费的里程碑产物名（manifest 按名索引）。
      inputs: refs.default([]),
      reason: text,
      assumptions: z.array(assumption).max(20).optional(),
    })
    .strict(),
  vaudit: z
    .object({
      // trusted：语义符合 + 独立 + 阴性对照齐全；rejected：未通过（findings 说明原因）
      decision: z.enum(["trusted", "rejected"]),
      checks: z.array(check).min(1),
      findings: z.array(issue),
      // 阴性对照：注入已知错误后验证器必须 fail（observed=failed 且执行退出码非零）。
      controls: z
        .array(
          z
            .object({
              id: text,
              mutation: text,
              execution: text,
              observed: z.enum(["failed", "passed"]),
            })
            .strict(),
        )
        .default([]),
      assumptions: z.array(assumption).max(20).optional(),
    })
    .strict(),
  verify: report.extend({ summary: text }).strict(),
  adversarial: z
    .object({
      // 质疑自带门槛：每条必须有具体失败模式假设与理由；理由不充分的不提交。
      challenges: z
        .array(
          z
            .object({
              id: text,
              target: text,
              kind: z.enum(["approximation", "concept", "theorem", "numeric", "other"]),
              hypothesis: text,
              importance: z.enum(["must", "spot"]),
              reason: text,
              evidence: refs.min(1),
            })
            .strict(),
        )
        .default([]),
      note: text,
      assumptions: z.array(assumption).max(20).optional(),
    })
    .strict(),
  compat: report,
  triage: z
    .object({
      impacts: z
        .array(
          z
            .object({
              finding: text,
              class: z.enum(["A", "B", "C"]),
              affected: refs,
              goalChange: z.boolean(),
              note: text,
            })
            .strict(),
        )
        .min(1),
      reason: text,
      assumptions: z.array(assumption).max(20).optional(),
    })
    .strict(),
  integrate: report
    .extend({
      summary: text,
      criteria: z
        .array(
          z
            .object({
              id: text,
              milestones: refs.min(1),
              artifacts: refs.min(1),
              evidence: refs.min(1),
              scope: text,
              strength: z.enum(["programmatic", "independent", "crosscheck", "weak"]),
              review: text,
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
}

export function schema(role) {
  return schemas[role] ?? report
}

export function exact(actual, expected, label) {
  const missing = expected.filter((id) => !actual.includes(id))
  const duplicate = actual.filter((id, index) => actual.indexOf(id) !== index)
  const unexpected = actual.filter((id) => !expected.includes(id))
  if (missing.length || duplicate.length || unexpected.length || actual.length !== expected.length)
    throw new Error(
      `${label}: missing, duplicate or unexpected IDs; expected [${expected.join(", ")}]; ` +
        `missing [${missing.join(", ") || "none"}]; duplicate [${duplicate.join(", ") || "none"}]; ` +
        `unexpected [${unexpected.join(", ") || "none"}]`,
    )
}

export function review(value, checks) {
  report.parse({ verdict: value.verdict, checks: value.checks, findings: value.findings })
  exact(
    value.checks.map((check) => check.id),
    checks,
    "review checks",
  )
  if (
    value.verdict === "pass" &&
    (value.checks.some((check) => check.status !== "pass") || value.findings.some((issue) => issue.blocking))
  )
    throw new Error("Pass contradicts checks or blocking findings")
  if (value.verdict !== "pass" && !value.findings.some((issue) => issue.blocking))
    throw new Error("Failed/inconclusive review must identify a blocking finding")
  return value
}

// ---- 名称为主的自愈引用解析（v2 验证保留的 copy 改造）----

export function byName(records) {
  const map = new Map()
  for (const record of records ?? []) {
    const key = (record.name ?? "").trim()
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(record)
  }
  return map
}

function edit(a, b) {
  if (a === b) return 0
  if (!a.length || !b.length) return Math.max(a.length, b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

export function closest(id, records, nameIndex) {
  const hit = records?.find((record) => record.id === id)
  if (hit) return hit
  let best = null
  let score = Infinity
  for (const record of records ?? []) {
    if (record.kind && id.startsWith(`${record.kind}:`)) {
      const tail = id.slice(record.kind.length + 1)
      const d = edit(record.id.slice(record.kind.length + 1), tail)
      if (d < score) {
        score = d
        best = record
      }
    }
  }
  if (best && score <= 6) return best
  best = null
  score = Infinity
  const query = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id
  for (const [name, group] of nameIndex ?? new Map()) {
    const d = edit(name.toLowerCase(), query.toLowerCase())
    if (d < score && d <= Math.max(3, Math.floor(name.length / 3))) {
      score = d
      best = group[0]
    }
  }
  return best ?? null
}

export function baseName(name) {
  let previous = null
  let current = name
  while (previous !== current) {
    previous = current
    current = current
      .replace(/[（(][^（）()]*[)）]\s*$/, "")
      .replace(/ PART \d+\/\d+.*$/i, "")
      .replace(/ — .*$/, "")
      .replace(/ -- .*$/, "")
      .replace(/#\d+$/, "")
      .trim()
  }
  return current
}

export function byBase(records) {
  const map = new Map()
  for (const record of records ?? []) {
    const key = baseName(record.name ?? "")
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(record)
  }
  return map
}

export function references(value, allowed, records, nameIndex) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) return value.forEach((item) => references(item, allowed, records, nameIndex))
  const baseIndex = byBase(records)
  Object.entries(value).forEach(([key, item]) => {
    if (key === "artifact" && typeof item === "string") references({ evidence: [item] }, allowed, records, nameIndex)
    if (key === "artifacts" && Array.isArray(item) && item.length)
      references({ evidence: item }, allowed, records, nameIndex)
    if (key === "evidence" && Array.isArray(item))
      item.forEach((ref, index) => {
        if (allowed.has(ref)) return
        if (typeof ref === "string" && !ref.includes(":")) {
          const group = nameIndex?.get(ref) ?? nameIndex?.get(ref.trim())
          if (group?.length === 1) {
            item[index] = group[0].id
            return
          }
          const parts = baseIndex.get(ref.trim()) ?? baseIndex.get(baseName(ref))
          if (parts?.length) {
            item.splice(index, 1, ...parts.map((part) => part.id))
            return
          }
        }
        const match = closest(ref, records, nameIndex)
        throw new Error(
          `Unregistered evidence: ${ref}` +
            (match
              ? `; did you mean ${match.id} (name: ${match.name})? Prefer citing the NAME "${match.name}" — names are checked and resolved automatically; if citing the id, copy it exactly.`
              : "; no similar registered asset — cite the asset's NAME from this packet (resolved automatically) or copy an existing id exactly.") +
            ` If the intended source is not registered, first freeze it via loca_source / register it via loca_artifact.`,
        )
      })
    references(item, allowed, records, nameIndex)
  })
}
