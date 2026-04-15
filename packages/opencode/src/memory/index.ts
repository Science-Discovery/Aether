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
    file: z.string(),
    limit: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    usage: z.number(),
    entries: z.array(z.string()),
  })
  export type ReadStore = z.infer<typeof ReadStore>

  export const SearchHit = z.object({
    session_id: z.string(),
    title: z.string(),
    updated_at: z.number(),
    summary: z.string(),
    snippets: z.array(z.string()),
    hits: z.number().int().positive(),
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

  const lim: Record<Store, number> = {
    user: 4000,
    memory: 4000,
  }

  const live = Instance.state(() => new Map<string, Event[]>(), async (map) => {
    map.clear()
  })
  const frozen = Instance.state(
    () =>
      new Map<
        string,
        {
          created_at: number
          user: string[]
          memory: string[]
          prompt: string
          scope_key: string
        }
      >(),
    async (map) => {
      map.clear()
    },
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
    async (map) => {
      map.clear()
    },
  )

  function norm(input: string) {
    return input.replace(/\s+/g, " ").trim()
  }

  function clip(input: string, n = 220) {
    if (input.length <= n) return input
    return input.slice(0, Math.max(0, n - 1)).trimEnd() + "..."
  }

  function receiptMark(input: unknown) {
    return input === 1 || input === "1" || input === true || input === "true"
  }

  function scopeKey() {
    // Keep project memory isolated even outside git repos by hashing the absolute workspace directory.
    const workspaceID = WorkspaceContext.workspaceID
    if (workspaceID) return `workspace-${workspaceID}`
    if (Instance.project.id !== ProjectID.global) return `project-${Instance.project.id}`
    const dir = Filesystem.resolve(Instance.directory)
    const digest = createHash("sha1").update(dir).digest("hex").slice(0, 20)
    return `directory-${digest}`
  }

  function sessionScopeFilter(scope: Scope) {
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
    // For non-git/global project IDs, scope by physical directory to avoid cross-project bleed.
    return {
      sql: "and s.project_id = ? and s.directory = ?",
      args: [ProjectID.global, directory],
      match: (session: { project_id: string; workspace_id: string | null; directory: string }) =>
        session.project_id === ProjectID.global && Filesystem.resolve(session.directory) === directory,
    }
  }

  function pth(store: Store) {
    if (store === "user") {
      return path.join(Global.Path.data, "memory", "user", "USER.md")
    }
    return path.join(Global.Path.data, "memory", "scope", scopeKey(), "MEMORY.md")
  }

  function head(store: Store) {
    if (store === "user") return "# USER"
    return "# MEMORY"
  }

  function render(store: Store, entries: string[]) {
    const list = entries.map((x) => `- ${x}`).join("\n")
    if (!list) return `${head(store)}\n`
    return `${head(store)}\n${list}\n`
  }

  function parse(text: string) {
    return text
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1])
      .filter((x): x is string => Boolean(x))
      .map((x) => norm(x))
      .filter(Boolean)
  }

  function stat(entries: string[], store: Store) {
    const used = entries.join("\n").length
    const limit = lim[store]
    return {
      used,
      limit,
      usage: limit === 0 ? 0 : used / limit,
    }
  }

  async function load(store: Store) {
    const file = pth(store)
    const text = await Filesystem.readText(file).catch(() => "")
    const entries = parse(text)
    const info = stat(entries, store)
    return {
      store,
      file,
      entries,
      ...info,
    } satisfies ReadStore
  }

  async function save(store: Store, entries: string[]) {
    await Filesystem.write(pth(store), render(store, entries))
  }

  function push(session_id: string, next: Event[]) {
    if (!next.length) return
    const map = live()
    const list = map.get(session_id) ?? []
    list.push(...next)
    map.set(session_id, list)
  }

  export function flush(session_id: string) {
    const map = live()
    const list = map.get(session_id) ?? []
    map.delete(session_id)
    return list
  }

  export function enqueue(session_id: string, events: Event[]) {
    push(session_id, events)
  }

  function similar(a: string, b: string) {
    const x = new Set(norm(a).toLowerCase().split(" ").filter(Boolean))
    const y = new Set(norm(b).toLowerCase().split(" ").filter(Boolean))
    if (!x.size || !y.size) return false
    let hit = 0
    for (const t of x) {
      if (y.has(t)) hit++
    }
    const ratio = hit / Math.max(x.size, y.size)
    return ratio >= 0.72
  }

  function dedupe(entries: string[]) {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of entries) {
      const text = norm(raw)
      if (!text) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(text)
    }
    return out
  }

  function squeeze(entries: string[], store: Store, mode: "light" | "strong") {
    const ev: Event[] = []
    let out = dedupe(entries)

    if (mode === "light") {
      return { entries: out, events: ev, ok: true }
    }

    const merged: string[] = []
    for (const item of out) {
      const idx = merged.findIndex((x) => x.includes(item) || item.includes(x) || similar(x, item))
      if (idx < 0) {
        merged.push(item)
        continue
      }
      merged[idx] = clip(norm(`${merged[idx]}; ${item}`), 240)
      ev.push({
        store,
        action: "merge",
        reason: "capacity_compact",
        summary: clip(merged[idx], 130),
      })
    }
    out = merged.map((x) => clip(x, 280))

    let info = stat(out, store)
    while (info.used > info.limit && out.length > 1) {
      const a = out.shift()!
      const b = out.shift()!
      const item = clip(norm(`${a}; ${b}`), 240)
      out.unshift(item)
      ev.push({
        store,
        action: "compact",
        reason: "capacity_compact",
        summary: clip(item, 130),
      })
      info = stat(out, store)
    }

    if (info.used > info.limit && out.length === 1) {
      out[0] = clip(out[0], info.limit)
      info = stat(out, store)
      ev.push({
        store,
        action: "compact",
        reason: "capacity_compact",
        summary: clip(out[0], 130),
      })
    }

    return {
      entries: out,
      events: ev,
      ok: info.used <= info.limit,
    }
  }

  type Risk = { kind: "prompt_injection" | "secret" | "exfiltration" | "invisible_chars"; hit: string }

  function scan(input: string): Risk | undefined {
    const text = input.toLowerCase()
    const rules: Array<{ kind: Risk["kind"]; test: RegExp }> = [
      {
        kind: "invisible_chars",
        test: /[\u200b-\u200f\u2060\ufeff]/u,
      },
      {
        kind: "prompt_injection",
        test: /\b(ignore|disregard|override).{0,24}\b(instruction|system|policy|rule)s?\b/i,
      },
      {
        kind: "secret",
        test: /\b(sk-[a-z0-9]{20,}|api[_-]?key|access[_-]?token|secret[_-]?key|-----begin [a-z ]*private key-----)\b/i,
      },
      {
        kind: "exfiltration",
        test: /\b(cat|scp|curl|wget).{0,30}(\.env|id_rsa|credentials|token|secret)\b/i,
      },
    ]
    for (const rule of rules) {
      const hit = input.match(rule.test)?.[0]
      if (!hit) continue
      return { kind: rule.kind, hit: clip(hit, 80) }
    }
    if (/(base64|hex).{0,20}(decode|decodeURIComponent)/i.test(text) && /(token|secret|key)/i.test(text)) {
      return { kind: "secret", hit: "encoded secret-like content" }
    }
    return
  }

  export async function settings() {
    const cfg = await Config.get()
    const src = cfg.memory ?? {}
    return {
      cross_session_search_enabled: src.cross_session_search_enabled ?? true,
      cross_session_search_scope: src.cross_session_search_scope ?? "current_project",
      memory_reflection_enabled: src.memory_reflection_enabled ?? true,
    } satisfies Settings
  }

  export async function read(store: Store) {
    return load(store)
  }

  export async function list() {
    const [user, memory] = await Promise.all([load("user"), load("memory")])
    return { user, memory }
  }

  export async function search(input: { query: string; store?: Store; limit?: number }) {
    const q = norm(input.query).toLowerCase()
    const limit = Math.max(1, Math.min(20, input.limit ?? 10))
    if (!q) return [] as Array<{ store: Store; index: number; text: string }>

    const stores = input.store ? [input.store] : (["user", "memory"] as Store[])
    const all = await Promise.all(stores.map((x) => load(x)))
    const out: Array<{ store: Store; index: number; text: string }> = []
    for (const item of all) {
      item.entries.forEach((text, index) => {
        if (!text.toLowerCase().includes(q)) return
        out.push({ store: item.store, index: index + 1, text })
      })
    }
    return out.slice(0, limit)
  }

  type WriteInput = {
    session_id: string
    store: Store
    action: "add" | "replace" | "remove"
    value?: string
    index?: number
    match?: string
    reason: "auto_write" | "history_extract" | "reflection"
  }

  export async function write(input: WriteInput) {
    const cur = await load(input.store)
    const next = [...cur.entries]
    const ev: Event[] = []
    const before = JSON.stringify(cur.entries)
    const val = input.value ? norm(input.value) : undefined
    const mat = input.match ? norm(input.match) : undefined

    if (input.action !== "remove") {
      if (!val) {
        const item = {
          store: input.store,
          action: "block",
          reason: "invalid_write",
          summary: "Write blocked: empty memory content",
          blocked: true,
        } satisfies Event
        push(input.session_id, [item])
        return { ok: false, events: [item] }
      }
      const risk = scan(val)
      if (risk) {
        const item = {
          store: input.store,
          action: "block",
          reason: `safety_${risk.kind}`,
          summary: `Blocked unsafe memory write (${risk.kind})`,
          detail: risk.hit,
          blocked: true,
        } satisfies Event
        push(input.session_id, [item])
        return { ok: false, events: [item] }
      }
    }

    if (input.action === "add") {
      if (val) {
        const dup = next.some((item) => item.toLowerCase() === val.toLowerCase())
        if (dup) {
          // Report as noop so receipts reflect the real store state (no fake "add").
          ev.push({
            store: input.store,
            action: "noop",
            reason: "dedupe_noop",
            summary: `No change: duplicate entry ignored (${clip(val, 120)})`,
          })
        } else {
          next.push(val)
          ev.push({
            store: input.store,
            action: "add",
            reason: input.reason,
            summary: clip(val, 140),
          })
        }
      }
    }

    if (input.action === "replace") {
      const idx = (() => {
        if (typeof input.index === "number") return input.index - 1
        if (!mat) return -1
        return next.findIndex((x) => x.toLowerCase().includes(mat.toLowerCase()))
      })()
      if (idx < 0 || idx >= next.length || !val) {
        const item = {
          store: input.store,
          action: "block",
          reason: "invalid_replace",
          summary: "Replace blocked: target entry not found",
          blocked: true,
        } satisfies Event
        push(input.session_id, [item])
        return { ok: false, events: [item] }
      }
      const prev = next[idx]
      if (norm(prev) === val) {
        ev.push({
          store: input.store,
          action: "noop",
          reason: "replace_noop",
          summary: `No change: replacement equals existing entry (${clip(val, 120)})`,
        })
      } else {
        next[idx] = val
        ev.push({
          store: input.store,
          action: "replace",
          reason: input.reason,
          summary: clip(val, 140),
        })
      }
    }

    if (input.action === "remove") {
      const idx = (() => {
        if (typeof input.index === "number") return input.index - 1
        if (!mat) return -1
        return next.findIndex((x) => x.toLowerCase().includes(mat.toLowerCase()))
      })()
      if (idx < 0 || idx >= next.length) {
        const item = {
          store: input.store,
          action: "block",
          reason: "invalid_remove",
          summary: "Remove blocked: target entry not found",
          blocked: true,
        } satisfies Event
        push(input.session_id, [item])
        return { ok: false, events: [item] }
      }
      const old = next[idx]
      next.splice(idx, 1)
      ev.push({
        store: input.store,
        action: "remove",
        reason: input.reason,
        summary: clip(old, 140),
      })
    }

    const lite = squeeze(next, input.store, "light")
    let packed = lite.entries

    const low = stat(packed, input.store).usage >= 0.8
    if (low) {
      const strong = squeeze(packed, input.store, "strong")
      packed = strong.entries
      ev.push(...strong.events)
      if (!strong.ok) {
        const item = {
          store: input.store,
          action: "block",
          reason: "capacity_limit",
          summary: "Write rejected: store remains above capacity after compaction",
          blocked: true,
        } satisfies Event
        push(input.session_id, [...ev, item])
        return { ok: false, events: [...ev, item] }
      }
    }

    const changed = JSON.stringify(packed) !== before
    if (!changed) {
      if (!ev.some((item) => item.action === "noop")) {
        ev.push({
          store: input.store,
          action: "noop",
          reason: "write_noop",
          summary: "No change: memory store unchanged after dedupe/compaction",
        })
      }
      push(input.session_id, ev)
      return { ok: true, events: ev, store: cur }
    }

    await save(input.store, packed)
    push(input.session_id, ev)
    return { ok: true, events: ev, store: await load(input.store) }
  }

  export async function reflect(input: { session_id: string; mode: "light" | "strong" }) {
    const set = await settings()
    if (!set.memory_reflection_enabled) return [] as Event[]
    const stores = ["user", "memory"] as Store[]
    const out: Event[] = []
    for (const store of stores) {
      const cur = await load(store)
      const packed = squeeze(cur.entries, store, input.mode)
      if (!packed.ok) continue
      if (JSON.stringify(cur.entries) === JSON.stringify(packed.entries)) continue
      await save(store, packed.entries)
      const ev = packed.events.length
        ? packed.events
        : [
            {
              store,
              action: "compact",
              reason: "reflection",
              summary: "Memory reflection updated entries",
            } satisfies Event,
          ]
      out.push(...ev)
    }
    push(input.session_id, out)
    return out
  }

  function snap(input: string, q: string) {
    const text = norm(input)
    if (!text) return ""
    const low = text.toLowerCase()
    const idx = low.indexOf(q.toLowerCase())
    if (idx < 0) return clip(text, 180)
    const start = Math.max(0, idx - 70)
    const end = Math.min(text.length, idx + q.length + 70)
    const cut = text.slice(start, end)
    if (start === 0 && end === text.length) return cut
    if (start === 0) return `${cut}...`
    if (end === text.length) return `...${cut}`
    return `...${cut}...`
  }

  function recallHint() {
    return [
      "When a user asks about prior discussions (e.g. previously, last time, remember, we discussed), call session_search before answering from memory.",
      "Do not call session_read unless the user explicitly asks for full/raw/complete historical content.",
    ].join("\n")
  }

  function writeHint() {
    return [
      "Auto-write durable memory when confidence is high (preferences, stable constraints, recurring project rules).",
      "Use memory_write with concise entries. Do not store transient logs, secrets, or speculative guesses.",
      "Prefer store=user for persistent user preferences and store=memory for project/workspace conventions.",
    ].join("\n")
  }

  export async function snapshot(input: { session_id: string }) {
    // Frozen snapshots are cached per session_id and reused for all turns in that session.
    // New memory writes become visible only in new sessions.
    const cache = frozen()
    const current = cache.get(input.session_id)
    if (current) {
      return {
        user: current.user,
        memory: current.memory,
        prompt: current.prompt,
      }
    }

    const fromStorage = await Storage.read<{
      created_at: number
      user: string[]
      memory: string[]
      prompt: string
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

    const [user, memory, set] = await Promise.all([load("user"), load("memory"), settings()])
    const body = [
      "<memory_snapshot>",
      "<user_store>",
      ...(user.entries.length ? user.entries.map((x) => `- ${x}`) : ["- (empty)"]),
      "</user_store>",
      "<project_store>",
      ...(memory.entries.length ? memory.entries.map((x) => `- ${x}`) : ["- (empty)"]),
      "</project_store>",
      "<recall_policy>",
      set.cross_session_search_enabled
        ? `Cross-session search is enabled (default scope: ${set.cross_session_search_scope}). ${recallHint()}`
        : "Cross-session search is disabled by user settings. Do not use session_search/session_read.",
      "</recall_policy>",
      "<write_policy>",
      writeHint(),
      "</write_policy>",
      "</memory_snapshot>",
    ].join("\n")
    const created = {
      created_at: Date.now(),
      user: user.entries,
      memory: memory.entries,
      prompt: body,
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

  export async function sessionSearch(input: {
    session_id: string
    query: string
    limit?: number
    scope?: Scope
  }) {
    const set = await settings()
    if (!set.cross_session_search_enabled) return [] as SearchHit[]
    const q = norm(input.query)
    if (!q) return [] as SearchHit[]
    const lim = Math.max(1, Math.min(20, input.limit ?? 6))
    const scope = input.scope ?? set.cross_session_search_scope
    const scoped = sessionScopeFilter(scope)
    const sql = [
      "select s.id as session_id, s.title as title, s.time_updated as updated_at,",
      "m.id as message_id, m.time_created as created_at,",
      "json_extract(p.data, '$.text') as text,",
      "json_extract(p.data, '$.metadata.memory_receipt') as memory_receipt",
      "from part p",
      "join message m on m.id = p.message_id",
      "join session s on s.id = m.session_id",
      "where json_extract(p.data, '$.type') = 'text'",
      // Memory receipts are assistant-side audit tails, not semantic conversation content.
      "and coalesce(json_extract(p.data, '$.metadata.memory_receipt'), 0) != 1",
      "and lower(json_extract(p.data, '$.text')) like lower(?)",
      "and s.id != ?",
      "and s.time_archived is null",
      scoped.sql,
      "order by s.time_updated desc, m.time_created desc",
      "limit ?",
    ]
      .filter(Boolean)
      .join("\n")

    const args = [`%${q}%`, input.session_id, ...scoped.args, lim * 24]
    const rows = Database.Client().$client.prepare(sql).all(...args) as Array<{
      session_id: string
      title: string
      updated_at: number
      message_id: string
      created_at: number
      text: string | null
      memory_receipt: number | string | boolean | null
    }>

    const by = new Map<string, SearchHit>()
    for (const row of rows) {
      if (receiptMark(row.memory_receipt)) continue
      const text = norm(row.text ?? "")
      if (!text) continue
      const hit = by.get(row.session_id)
      if (!hit) {
        by.set(row.session_id, {
          session_id: row.session_id,
          title: row.title || "Untitled session",
          updated_at: row.updated_at,
          summary: "",
          snippets: [snap(text, q)].filter(Boolean),
          hits: 1,
        })
        continue
      }
      hit.hits += 1
      if (hit.snippets.length < 3) {
        const s = snap(text, q)
        if (s && !hit.snippets.includes(s)) hit.snippets.push(s)
      }
    }

    const list = [...by.values()]
      .sort((a, b) => b.updated_at - a.updated_at || b.hits - a.hits)
      .slice(0, lim)
      .map((x) => ({
        ...x,
        summary: `Matched ${x.hits} messages. ${x.snippets[0] ? `Recent: ${clip(x.snippets[0], 120)}` : ""}`.trim(),
      }))
    return list
  }

  export async function extract(input: { session_id: string; hits: SearchHit[] }) {
    const out: Event[] = []
    const seen = new Set<string>()
    for (const hit of input.hits) {
      for (const raw of hit.snippets) {
        const text = norm(raw)
        if (!text) continue
        if (/^\s*memory updates:/i.test(text)) continue
        if (/^\s*-\s*\[(user|memory)\]\[(add|replace|remove|merge|compact|block|noop)\]/i.test(text)) continue
        const low = text.toLowerCase()
        const user = /(prefer|preference|always|please|默认|偏好|请始终|习惯)/i.test(text)
        const memory = /(must|should|run|command|path|directory|workflow|约定|命令|路径|目录|流程)/i.test(text)
        if (!user && !memory) continue
        if (text.length < 20) continue
        if (text.length > 240) continue
        if (/(maybe|might|guess|perhaps|可能|也许|猜测)/i.test(text)) continue
        const item = clip(text, 220)
        const key = `${user ? "user" : "memory"}:${item.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        const writeResult = await write({
          session_id: input.session_id,
          store: user ? "user" : "memory",
          action: "add",
          value: item,
          reason: "history_extract",
        })
        out.push(...writeResult.events)
        if (out.length >= 6) return out
        if (low.includes("remember this")) continue
      }
    }
    return out
  }

  export async function sessionRead(input: {
    session_id: string
    page: number
    page_size: number
    scope?: Scope
  }) {
    const sessionID = SessionID.make(input.session_id)
    const set = await settings()
    if (!set.cross_session_search_enabled) {
      throw new Error("Cross-session search is disabled by settings.")
    }
    const scope = input.scope ?? set.cross_session_search_scope
    const ses = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.time_archived)))
        .get(),
    )
    if (!ses) throw new Error(`Session not found: ${input.session_id}`)
    const scoped = sessionScopeFilter(scope)
    if (!scoped.match(ses)) {
      throw new Error("The requested session is outside the current project scope.")
    }

    const page = Math.max(1, input.page)
    const size = Math.max(1, Math.min(100, input.page_size))
    const off = (page - 1) * size
    const total =
      Database.use((db) =>
        db.select({ total: count() }).from(MessageTable).where(eq(MessageTable.session_id, sessionID)).get(),
      )?.total ?? 0

    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
        .limit(size)
        .offset(off)
        .all(),
    )
    const ids = rows.map((x) => x.id)
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
      const item = { type, text, data: text ? undefined : data }
      const list = grouped.get(row.message_id) ?? []
      list.push(item)
      grouped.set(row.message_id, list)
    }

    const has_more = off + rows.length < total
    return {
      session_id: input.session_id,
      title: ses.title,
      page,
      page_size: size,
      has_more,
      next_page: has_more ? page + 1 : null,
      total_messages: total,
      messages: rows.map((row) => {
        const data = row.data as Record<string, unknown>
        return {
          id: row.id,
          role: typeof data.role === "string" ? data.role : "unknown",
          created_at: row.time_created,
          parts: grouped.get(row.id) ?? [],
        }
      }),
    } satisfies SessionPage
  }

  function continuationRead(input: string) {
    const text = input.toLowerCase()
    if (!text) return false
    const rules = [
      /\b(next|continue|more)\b.{0,16}\b(page|messages?|history|results?)?\b/,
      /\b(page)\s*\d+\b/,
      /(下一页|继续|再来|更多|往后翻|后续)/,
    ]
    return rules.some((x) => x.test(text))
  }

  export function explicitRead(
    messages: Array<{ info: { id?: string; role: string }; parts: Array<{ type: string; text?: string }> }>,
  ) {
    const user = messages.findLast((x) => x.info.role === "user")
    if (!user) return false
    const text = user.parts
      .filter((x) => x.type === "text" && typeof x.text === "string")
      .map((x) => x.text ?? "")
      .join(" ")
      .toLowerCase()
    if (!text) return false
    const rules = [
      /\b(full|entire|raw|complete|verbatim|exact)\b.{0,20}\b(session|conversation|chat|history)\b/,
      /\b(read|show|open)\b.{0,20}\b(full|entire|raw|complete)\b/,
      /(完整|原文|全部|全量|逐条|详细).{0,12}(会话|对话|历史|内容)/,
    ]
    return rules.some((x) => x.test(text))
  }

  export function canSessionRead(input: {
    actor_session_id: string
    target_session_id: string
    page: number
    messages: Array<{ info: { id?: string; role: string }; parts: Array<{ type: string; text?: string }> }>
  }) {
    const user = input.messages.findLast((x) => x.info.role === "user")
    if (!user) return false
    const userMessageID = user.info.id ?? "__unknown__"
    const text = user.parts
      .filter((x) => x.type === "text" && typeof x.text === "string")
      .map((x) => x.text ?? "")
      .join(" ")
      .trim()

    if (explicitRead(input.messages)) {
      // Explicit user consent opens a continuation window for this actor->target pair only.
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
    // Subsequent pages are allowed only when the user asks to continue and target session matches.
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
    const lines = ["Memory updates:"]
    for (const item of events) {
      const tail = item.detail ? ` (${clip(item.detail, 80)})` : ""
      lines.push(`- [${item.store}][${item.action}] ${clip(item.summary, 180)}${tail}`)
    }
    return lines.join("\n")
  }
}
