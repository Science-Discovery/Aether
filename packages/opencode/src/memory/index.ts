import path from "path"
import { createHash } from "node:crypto"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { Filesystem } from "@/util/filesystem"
import { Database, and, asc, count, eq, inArray, isNull } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Storage } from "@/storage/storage"

const STORE_LIMIT = {
  user: 12_000,
  memory: 12_000,
} as const

const ITEM_LIMIT = {
  user: 200,
  memory: 300,
} as const

const USER_TYPES = new Set(["style", "workflow", "preference", "constraint", "capability"])
const USER_SOURCES = new Set(["explicit", "inferred"])
const INFERRED_TYPES = new Set(["style", "preference", "capability"])

type ParsedUserEntry = {
  type: "style" | "workflow" | "preference" | "constraint" | "capability"
  source: "explicit" | "inferred"
  content: string
  canonical: string
}

function norm(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function clip(input: string, max: number) {
  if (input.length <= max) return input
  return input.slice(0, max).trimEnd()
}

function tokenize(input: string) {
  return norm(input)
    .toLowerCase()
    .split(/[\s,;:.!?()[\]{}"']+/)
    .filter(Boolean)
}

function similar(a: string, b: string) {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (!ta.size || !tb.size) return false
  let same = 0
  for (const token of ta) {
    if (tb.has(token)) same++
  }
  return same / Math.max(ta.size, tb.size) >= 0.75
}

function receiptMark(input: unknown) {
  return input === 1 || input === "1" || input === true || input === "true"
}

function parseBulletEntries(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1])
    .filter((line): line is string => Boolean(line))
    .map((line) => norm(line))
    .filter(Boolean)
}

function parseUserEntry(rawInput: string, options?: { allowInferredWrite?: boolean }) {
  const raw = norm(rawInput).replace(/^-+\s*/, "")
  const match = raw.match(/^([a-zA-Z_]+)\[([a-zA-Z_]+)\]:\s*(.+)$/)
  if (!match) {
    return { ok: false as const, reason: "invalid_user_format", detail: "Entry must follow type[source]: content" }
  }
  const type = match[1].toLowerCase()
  const source = match[2].toLowerCase()
  const content = norm(match[3])

  if (!USER_TYPES.has(type)) {
    return { ok: false as const, reason: "invalid_user_type", detail: `Unknown user profile type: ${type}` }
  }
  if (!USER_SOURCES.has(source)) {
    return { ok: false as const, reason: "invalid_user_source", detail: `Unknown user profile source: ${source}` }
  }
  if (!content) {
    return { ok: false as const, reason: "invalid_user_content", detail: "User profile content is empty" }
  }
  if (options?.allowInferredWrite === false && source === "inferred") {
    return {
      ok: false as const,
      reason: "inferred_disabled",
      detail: "Inferred profile is disabled by settings",
    }
  }
  if (source === "inferred" && !INFERRED_TYPES.has(type)) {
    return {
      ok: false as const,
      reason: "invalid_inferred_type",
      detail: "Only style/preference/capability support inferred source",
    }
  }

  const canonical = `${type}[${source}]: ${clip(content, ITEM_LIMIT.user)}`
  return {
    ok: true as const,
    entry: {
      type: type as ParsedUserEntry["type"],
      source: source as ParsedUserEntry["source"],
      content: clip(content, ITEM_LIMIT.user),
      canonical,
    },
  }
}

function normalizeMemoryEntry(rawInput: string) {
  const line = norm(rawInput).replace(/^-+\s*/, "")
  if (!line) return ""
  return clip(line, ITEM_LIMIT.memory)
}

function serializeStore(store: "user" | "memory", entries: string[]) {
  const title = store === "user" ? "# USER" : "# MEMORY"
  if (!entries.length) return `${title}\n`
  return `${title}\n${entries.map((line) => `- ${line}`).join("\n")}\n`
}

function usage(entries: string[]) {
  return entries.join("\n").length
}

function scopeKey() {
  const workspaceID = WorkspaceContext.workspaceID
  if (workspaceID) return `workspace-${workspaceID}`
  if (Instance.project.id !== ProjectID.global) return `project-${Instance.project.id}`
  const digest = createHash("sha1").update(Filesystem.resolve(Instance.directory)).digest("hex").slice(0, 20)
  return `directory-${digest}`
}

function memoryPath(store: "user" | "memory") {
  if (store === "user") return path.join(Global.Path.data, "memory", "user", "USER.md")
  return path.join(Global.Path.data, "memory", "scope", scopeKey(), "MEMORY.md")
}

function sessionScopeFilter(scope: "current_project" | "global") {
  if (scope !== "current_project") {
    return {
      sql: "",
      args: [] as string[],
      match: (_session: { project_id: string; workspace_id: string | null; directory: string }) => true,
    }
  }

  const workspaceID = WorkspaceContext.workspaceID
  if (workspaceID) {
    return {
      sql: "and s.workspace_id = ?",
      args: [workspaceID],
      match: (session: { project_id: string; workspace_id: string | null; directory: string }) =>
        session.workspace_id === workspaceID,
    }
  }

  if (Instance.project.id !== ProjectID.global) {
    return {
      sql: "and s.project_id = ?",
      args: [Instance.project.id],
      match: (session: { project_id: string; workspace_id: string | null; directory: string }) =>
        session.project_id === Instance.project.id,
    }
  }

  const directory = Filesystem.resolve(Instance.directory)
  return {
    sql: "and s.project_id = ? and s.directory = ?",
    args: [ProjectID.global, directory],
    match: (session: { project_id: string; workspace_id: string | null; directory: string }) =>
      session.project_id === ProjectID.global && Filesystem.resolve(session.directory) === directory,
  }
}

type LoadedUser = {
  file: string
  validEntries: string[]
  invalidEntries: string[]
  parsedEntries: ParsedUserEntry[]
}

async function loadUserRaw(): Promise<LoadedUser> {
  const file = memoryPath("user")
  const text = await Filesystem.readText(file).catch(() => "")
  const bullets = parseBulletEntries(text)
  const validEntries: string[] = []
  const invalidEntries: string[] = []
  const parsedEntries: ParsedUserEntry[] = []

  for (const raw of bullets) {
    const parsed = parseUserEntry(raw)
    if (!parsed.ok) {
      invalidEntries.push(raw)
      continue
    }
    validEntries.push(parsed.entry.canonical)
    parsedEntries.push(parsed.entry)
  }

  return { file, validEntries, invalidEntries, parsedEntries }
}

async function loadMemoryRaw() {
  const file = memoryPath("memory")
  const text = await Filesystem.readText(file).catch(() => "")
  const entries = parseBulletEntries(text).map(normalizeMemoryEntry).filter(Boolean)
  return { file, entries }
}

function scanRisk(input: string):
  | {
      kind: "prompt_injection" | "secret" | "exfiltration" | "invisible_chars"
      hit: string
    }
  | undefined {
  const rules: Array<{ kind: "prompt_injection" | "secret" | "exfiltration" | "invisible_chars"; test: RegExp }> = [
    { kind: "invisible_chars", test: /[\u200b-\u200f\u2060\ufeff]/u },
    { kind: "prompt_injection", test: /\b(ignore|disregard|override).{0,24}\b(instruction|system|policy|rule)s?\b/i },
    { kind: "secret", test: /\b(sk-[a-z0-9]{20,}|api[_-]?key|access[_-]?token|-----begin [a-z ]*private key-----)\b/i },
    { kind: "exfiltration", test: /\b(cat|scp|curl|wget).{0,30}(\.env|id_rsa|credentials|token|secret)\b/i },
  ]
  for (const rule of rules) {
    const hit = input.match(rule.test)?.[0]
    if (hit) return { kind: rule.kind, hit: clip(hit, 80) }
  }
  return
}

function classifyEvent(event: { action: string; blocked?: boolean }) {
  return event.blocked || event.action === "block" ? "failure" : "success"
}

function splitUserEntries(entries: string[]) {
  const explicit: string[] = []
  const inferred: string[] = []
  for (const line of entries) {
    const parsed = parseUserEntry(line)
    if (!parsed.ok) continue
    if (parsed.entry.source === "explicit") explicit.push(parsed.entry.canonical)
    else inferred.push(parsed.entry.canonical)
  }
  return { explicit, inferred }
}

function normalizeInvalidUserEntry(raw: string) {
  const text = norm(raw)
  if (!text) return undefined

  if (/(workflow|流程|步骤|先|然后|before|after|确认)/i.test(text)) {
    return `workflow[explicit]: ${clip(text, ITEM_LIMIT.user)}`
  }
  if (/(不要|must not|never|forbid|禁止|约束|constraint)/i.test(text)) {
    return `constraint[explicit]: ${clip(text, ITEM_LIMIT.user)}`
  }
  if (/(熟悉|不熟|capability|skill|expert|novice|能力)/i.test(text)) {
    return `capability[explicit]: ${clip(text, ITEM_LIMIT.user)}`
  }
  if (/(中文|english|tone|style|简洁|详细|format|先结论|风格)/i.test(text)) {
    return `style[explicit]: ${clip(text, ITEM_LIMIT.user)}`
  }
  return `preference[explicit]: ${clip(text, ITEM_LIMIT.user)}`
}

function mergeUserEntries(a: string, b: string) {
  const pa = parseUserEntry(a)
  const pb = parseUserEntry(b)
  if (!pa.ok || !pb.ok) return undefined
  if (pa.entry.type !== pb.entry.type) return undefined
  if (pa.entry.source !== pb.entry.source) return undefined
  const content = clip(norm(`${pa.entry.content}; ${pb.entry.content}`), ITEM_LIMIT.user)
  return `${pa.entry.type}[${pa.entry.source}]: ${content}`
}

function reflectEntries(
  store: "user" | "memory",
  inputEntries: string[],
  invalidEntries: string[],
  mode: "light" | "strong",
) {
  const events: Array<{
    store: "user" | "memory"
    action: "merge" | "compact" | "remove" | "block"
    reason: string
    summary: string
    blocked?: boolean
  }> = []

  let entries = [...inputEntries]

  if (store === "user" && invalidEntries.length > 0) {
    for (const invalid of invalidEntries) {
      const normalized = normalizeInvalidUserEntry(invalid)
      if (!normalized) {
        events.push({
          store,
          action: "remove",
          reason: "invalid_user_entry_removed",
          summary: "Removed invalid USER profile entry during reflection",
        })
        continue
      }
      entries.push(normalized)
      events.push({
        store,
        action: "compact",
        reason: "invalid_user_entry_normalized",
        summary: normalized,
      })
    }
  }

  const seen = new Set<string>()
  const deduped: string[] = []
  for (const item of entries) {
    const normalized = store === "user" ? item : normalizeMemoryEntry(item)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(normalized)
  }
  entries = deduped

  if (mode === "strong") {
    const merged: string[] = []
    for (const item of entries) {
      const idx = merged.findIndex((other) => {
        if (store === "user") {
          const lhs = parseUserEntry(other)
          const rhs = parseUserEntry(item)
          if (!lhs.ok || !rhs.ok) return false
          if (lhs.entry.type !== rhs.entry.type || lhs.entry.source !== rhs.entry.source) return false
          return similar(lhs.entry.content, rhs.entry.content)
        }
        return similar(other, item)
      })

      if (idx < 0) {
        merged.push(item)
        continue
      }

      if (store === "user") {
        const next = mergeUserEntries(merged[idx]!, item)
        if (next) {
          merged[idx] = next
          events.push({
            store,
            action: "merge",
            reason: "strong_reflection_merge",
            summary: next,
          })
          continue
        }
      }

      const mergedValue = clip(norm(`${merged[idx]}; ${item}`), ITEM_LIMIT[store])
      merged[idx] = mergedValue
      events.push({
        store,
        action: "merge",
        reason: "strong_reflection_merge",
        summary: mergedValue,
      })
    }
    entries = merged
  }

  let used = usage(entries)
  while (mode === "strong" && used > STORE_LIMIT[store] && entries.length > 0) {
    if (store === "user") {
      let changed = false
      entries = entries.map((line) => {
        const parsed = parseUserEntry(line)
        if (!parsed.ok) return line
        if (parsed.entry.content.length <= 80) return line
        changed = true
        const content = clip(parsed.entry.content, parsed.entry.content.length - 20)
        return `${parsed.entry.type}[${parsed.entry.source}]: ${content}`
      })
      if (!changed) break
    } else {
      let changed = false
      entries = entries.map((line) => {
        if (line.length <= 120) return line
        changed = true
        return clip(line, line.length - 30)
      })
      if (!changed) break
    }
    events.push({
      store,
      action: "compact",
      reason: "strong_reflection_shrink",
      summary: "Compacted entries to satisfy store capacity",
    })
    used = usage(entries)
  }

  if (used > STORE_LIMIT[store]) {
    return {
      ok: false as const,
      entries: inputEntries,
      events: [
        ...events,
        {
          store,
          action: "block" as const,
          reason: "capacity_limit",
          summary: `${store.toUpperCase()} store is full after strong reflection`,
          blocked: true,
        },
      ],
    }
  }

  return { ok: true as const, entries, events }
}

export namespace Memory {
  export const Store = z.enum(["user", "memory"])
  export type Store = z.infer<typeof Store>

  export const Scope = z.enum(["current_project", "global"])
  export type Scope = z.infer<typeof Scope>

  export const Action = z.enum(["add", "replace", "remove", "merge", "compact", "block", "noop"])
  export type Action = z.infer<typeof Action>

  export const Settings = z.object({
    cross_session_search_enabled: z.boolean(),
    cross_session_search_scope: Scope,
    memory_reflection_enabled: z.boolean(),
    user_profile_enabled: z.boolean(),
    user_profile_include_inferred: z.boolean(),
  })
  export type Settings = z.infer<typeof Settings>

  export const Event = z.object({
    store: Store,
    action: Action,
    reason: z.string(),
    summary: z.string(),
    detail: z.string().optional(),
    blocked: z.boolean().optional(),
  })
  export type Event = z.infer<typeof Event>

  export const ReadStore = z.object({
    store: Store,
    enabled: z.boolean(),
    file: z.string(),
    limit: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    usage: z.number(),
    entries: z.array(z.string()),
    explicit_entries: z.array(z.string()).optional(),
    inferred_entries: z.array(z.string()).optional(),
    invalid_entries: z.number().int().nonnegative().optional(),
  })
  export type ReadStore = z.infer<typeof ReadStore>

  export const SearchHit = z.object({
    session_id: z.string(),
    title: z.string(),
    updated_at: z.number(),
    summary: z.string(),
    snippets: z.array(z.string()),
    hits: z.number().int().nonnegative(),
  })
  export type SearchHit = z.infer<typeof SearchHit>

  export const SessionPage = z.object({
    session_id: z.string(),
    title: z.string(),
    page: z.number().int().positive(),
    page_size: z.number().int().positive(),
    has_more: z.boolean(),
    next_page: z.number().int().positive().nullable(),
    total_messages: z.number().int().nonnegative(),
    messages: z.array(
      z.object({
        id: z.string(),
        role: z.string(),
        created_at: z.number().int().nonnegative(),
        parts: z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            data: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    ),
  })
  export type SessionPage = z.infer<typeof SessionPage>

  export const WriteReason = z.enum(["reflection", "manual", "auto_write"])
  export type WriteReason = z.infer<typeof WriteReason>

  const liveEvents = Instance.state(() => new Map<string, Event[]>(), async (map) => map.clear())
  const frozenSnapshots = Instance.state(
    () =>
      new Map<
        string,
        {
          created_at: number
          prompt: string
          user: string[]
          memory: string[]
          scope_key: string
        }
      >(),
    async (map) => map.clear(),
  )
  const readGrant = Instance.state(
    () =>
      new Map<
        string,
        {
          user_message_id: string
          target_session_id: string
          granted_at: number
        }
      >(),
    async (map) => map.clear(),
  )

  function enqueueEvents(sessionID: string, events: Event[]) {
    if (!events.length) return
    const queue = liveEvents()
    const current = queue.get(sessionID) ?? []
    current.push(...events)
    queue.set(sessionID, current)
  }

  export function enqueue(sessionID: string, events: Event[]) {
    enqueueEvents(sessionID, events)
  }

  export function flush(sessionID: string) {
    const queue = liveEvents()
    const events = queue.get(sessionID) ?? []
    queue.delete(sessionID)
    return events
  }

  export async function settings() {
    const cfg = await Config.get()
    const source = cfg.memory ?? {}
    return {
      cross_session_search_enabled: source.cross_session_search_enabled ?? true,
      cross_session_search_scope: source.cross_session_search_scope ?? "current_project",
      memory_reflection_enabled: source.memory_reflection_enabled ?? true,
      user_profile_enabled: source.user_profile_enabled ?? true,
      user_profile_include_inferred: source.user_profile_include_inferred ?? true,
    } satisfies Settings
  }

  async function saveStore(store: Store, entries: string[]) {
    await Filesystem.write(memoryPath(store), serializeStore(store, entries))
  }

  async function readUserStore(current: Settings): Promise<ReadStore> {
    const loaded = await loadUserRaw()
    if (!current.user_profile_enabled) {
      return {
        store: "user",
        enabled: false,
        file: loaded.file,
        entries: [],
        used: 0,
        limit: STORE_LIMIT.user,
        usage: 0,
      }
    }
    const grouped = splitUserEntries(loaded.validEntries)
    const used = usage(loaded.validEntries)
    return {
      store: "user",
      enabled: true,
      file: loaded.file,
      entries: loaded.validEntries,
      used,
      limit: STORE_LIMIT.user,
      usage: used / STORE_LIMIT.user,
      explicit_entries: grouped.explicit,
      inferred_entries: grouped.inferred,
      invalid_entries: loaded.invalidEntries.length,
    }
  }

  async function readMemoryStore(): Promise<ReadStore> {
    const loaded = await loadMemoryRaw()
    const used = usage(loaded.entries)
    return {
      store: "memory",
      enabled: true,
      file: loaded.file,
      entries: loaded.entries,
      used,
      limit: STORE_LIMIT.memory,
      usage: used / STORE_LIMIT.memory,
    }
  }

  export async function read(store: Store) {
    const current = await settings()
    if (store === "user") return readUserStore(current)
    return readMemoryStore()
  }

  export async function list() {
    const current = await settings()
    const [user, memory] = await Promise.all([readUserStore(current), readMemoryStore()])
    return { user, memory }
  }

  export async function search(input: { query: string; store?: Store; limit?: number }) {
    const query = norm(input.query).toLowerCase()
    const max = Math.max(1, Math.min(20, input.limit ?? 10))
    if (!query) return [] as Array<{ store: Store; index: number; text: string }>
    const stores = input.store ? [input.store] : (["memory", "user"] as Store[])
    const all = await Promise.all(stores.map((store) => read(store)))
    const hits: Array<{ store: Store; index: number; text: string }> = []
    for (const store of all) {
      if (!store.enabled) continue
      store.entries.forEach((text, index) => {
        if (text.toLowerCase().includes(query)) hits.push({ store: store.store, index: index + 1, text })
      })
    }
    return hits.slice(0, max)
  }

  export async function write(input: {
    session_id: string
    store: Store
    action: "add" | "replace" | "remove"
    value?: string
    index?: number
    match?: string
    reason?: WriteReason
  }) {
    const current = await settings()
    if (input.store === "user" && !current.user_profile_enabled) {
      const blocked: Event = {
        store: "user",
        action: "block",
        reason: "profile_disabled",
        summary: "User profile is disabled",
        blocked: true,
      }
      enqueueEvents(input.session_id, [blocked])
      return { ok: false as const, events: [blocked] }
    }

    const events: Event[] = []
    const reason: WriteReason = input.reason ?? "auto_write"
    const normalizedMatch = input.match ? norm(input.match).toLowerCase() : undefined

    const loadedUser = input.store === "user" ? await loadUserRaw() : undefined
    const loadedMemory = input.store === "memory" ? await loadMemoryRaw() : undefined
    const baseEntries = input.store === "user" ? [...(loadedUser?.validEntries ?? [])] : [...(loadedMemory?.entries ?? [])]
    const before = JSON.stringify(baseEntries)

    let normalizedValue: string | undefined
    if (input.action !== "remove") {
      if (!input.value || !norm(input.value)) {
        const blocked: Event = {
          store: input.store,
          action: "block",
          reason: "invalid_write",
          summary: "Write blocked: empty memory content",
          blocked: true,
        }
        enqueueEvents(input.session_id, [blocked])
        return { ok: false as const, events: [blocked] }
      }
      const risk = scanRisk(input.value)
      if (risk) {
        const blocked: Event = {
          store: input.store,
          action: "block",
          reason: `safety_${risk.kind}`,
          summary: `Blocked unsafe memory write (${risk.kind})`,
          detail: risk.hit,
          blocked: true,
        }
        enqueueEvents(input.session_id, [blocked])
        return { ok: false as const, events: [blocked] }
      }

      if (input.store === "user") {
        const parsed = parseUserEntry(input.value, { allowInferredWrite: current.user_profile_include_inferred })
        if (!parsed.ok) {
          const blocked: Event = {
            store: "user",
            action: "block",
            reason: parsed.reason,
            summary: parsed.detail,
            blocked: true,
          }
          enqueueEvents(input.session_id, [blocked])
          return { ok: false as const, events: [blocked] }
        }
        normalizedValue = parsed.entry.canonical
      } else {
        normalizedValue = normalizeMemoryEntry(input.value)
      }
    }

    const findIndex = () => {
      if (typeof input.index === "number") return input.index - 1
      if (!normalizedMatch) return -1
      return baseEntries.findIndex((entry) => entry.toLowerCase().includes(normalizedMatch))
    }

    if (input.action === "add" && normalizedValue) {
      baseEntries.push(normalizedValue)
      events.push({
        store: input.store,
        action: "add",
        reason,
        summary: normalizedValue,
      })
    }

    if (input.action === "replace") {
      const idx = findIndex()
      if (idx < 0 || idx >= baseEntries.length || !normalizedValue) {
        const blocked: Event = {
          store: input.store,
          action: "block",
          reason: "invalid_replace",
          summary: "Replace blocked: target entry not found",
          blocked: true,
        }
        enqueueEvents(input.session_id, [blocked])
        return { ok: false as const, events: [blocked] }
      }
      baseEntries[idx] = normalizedValue
      events.push({
        store: input.store,
        action: "replace",
        reason,
        summary: normalizedValue,
      })
    }

    if (input.action === "remove") {
      const idx = findIndex()
      if (idx < 0 || idx >= baseEntries.length) {
        const blocked: Event = {
          store: input.store,
          action: "block",
          reason: "invalid_remove",
          summary: "Remove blocked: target entry not found",
          blocked: true,
        }
        enqueueEvents(input.session_id, [blocked])
        return { ok: false as const, events: [blocked] }
      }
      const removed = baseEntries[idx]!
      baseEntries.splice(idx, 1)
      events.push({
        store: input.store,
        action: "remove",
        reason,
        summary: removed,
      })
    }

    const invalidEntries = input.store === "user" ? (loadedUser?.invalidEntries ?? []) : []
    let reflected = reflectEntries(input.store, baseEntries, invalidEntries, "light")
    let nextEntries = reflected.entries
    events.push(...reflected.events)

    if (usage(nextEntries) > STORE_LIMIT[input.store]) {
      reflected = reflectEntries(input.store, nextEntries, [], "strong")
      nextEntries = reflected.entries
      events.push(...reflected.events)
      if (!reflected.ok) {
        const blocked: Event = {
          store: input.store,
          action: "block",
          reason: "capacity_limit",
          summary: `${input.store.toUpperCase()} store is full after strong reflection`,
          blocked: true,
        }
        enqueueEvents(input.session_id, [...events, blocked])
        return { ok: false as const, events: [...events, blocked] }
      }
    }

    const changed = JSON.stringify(nextEntries) !== before
    if (!changed) {
      events.push({
        store: input.store,
        action: "noop",
        reason: "write_noop",
        summary: "No effective store change",
      })
      enqueueEvents(input.session_id, events)
      return { ok: true as const, events, store: await read(input.store) }
    }

    await saveStore(input.store, nextEntries)

    if (current.memory_reflection_enabled && reason !== "reflection") {
      const reflectionEvents = await reflect({
        session_id: input.session_id,
        mode: "light",
        stores: [input.store],
        enqueue_events: false,
      })
      events.push(...reflectionEvents)
    }

    enqueueEvents(input.session_id, events)
    return { ok: true as const, events, store: await read(input.store) }
  }

  export async function reflect(input: {
    session_id: string
    mode: "light" | "strong"
    stores?: Store[]
    enqueue_events?: boolean
  }) {
    const current = await settings()

    const targets = input.stores && input.stores.length > 0 ? input.stores : (["memory", "user"] as Store[])
    const events: Event[] = []

    for (const store of targets) {
      if (store === "user" && !current.user_profile_enabled) continue
      const loaded = store === "user" ? await loadUserRaw() : undefined
      const memory = store === "memory" ? await loadMemoryRaw() : undefined
      const entries = store === "user" ? loaded!.validEntries : memory!.entries
      const invalid = store === "user" ? loaded!.invalidEntries : []
      const result = reflectEntries(store, entries, invalid, input.mode)
      if (!result.ok) {
        events.push(
          ...result.events.map((item) => ({
            store: item.store,
            action: item.action,
            reason: item.reason,
            summary: item.summary,
            blocked: item.blocked,
          })),
        )
        continue
      }

      const changed = JSON.stringify(result.entries) !== JSON.stringify(entries) || invalid.length > 0
      if (!changed) continue

      await saveStore(store, result.entries)
      events.push(
        ...result.events.map((item) => ({
          store: item.store,
          action: item.action,
          reason: item.reason,
          summary: item.summary,
          ...("blocked" in item ? { blocked: item.blocked } : {}),
        })),
      )
    }

    if (input.enqueue_events !== false) enqueueEvents(input.session_id, events)
    return events
  }

  export async function snapshot(input: { session_id: string }) {
    const cache = frozenSnapshots()
    const inMemory = cache.get(input.session_id)
    if (inMemory) {
      return {
        user: inMemory.user,
        memory: inMemory.memory,
        prompt: inMemory.prompt,
      }
    }

    const fromStorage = await Storage.read<{
      created_at: number
      prompt: string
      user: string[]
      memory: string[]
      scope_key: string
    }>(["memory", "snapshot", input.session_id]).catch(() => undefined)
    if (fromStorage) {
      cache.set(input.session_id, fromStorage)
      return {
        user: fromStorage.user,
        memory: fromStorage.memory,
        prompt: fromStorage.prompt,
      }
    }

    const current = await settings()
    const startupEvents: Event[] = []
    if (current.memory_reflection_enabled) {
      try {
        startupEvents.push(...(await reflect({ session_id: input.session_id, mode: "strong", stores: ["memory"] })))
      } catch {
        startupEvents.push({
          store: "memory",
          action: "block",
          reason: "startup_reflection_failed",
          summary: "Memory startup reflection failed; continuing with current store content",
          blocked: true,
        })
      }
      if (current.user_profile_enabled) {
        try {
          startupEvents.push(...(await reflect({ session_id: input.session_id, mode: "strong", stores: ["user"] })))
        } catch {
          startupEvents.push({
            store: "user",
            action: "block",
            reason: "startup_reflection_failed",
            summary: "User profile startup reflection failed; continuing with current store content",
            blocked: true,
          })
        }
      }
    }
    enqueueEvents(input.session_id, startupEvents)

    const [userStore, memoryStore] = await Promise.all([read("user"), read("memory")])
    const grouped = splitUserEntries(userStore.entries)
    const includeUser = current.user_profile_enabled
    const includeInferred = current.user_profile_enabled && current.user_profile_include_inferred

    const lines = [
      "<memory_snapshot>",
      "<memory_store>",
      ...(memoryStore.entries.length ? memoryStore.entries.map((item) => `- ${item}`) : ["- (empty)"]),
      "</memory_store>",
    ]
    if (includeUser) {
      lines.push("<user_profile>")
      lines.push("Priority order for user-profile guidance:")
      lines.push("1) Follow the user's current-turn instructions first (highest priority).")
      lines.push("2) If not overridden by the current turn, FOLLOW explicit USER profile entries below as standing instructions/preferences.")
      lines.push("3) Treat inferred USER profile entries only as soft hints when consistent with both current-turn instructions and explicit profile.")
      lines.push("Apply explicit style/workflow/preference entries to user-facing responses and execution behavior unless the user overrides them now.")
      lines.push("<explicit>")
      lines.push(...(grouped.explicit.length ? grouped.explicit.map((item) => `- ${item}`) : ["- (empty)"]))
      lines.push("</explicit>")
      if (includeInferred) {
        lines.push("<inferred>")
        lines.push(...(grouped.inferred.length ? grouped.inferred.map((item) => `- ${item}`) : ["- (empty)"]))
        lines.push("</inferred>")
      }
      lines.push("</user_profile>")
    }
    lines.push("<recall_policy>")
    if (current.cross_session_search_enabled) {
      lines.push(
        `Cross-session search enabled (default scope: ${current.cross_session_search_scope}). Use session_search when users reference prior discussions.`,
      )
      lines.push("Use session_read only when users explicitly ask for full/raw/complete historical content.")
    } else {
      lines.push("Cross-session search is disabled by settings.")
    }
    lines.push(
      "When the user states durable preferences, constraints, capabilities, or project facts worth remembering, decide the target store (USER or MEMORY) and call memory_write directly.",
    )
    lines.push("Use memory_reflect proactively (light/strong) when consolidation or capacity management is needed.")
    lines.push("</recall_policy>")
    lines.push("</memory_snapshot>")

    const created = {
      created_at: Date.now(),
      prompt: lines.join("\n"),
      user: userStore.entries,
      memory: memoryStore.entries,
      scope_key: scopeKey(),
    }
    cache.set(input.session_id, created)
    await Storage.write(["memory", "snapshot", input.session_id], created).catch(() => {})
    return {
      user: created.user,
      memory: created.memory,
      prompt: created.prompt,
    }
  }

  function sessionSearchTokens(input: string) {
    const seen = new Set<string>()
    const entries = input
      .split(/[\s,，;；/|、]+/u)
      .map((token) => norm(token))
      .map((token) => token.replace(/^[,，;；/|、]+|[,，;；/|、]+$/gu, ""))
      .filter(Boolean)
      .filter((token) => !/^[,，;；/|、]+$/u.test(token))

    const tokens: string[] = []
    for (const entry of entries) {
      const key = entry.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tokens.push(key)
    }
    return tokens
  }

  function snippet(input: string, tokens: string[]) {
    const text = norm(input)
    if (!text) return ""
    const low = text.toLowerCase()
    let keyword = ""
    let idx = -1
    for (const token of tokens) {
      const position = low.indexOf(token)
      if (position < 0) continue
      keyword = token
      idx = position
      break
    }
    if (idx < 0) return clip(text, 180)
    const start = Math.max(0, idx - 70)
    const end = Math.min(text.length, idx + keyword.length + 70)
    const body = text.slice(start, end)
    if (start === 0 && end === text.length) return body
    if (start === 0) return `${body}...`
    if (end === text.length) return `...${body}`
    return `...${body}...`
  }

  export async function sessionSearch(input: { session_id: string; query: string; limit?: number; scope?: Scope }) {
    const current = await settings()
    if (!current.cross_session_search_enabled) return [] as SearchHit[]
    const query = norm(input.query)
    if (!query) return [] as SearchHit[]
    const tokens = sessionSearchTokens(query)
    if (!tokens.length) return [] as SearchHit[]

    const limit = Math.max(1, Math.min(20, input.limit ?? 6))
    const scope = input.scope ?? current.cross_session_search_scope
    const scoped = sessionScopeFilter(scope)
    const tokenClause = tokens
      .map(
        () =>
          "(lower(coalesce(json_extract(p.data, '$.text'), '')) like lower(?) or lower(coalesce(s.title, '')) like lower(?))",
      )
      .join(" or ")
    const titleClause = tokens.map(() => "lower(coalesce(s.title, '')) like lower(?)").join(" or ")
    const tokenArgs = tokens.flatMap((token) => [`%${token}%`, `%${token}%`])
    const titleArgs = tokens.map((token) => `%${token}%`)
    const sql = [
      "select * from (",
      "select s.id as session_id, s.title as title, s.time_updated as updated_at,",
      "m.id as message_id, m.time_created as created_at,",
      "json_extract(p.data, '$.text') as text,",
      "json_extract(p.data, '$.metadata.memory_receipt') as memory_receipt",
      "from part p",
      "join message m on m.id = p.message_id",
      "join session s on s.id = m.session_id",
      "where json_extract(p.data, '$.type') = 'text'",
      "and coalesce(json_extract(p.data, '$.metadata.memory_receipt'), 0) != 1",
      `and (${tokenClause})`,
      "and s.id != ?",
      "and s.time_archived is null",
      scoped.sql,
      "union all",
      "select s.id as session_id, s.title as title, s.time_updated as updated_at,",
      "null as message_id, 0 as created_at,",
      "null as text,",
      "0 as memory_receipt",
      "from session s",
      "where s.id != ?",
      "and s.time_archived is null",
      scoped.sql,
      `and (${titleClause})`,
      "and not exists (",
      "  select 1",
      "  from message m2",
      "  join part p2 on p2.message_id = m2.id",
      "  where m2.session_id = s.id",
      "  and json_extract(p2.data, '$.type') = 'text'",
      "  and coalesce(json_extract(p2.data, '$.metadata.memory_receipt'), 0) != 1",
      ")",
      ") rows",
      "order by rows.updated_at desc, rows.created_at desc",
      "limit ?",
    ]
      .filter(Boolean)
      .join("\n")

    const rows = Database.Client().$client.prepare(sql).all(
      ...tokenArgs,
      input.session_id,
      ...scoped.args,
      input.session_id,
      ...scoped.args,
      ...titleArgs,
      limit * 24,
    ) as Array<{
      session_id: string
      title: string
      updated_at: number
      message_id: string | null
      created_at: number | null
      text: string | null
      memory_receipt: number | string | boolean | null
    }>

    const grouped = new Map<string, SearchHit>()
    const keywordMatches = new Map<string, Set<string>>()
    for (const row of rows) {
      if (receiptMark(row.memory_receipt)) continue
      const text = norm(row.text ?? "")
      const title = norm(row.title ?? "")
      const matched = tokens.filter((token) => text.toLowerCase().includes(token) || title.toLowerCase().includes(token))
      if (!matched.length) continue

      const keywords = keywordMatches.get(row.session_id) ?? new Set<string>()
      for (const token of matched) keywords.add(token)
      keywordMatches.set(row.session_id, keywords)

      const existing = grouped.get(row.session_id)
      const messageHits = text ? 1 : 0
      if (!existing) {
        grouped.set(row.session_id, {
          session_id: row.session_id,
          title: row.title || "Untitled session",
          updated_at: row.updated_at,
          summary: "",
          snippets: text ? [snippet(text, matched)].filter(Boolean) : [],
          hits: messageHits,
        })
        continue
      }
      existing.hits += messageHits
      if (text && existing.snippets.length < 3) {
        const hit = snippet(text, matched)
        if (hit && !existing.snippets.includes(hit)) existing.snippets.push(hit)
      }
    }

    return [...grouped.values()]
      .sort((a, b) => b.updated_at - a.updated_at || b.hits - a.hits)
      .slice(0, limit)
      .map((item) => {
        const keywordCount = keywordMatches.get(item.session_id)?.size ?? 0
        const summary =
          item.hits > 0
            ? `Matched ${item.hits} ${item.hits === 1 ? "message" : "messages"} across ${keywordCount} keywords. Ordered by recency.`
            : `Matched title across ${keywordCount} keywords. Ordered by recency.`
        return {
          ...item,
          summary,
        }
      })
  }

  export async function sessionRead(input: { session_id: string; page: number; page_size: number; scope?: Scope }) {
    const targetSessionID = SessionID.make(input.session_id)
    const current = await settings()
    if (!current.cross_session_search_enabled) throw new Error("Cross-session search is disabled by settings.")
    const scope = input.scope ?? current.cross_session_search_scope
    const scoped = sessionScopeFilter(scope)

    const session = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.id, targetSessionID), isNull(SessionTable.time_archived)))
        .get(),
    )
    if (!session) throw new Error(`Session not found: ${input.session_id}`)
    if (!scoped.match(session)) throw new Error("The requested session is outside the current project scope.")

    const page = Math.max(1, input.page)
    const pageSize = Math.max(1, Math.min(100, input.page_size))
    const offset = (page - 1) * pageSize

    const total =
      Database.use((db) =>
        db.select({ total: count() }).from(MessageTable).where(eq(MessageTable.session_id, targetSessionID)).get(),
      )?.total ?? 0
    const messages = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, targetSessionID))
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
        .limit(pageSize)
        .offset(offset)
        .all(),
    )
    const ids = messages.map((row) => row.id)
    const parts =
      ids.length === 0
        ? []
        : Database.use((db) =>
            db
              .select()
              .from(PartTable)
              .where(inArray(PartTable.message_id, ids))
              .orderBy(asc(PartTable.message_id), asc(PartTable.id))
              .all(),
          )

    const grouped = new Map<string, Array<{ type: string; text?: string; data?: Record<string, unknown> }>>()
    for (const row of parts) {
      const data = row.data as Record<string, unknown>
      const type = typeof data.type === "string" ? data.type : "unknown"
      const text = typeof data.text === "string" ? data.text : undefined
      const list = grouped.get(row.message_id) ?? []
      list.push({ type, text, data: text ? undefined : data })
      grouped.set(row.message_id, list)
    }

    const hasMore = offset + messages.length < total
    return {
      session_id: input.session_id,
      title: session.title,
      page,
      page_size: pageSize,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : null,
      total_messages: total,
      messages: messages.map((message) => {
        const info = message.data as Record<string, unknown>
        return {
          id: message.id,
          role: typeof info.role === "string" ? info.role : "unknown",
          created_at: message.time_created,
          parts: grouped.get(message.id) ?? [],
        }
      }),
    } satisfies SessionPage
  }

  function continuationRead(text: string) {
    const low = text.toLowerCase()
    const rules = [/\b(next|continue|more)\b.{0,16}\b(page|messages?|history|results?)?\b/, /\b(page)\s*\d+\b/, /(下一页|继续|更多|后续)/]
    return rules.some((rule) => rule.test(low))
  }

  export function explicitRead(
    messages: Array<{ info: { id?: string; role: string }; parts: Array<{ type: string; text?: string }> }>,
  ) {
    const user = messages.findLast((message) => message.info.role === "user")
    if (!user) return false
    const text = user.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join(" ")
      .toLowerCase()
    if (!text) return false
    const rules = [
      /\b(full|entire|raw|complete|verbatim|exact)\b.{0,20}\b(session|conversation|chat|history)\b/,
      /\b(read|show|open)\b.{0,20}\b(full|entire|raw|complete)\b/,
      /(完整|原文|全部|全量|逐条|详细).{0,12}(会话|对话|历史|内容)/,
    ]
    return rules.some((rule) => rule.test(text))
  }

  export function canSessionRead(input: {
    actor_session_id: string
    target_session_id: string
    page: number
    messages: Array<{ info: { id?: string; role: string }; parts: Array<{ type: string; text?: string }> }>
  }) {
    const user = input.messages.findLast((message) => message.info.role === "user")
    if (!user) return false
    const userMessageID = user.info.id ?? "__unknown__"
    const text = user.parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join(" ")
      .trim()

    if (explicitRead(input.messages)) {
      // Continuation grant is bound to actor session + target session to prevent session_read abuse.
      readGrant().set(input.actor_session_id, {
        user_message_id: userMessageID,
        target_session_id: input.target_session_id,
        granted_at: Date.now(),
      })
      return true
    }

    const grant = readGrant().get(input.actor_session_id)
    if (!grant) return false
    if (grant.target_session_id !== input.target_session_id) return false
    if (grant.user_message_id === userMessageID) return true
    if (input.page > 1 && continuationRead(text)) {
      readGrant().set(input.actor_session_id, {
        user_message_id: userMessageID,
        target_session_id: input.target_session_id,
        granted_at: Date.now(),
      })
      return true
    }
    return false
  }

  export function format(events: Event[]) {
    if (!events.length) return ""
    const success = events.filter((event) => classifyEvent(event) === "success")
    const failure = events.filter((event) => classifyEvent(event) === "failure")
    const lines: string[] = []
    if (success.length) {
      lines.push("Memory updates:")
      for (const event of success.slice(0, 5)) {
        lines.push(`- [${event.store}][${event.action}] ${event.summary}`)
      }
      if (success.length > 5) lines.push(`... and ${success.length - 5} more memory updates`)
    }
    if (failure.length) {
      if (lines.length) lines.push("")
      lines.push("Memory failures:")
      for (const event of failure.slice(0, 5)) {
        lines.push(`- [${event.store}][${event.action}] ${event.summary}`)
      }
      if (failure.length > 5) lines.push(`... and ${failure.length - 5} more memory failures`)
    }
    return lines.join("\n")
  }
}
