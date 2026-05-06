import path from "path"
import fs from "fs/promises"
import { createHash } from "node:crypto"
import z from "zod"
import { ulid } from "ulid"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"

function norm(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function key(input: string) {
  return createHash("sha1").update(input).digest("hex").slice(0, 32)
}

export namespace InboxIdentity {
  export const Scope = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }),
    z.object({ kind: z.literal("project"), id: z.string().min(1) }),
    z.object({ kind: z.literal("workspace"), id: z.string().min(1) }),
  ])
  export type Scope = z.infer<typeof Scope>

  export const LiveScope = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }),
    z.object({ kind: z.literal("project"), id: z.string().min(1) }),
    z.object({ kind: z.literal("workspace"), id: z.string().min(1) }),
    z.object({ kind: z.literal("session"), id: z.string().min(1) }),
  ])
  export type LiveScope = z.infer<typeof LiveScope>

  export const SalienceHint = z.enum(["normal", "important", "critical"])
  export type SalienceHint = z.infer<typeof SalienceHint>

  export function stable(input: string) {
    return key(input)
  }

  export function normalize(input: string) {
    return norm(input).toLowerCase()
  }

  export function canonical(input: { scope: Scope; store: "user" | "memory"; text: string }) {
    const scope =
      input.scope.kind === "global" ? "global" : `${input.scope.kind}:${InboxIdentity.normalize(input.scope.id)}`
    return key([scope, input.store, InboxIdentity.normalize(input.text)].join("\n"))
  }

  export function origin(input: { session_id: string; text: string; source?: string }) {
    return key([input.source ?? "live_write", input.session_id, InboxIdentity.normalize(input.text)].join("\n"))
  }

  export function id(input: { canonical_key: string }) {
    return key(`inbox:${input.canonical_key}`)
  }
}

const ScopeSchema = InboxIdentity.Scope
export const InboxEntrySchema = z
  .object({
    id: z.string(),
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    scope: ScopeSchema,
    text: z.string(),
    summary: z.string().optional(),
    intended_store: z.enum(["user", "memory"]),
    status: z.enum(["pending", "promoted_user", "promoted_daily", "merged", "rejected", "stale"]),
    salience_hint: InboxIdentity.SalienceHint,
    salience_reason: z.string().optional(),
    selected_count: z.number().int().nonnegative(),
    pin_count: z.number().int().nonnegative(),
    source_count: z.number().int().nonnegative(),
    canonical_key: z.string(),
    origin_key: z.string(),
    memory_id: z.string().optional(),
    selected_sessions: z.array(z.string()).default([]),
    pinned_sessions: z.array(z.string()).default([]),
    last_selected_at: z.number().int().nonnegative().optional(),
    last_pin_at: z.number().int().nonnegative().optional(),
    provenance: z.array(z.record(z.string(), z.unknown())).default([]),
    reflection: z
      .object({
        run_id: z.string(),
        decision: z.string(),
        reason: z.string().optional(),
        at: z.number(),
      })
      .optional(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .passthrough()
export type InboxEntry = z.infer<typeof InboxEntrySchema>

export type Decision = {
  id: string
  revision?: number
  decision: "promote_to_user" | "promote_to_daily" | "merge_with_existing" | "reject_or_stale" | "keep_pending"
  reason?: string
}

const queue = new Map<string, Promise<void>>()

export namespace InboxStore {
  export type Entry = InboxEntry
  export type Scope = InboxIdentity.Scope

  function root() {
    return path.join(Global.Path.data, "memory", "inbox")
  }

  function bucket(scope: Scope) {
    if (scope.kind === "global") return path.join(root(), "global")
    return path.join(root(), scope.kind, scope.id)
  }

  function file(scope: Scope, id: string) {
    return path.join(bucket(scope), `${id}.json`)
  }

  function label(scope: Scope) {
    if (scope.kind === "global") return "global"
    return `${scope.kind}:${scope.id}`
  }

  async function guard<T>(scope: Scope, fn: () => Promise<T>) {
    const id = label(scope)
    const prev = queue.get(id) ?? Promise.resolve()
    const task = prev.then(fn, fn)
    queue.set(
      id,
      task.then(
        () => undefined,
        () => undefined,
      ),
    )
    return task
  }

  async function read(file: string) {
    const raw = await Filesystem.readJson<unknown>(file).catch(() => undefined)
    const parsed = InboxEntrySchema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  async function write(entry: Entry) {
    await Filesystem.writeJson(file(entry.scope, entry.id), entry)
  }

  async function walk(dir: string): Promise<string[]> {
    const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const nested = await Promise.all(
      rows.map(async (row) => {
        const next = path.join(dir, row.name)
        if (row.isDirectory()) return walk(next)
        if (row.isFile() && row.name.endsWith(".json")) return [next]
        return []
      }),
    )
    return nested.flat().sort()
  }

  export function visible(entry: { scope: Scope }, scope: { project_id?: string; workspace_id?: string }) {
    if (entry.scope.kind === "global") return true
    if (entry.scope.kind === "project") return entry.scope.id === scope.project_id
    return entry.scope.id === scope.workspace_id
  }

  export async function upsert(input: {
    scope: Scope
    session_id: string
    text: string
    intended_store: "user" | "memory"
    salience_hint?: InboxIdentity.SalienceHint
    salience_reason?: string
    origin_key?: string
    provenance?: Record<string, unknown>
  }) {
    return guard(input.scope, async () => {
      const canonical = InboxIdentity.canonical({
        scope: input.scope,
        store: input.intended_store,
        text: input.text,
      })
      const id = InboxIdentity.id({ canonical_key: canonical })
      const origin = input.origin_key ?? InboxIdentity.origin({ session_id: input.session_id, text: input.text })
      const now = Date.now()
      const prev = await read(file(input.scope, id))
      const provenance = [
        ...(prev?.provenance ?? []),
        {
          source: "live_write",
          session_id: input.session_id,
          origin_key: origin,
          at: now,
          ...(input.provenance ?? {}),
        },
      ]
      const origins = new Set(provenance.map((item) => String(item.origin_key ?? "")).filter(Boolean))
      const entry: Entry = {
        id,
        version: 1,
        revision: (prev?.revision ?? 0) + 1,
        scope: input.scope,
        text: prev?.text ?? input.text,
        summary: prev?.summary ?? input.text,
        intended_store: input.intended_store,
        status: "pending",
        salience_hint: input.salience_hint ?? prev?.salience_hint ?? "normal",
        ...(input.salience_reason || prev?.salience_reason
          ? { salience_reason: input.salience_reason ?? prev?.salience_reason }
          : {}),
        selected_count: prev?.selected_count ?? 0,
        pin_count: prev?.pin_count ?? 0,
        source_count: Math.max(1, origins.size || prev?.source_count || 1),
        canonical_key: canonical,
        origin_key: prev?.origin_key ?? origin,
        memory_id: prev?.memory_id,
        selected_sessions: prev?.selected_sessions ?? [],
        pinned_sessions: prev?.pinned_sessions ?? [],
        last_selected_at: prev?.last_selected_at,
        last_pin_at: prev?.last_pin_at,
        provenance,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      }
      await write(entry)
      return entry
    })
  }

  export async function all() {
    return (
      await Promise.all(
        (await walk(root())).map(async (item) => {
          return read(item)
        }),
      )
    )
      .filter((item): item is Entry => Boolean(item))
      .toSorted((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  }

  export async function listVisible(scope: { project_id?: string; workspace_id?: string }) {
    return (await all()).filter((entry) => entry.status === "pending" && visible(entry, scope))
  }

  export async function listForReflection(input: {
    scope: "current_session" | "current_scope" | "global"
    project_id?: string
    workspace_id?: string
  }) {
    if (input.scope === "current_session") return []
    const items = (await all()).filter((entry) => entry.status === "pending")
    if (input.scope === "global") return items
    return items.filter((entry) => visible(entry, input))
  }

  async function bump(input: { entry: Entry; session_id: string; kind: "selected" | "pinned" }) {
    return guard(input.entry.scope, async () => {
      const current = await read(file(input.entry.scope, input.entry.id))
      if (!current || current.status !== "pending") return
      const now = Date.now()
      if (input.kind === "selected") {
        const sessions = new Set(current.selected_sessions)
        if (sessions.has(input.session_id)) return
        sessions.add(input.session_id)
        await write({
          ...current,
          revision: current.revision + 1,
          selected_count: current.selected_count + 1,
          selected_sessions: [...sessions].sort(),
          last_selected_at: now,
          updated_at: now,
        })
        return
      }
      const sessions = new Set(current.pinned_sessions)
      if (sessions.has(input.session_id)) return
      sessions.add(input.session_id)
      await write({
        ...current,
        revision: current.revision + 1,
        pin_count: current.pin_count + 1,
        pinned_sessions: [...sessions].sort(),
        last_pin_at: now,
        updated_at: now,
      })
    }).catch(() => undefined)
  }

  export async function bumpSelected(input: { entries: Entry[]; session_id: string }) {
    await Promise.all(input.entries.map((entry) => bump({ entry, session_id: input.session_id, kind: "selected" })))
  }

  export async function bumpPinned(input: { entries: Entry[]; session_id: string }) {
    await Promise.all(input.entries.map((entry) => bump({ entry, session_id: input.session_id, kind: "pinned" })))
  }

  export async function apply(input: { run_id: string; decisions: Decision[] }) {
    const by = new Map((await all()).map((entry) => [entry.id, entry]))
    const applied: Array<{ id: string; decision: Decision["decision"] }> = []
    const skipped: Array<{ id: string; reason: string }> = []
    for (const decision of input.decisions) {
      const entry = by.get(decision.id)
      if (!entry) {
        skipped.push({ id: decision.id, reason: "missing" })
        continue
      }
      if (decision.decision === "keep_pending") {
        skipped.push({ id: decision.id, reason: "keep_pending" })
        continue
      }
      if (decision.revision !== undefined && decision.revision !== entry.revision) {
        skipped.push({ id: decision.id, reason: "revision_conflict" })
        continue
      }
      const status =
        decision.decision === "promote_to_user"
          ? "promoted_user"
          : decision.decision === "promote_to_daily"
            ? "promoted_daily"
            : decision.decision === "merge_with_existing"
              ? "merged"
              : "stale"
      const ok = await guard(entry.scope, async () => {
        const current = await read(file(entry.scope, entry.id))
        if (!current) return false
        if (decision.revision !== undefined && decision.revision !== current.revision) {
          skipped.push({ id: decision.id, reason: "revision_conflict" })
          return false
        }
        await write({
          ...current,
          status,
          revision: current.revision + 1,
          updated_at: Date.now(),
          reflection: {
            run_id: input.run_id,
            decision: decision.decision,
            ...(decision.reason ? { reason: decision.reason } : {}),
            at: Date.now(),
          },
        })
        return true
      })
      if (ok) applied.push({ id: decision.id, decision: decision.decision })
    }
    return { applied, skipped }
  }

  export async function resetForTest() {
    await fs.rm(root(), { recursive: true, force: true }).catch(() => {})
  }
}
