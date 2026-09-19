import { z } from "zod"

export { z }

const text = z.string().min(1)
const refs = z.array(text)
const proof = z.object({ id: text, reason: text, evidence: refs.min(1) }).strict()
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
    repair: z.enum(["split", "solve", "human"]),
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
  explore: z
    .object({
      strategy: text,
      subproblems: z
        .array(
          z
            .object({
              id: text,
              goal: text,
              criteria: refs.min(1),
              evidence: refs,
              depends: refs,
            })
            .strict(),
        )
        .min(1)
        .max(6),
      assumptions: z.array(assumption).max(20).optional(),
      reason: text,
    })
    .strict(),
  attack: z
    .object({
      status: z.enum(["completed", "working", "blocked"]),
      artifacts: refs.default([]),
      claims: z.array(z.object({ id: text, text, artifact: text, criteria: refs, conditions: refs }).strict()),
      problems: z.array(
        z.object({ id: text, detail: text, status: z.enum(["open", "closed"]), evidence: refs }).strict(),
      ),
      assumptions: z.array(assumption).max(20).optional(),
      reason: text,
    })
    .strict(),
  assemble: z
    .object({
      status: z.enum(["completed", "working", "blocked"]),
      artifacts: refs.default([]),
      claims: z.array(z.object({ id: text, text, artifact: text, criteria: refs, conditions: refs }).strict()),
      criteria: z.array(proof),
      problems: z.array(
        z.object({ id: text, detail: text, status: z.enum(["open", "closed"]), evidence: refs }).strict(),
      ),
      assumptions: z.array(assumption).max(20).optional(),
      reason: text,
    })
    .strict(),
  split: z
    .object({
      nodes: z
        .array(
          z
            .object({
              id: text,
              type: z.enum(["reference", "reasoning", "computation"]),
              purpose: z.enum(["production", "acceptance"]),
              objective: text,
              criteria: refs,
              claims: refs,
              material: z
                .array(
                  z
                    .object({ asset: text, start: z.number().int().nonnegative(), end: z.number().int().positive() })
                    .strict(),
                )
                .min(1),
              inputs: z.array(z.object({ from: text, port: text, use: text, conditions: refs }).strict()),
              outputs: z.array(z.object({ port: text, claim: text, conditions: refs }).strict()).min(1),
              method: text,
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  validate: z
    .object({
      verdict: z.enum(["pass", "fail", "inconclusive"]),
      criteria: z.array(proof).min(1),
      evidence: refs.min(1),
      findings: z.array(issue),
    })
    .strict(),
  questioner: z
    .object({
      questions: z.array(z.object({ id: text, target: text, question: text, evidence: refs.min(1) }).strict()).min(1),
    })
    .strict(),
  defender: z
    .object({
      answers: z
        .array(
          z
            .object({
              id: text,
              status: z.enum(["defended", "conceded", "needs_input"]),
              answer: text,
              evidence: refs.min(1),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  closing: report
    .extend({
      answers: z.array(
        z
          .object({
            id: text,
            status: z.enum(["resolved", "unresolved", "new_premise"]),
            reason: text,
            evidence: refs.min(1),
          })
          .strict(),
      ),
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
              artifacts: refs.min(1),
              nodes: refs.min(1),
              evidence: refs.min(1),
              scope: text,
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

// Name→id index for self-correcting feedback: models copy ids by shape and
// hallucinate characters; names (semantic, short) survive far better. Build the
// index from asset records passed by the caller so unregistered ids fail with
// ONE actionable candidate instead of a 40-id wall of text.
export function byName(records) {
  const map = new Map()
  for (const record of records ?? []) {
    const key = (record.name ?? "").trim()
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(record)
  }
  return map
}

// Levenshtein distance over names; short ids are also compared directly.
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
  // Try the name embedded in the id or referenced by shape: models often cite
  // "artifact:<name>" or an old name; fuzzy-match against the name index.
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

// Strip annotation suffixes from asset names: registered names are often annotated
// part labels ("proof/00_setup.md（第 1/4 部分：§0–§1.3）"). Models cite the BASE file
// name; the base must map to its parts.
export function baseName(name) {
  // Annotations stack in either order ("… PART 2/2 (rev4: …)" vs "…（第 2/4 部分…）
  // 续篇"): strip trailing annotation layers repeatedly until the name is stable.
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

// Base-name → all parts index: "proof/00_setup.md" → the 4 part records.
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
    // Artifact references are as load-bearing as evidence: a mistyped name here
    // poisons later packet builds, so they get the same self-correcting check.
    if (key === "artifact" && typeof item === "string") references({ evidence: [item] }, allowed, records, nameIndex)
    if (key === "artifacts" && Array.isArray(item) && item.length)
      references({ evidence: item }, allowed, records, nameIndex)
    if (key === "evidence" && Array.isArray(item))
      item.forEach((ref, index) => {
        if (allowed.has(ref)) return
        // NAME-PRIMARY resolution: natural names are the human-legible key. Exact
        // name → id; BASE name (annotation-stripped) → ALL matching parts — a file
        // delivered in parts is still one logical source, and citing the file means
        // citing its complete content.
        if (typeof ref === "string" && !ref.includes(":")) {
          const group = nameIndex?.get(ref) ?? nameIndex?.get(ref.trim())
          if (group?.length === 1) {
            item[index] = group[0].id
            return
          }
          // The cited name may carry ITS own invented annotation ("proof/x.md（四部
          // 分七段…）"): strip the citation the same way as registry names — the
          // base is the stable key.
          const parts = baseIndex.get(ref.trim()) ?? baseIndex.get(baseName(ref))
          if (parts?.length) {
            // Replace the single citation with every part id of the same base name.
            item.splice(index, 1, ...parts.map((part) => part.id))
            return
          }
        }
        // Self-correcting protocol feedback: ONE nearest candidate by id edit
        // distance or asset name, with explicit copy instructions. Long id
        // inventories crowded out the correction signal and reinforced the
        // hallucination across retries.
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
