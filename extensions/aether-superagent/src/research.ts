import path from "node:path"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import type { Input, Ticket } from "./store"

export const stages = ["planning", "research", "deriving", "computing", "verifying", "blocked", "review"] as const
export type Research = {
  objective: string
  stage: typeof stages[number]
  summary: string
  next: string
  blockers: string[]
  milestones: { id: string; title: string; state: "planned" | "active" | "done" }[]
  evidence: { label: string; path: string }[]
  updated: number
  revision: number
  input: string | null
}
export type ResearchEvent = {
  id: number; ticket: string; input: string | null
  kind: "created" | "turn_started" | "progress" | "turn_ended" | "stopped"
  at: number; research: Research
}
export type ReportBinding = { root: string; dev: number; ino: number }

export function initialResearch(objective: string): Research {
  return { objective, stage: "planning", summary: "尚无 worker 进展报告。", next: "等待执行并建立研究计划。",
    blockers: [], milestones: [], evidence: [], updated: Date.now(), revision: 0, input: null }
}

export function reportPath(ticket: Ticket, input: Input) {
  if (!/^[a-zA-Z0-9_]+$/.test(input.id)) throw new Error("Invalid report input id.")
  return path.join(ticket.directory, `.aether-superagent-progress-${input.id}.json`)
}

export async function bindReport(ticket: Ticket): Promise<ReportBinding> {
  const info = await lstat(ticket.directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Worker directory must not be a symbolic link.")
  return { root: await realpath(ticket.directory), dev: info.dev, ino: info.ino }
}

function string(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw new Error(`Invalid research ${field}.`)
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a research object.")
  return value as Record<string, unknown>
}

// Validate observations only. Evidence paths are never opened or executed.
export function parseReport(value: unknown, ticket: Ticket, input: Input, previous: Research): Research {
  const report = object(value)
  if (report.ticket !== ticket.id || report.input !== input.id || previous.input !== input.id)
    throw new Error("Research report belongs to another run.")
  if (!Number.isSafeInteger(report.revision) || (report.revision as number) <= previous.revision)
    throw new Error("Research revision must increase.")
  if (!stages.includes(report.stage as Research["stage"])) throw new Error("Invalid research stage.")
  if (!Array.isArray(report.blockers) || report.blockers.length > 30 || !Array.isArray(report.milestones) ||
    report.milestones.length > 100 || !Array.isArray(report.evidence) || report.evidence.length > 100)
    throw new Error("Invalid research lists.")
  const milestones = report.milestones.map((value) => {
    const item = object(value)
    if (!["planned", "active", "done"].includes(String(item.state))) throw new Error("Invalid milestone state.")
    return { id: string(item.id, "milestone id", 100), title: string(item.title, "milestone title", 1000),
      state: item.state as "planned" | "active" | "done" }
  })
  if (new Set(milestones.map((item) => item.id)).size !== milestones.length) throw new Error("Duplicate milestone id.")
  const evidence = report.evidence.map((value) => {
    const item = object(value)
    return { label: string(item.label, "evidence label", 1000), path: string(item.path, "evidence path", 2000) }
  })
  const blockers = report.blockers.map((value) => string(value, "blocker", 2000))
  if (report.stage === "review" && (blockers.length || !evidence.length || !milestones.length || milestones.some((item) => item.state !== "done")))
    throw new Error("Review needs evidence, completed milestones and no blockers; it is not scientific acceptance.")
  return { objective: string(report.objective, "objective", 100_000), stage: report.stage as Research["stage"],
    summary: string(report.summary, "summary", 12_000), next: string(report.next, "next", 4000, true),
    blockers, milestones, evidence, updated: Date.now(), revision: report.revision as number, input: input.id }
}

export async function readReport(ticket: Ticket, input: Input, binding: ReportBinding): Promise<unknown> {
  const current = await bindReport(ticket)
  if (current.root !== binding.root || current.dev !== binding.dev || current.ino !== binding.ino)
    throw new Error("Worker report directory changed.")
  const file = path.join(binding.root, path.basename(reportPath(ticket, input)))
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 262144) throw new Error("Research report must be a regular file of at most 256 KiB.")
    const buffer = Buffer.alloc(262145)
    let length = 0
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, length)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    if (length > 262144) throw new Error("Research report is too large.")
    const after = await bindReport(ticket)
    if (after.root !== binding.root || after.dev !== binding.dev || after.ino !== binding.ino || await realpath(file) !== file)
      throw new Error("Research report path changed.")
    return JSON.parse(buffer.subarray(0, length).toString("utf8"))
  } finally { await handle.close() }
}

export function workerPrompt(ticket: Ticket, input: Input, research: Research) {
  const report = { ticket: ticket.id, input: input.id, revision: research.revision + 1,
    objective: research.objective, stage: research.stage, summary: research.summary, next: research.next,
    blockers: research.blockers, milestones: research.milestones, evidence: research.evidence }
  return [
    input.text,
    "Respect the user's action scope. An inspection or status-report request is read-only for the target materials: inspect existing files and evidence, do not edit them, start/restart computations, install software, or change jobs unless explicitly requested. The progress report file below is a separate coordinator record you should write. Report access limitations instead of claiming you inspected unavailable sources.",
    "Research workbench progress protocol (report observations, not claims of acceptance):",
    `SUPERAGENT_PROGRESS: ${JSON.stringify({ path: reportPath(ticket, input), ticket: ticket.id, input: input.id, revision: report.revision, snapshot: report })}`,
    "Use your write tool to write a complete JSON object to exactly the progress path above, early and whenever the stage, plan, blocker or evidence changes. Do not wait until your final answer. Write only this run's file; do not commit it. No API credentials are needed.",
    `Required JSON fields and starting example: ${JSON.stringify(report)}`,
    `stage must be one of ${stages.join(", ")}. revision must be an increasing integer (start at the supplied revision, then increment for each report). ticket/input must remain exactly as supplied.`,
    "milestones is an array of {id,title,state}, state planned|active|done, with unique IDs. evidence is an array of {label,path}; cite actual artifacts or checks. blockers is an array of strings. Keep objective, summary and next concise and explicit.",
    "Use review only when all listed milestones are done, at least one evidence item exists and blockers are empty. Review means awaiting human scientific review, never automatic proof of correctness. A turn ending does not complete the scientific task. Preserve uncertainty and state what remains to verify.",
  ].join("\n\n")
}
