import { z } from "zod"

export { z }

const text = z.string().min(1)
const refs = z.array(text)
const proof = z.object({ id: text, reason: text, evidence: refs.min(1) }).strict()
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
  })
  .strict()

export const schemas = {
  contract: z
    .object({
      goal: text,
      criteria: z.array(z.object({ id: text, text, method: text, origin: text }).strict()).min(1),
      removed: z.array(z.object({ id: text, quote: text }).strict()),
      questions: refs,
    })
    .strict(),
  solve: z
    .object({
      status: z.enum(["completed", "working", "blocked"]),
      artifacts: refs,
      claims: z.array(z.object({ id: text, text, artifact: text, criteria: refs, conditions: refs }).strict()),
      criteria: z.array(proof),
      problems: z.array(
        z.object({ id: text, detail: text, status: z.enum(["open", "closed"]), evidence: refs }).strict(),
      ),
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
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    expected.some((id) => !actual.includes(id))
  )
    throw new Error(`${label}: missing, duplicate or unexpected IDs`)
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

export function references(value, allowed) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) return value.forEach((item) => references(item, allowed))
  Object.entries(value).forEach(([key, item]) => {
    if (key === "evidence" && Array.isArray(item))
      item.forEach((id) => {
        if (!allowed.has(id)) throw new Error(`Unregistered evidence: ${id}`)
      })
    references(item, allowed)
  })
}
