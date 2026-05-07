import z from "zod"
import { Tool } from "./tool"
import { Memory } from "@/memory"

function blocked(reason: string) {
  return {
    title: "Memory action blocked",
    output: reason,
    metadata: { blocked: true },
  }
}

function renderEntries(items: string[]) {
  if (!items.length) return "- (empty)"
  return items.map((item, idx) => `${idx + 1}. ${item}`).join("\n")
}

function latestUserText(ctx: Tool.Context) {
  for (const msg of ctx.messages.toReversed()) {
    if (msg.info.role !== "user") continue
    const text = msg.parts
      .flatMap((part) => {
        if (part.type !== "text" || part.ignored || part.synthetic) return []
        return [part.text]
      })
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

function hasExplicitMemoryManagementIntent(ctx: Tool.Context) {
  const text = latestUserText(ctx)
  if (!text) return false
  return [
    /\b(show|list|read|display|inspect|manage|review|dump|export|edit|delete|remove|open)\b[\s\S]{0,80}\b(memory|memories|user profile|profile|USER\.md|MEMORY\.md)\b/i,
    /\b(memory|memories|user profile|profile|USER\.md|MEMORY\.md)\b[\s\S]{0,80}\b(show|list|read|display|inspect|manage|review|dump|export|edit|delete|remove|open)\b/i,
    /(查看|列出|显示|读取|浏览|管理|检查|导出|编辑|删除|修改|打开)[\s\S]{0,30}(记忆|画像|用户画像|USER\.md|MEMORY\.md)/,
    /(记忆|画像|用户画像|USER\.md|MEMORY\.md)[\s\S]{0,30}(查看|列出|显示|读取|浏览|管理|检查|导出|编辑|删除|修改|打开)/,
  ].some((pattern) => pattern.test(text))
}

function memoryManagementRequired() {
  return blocked(
    "memory_read and memory_list are only for explicit memory-management requests. Use memory_search for memory recall.",
  )
}

export const MemoryWriteTool = Tool.define("memory_write", {
  description: [
    "Write a short-term session memory note for later recall and reflection.",
    "Every write must include scope: session:<current session id>, project:<project id>, workspace:<workspace id>, or global.",
    "Use the exact current scope ids from the memory_context system prompt; do not invent project or workspace ids.",
    "All writes go to the current session memory file first; project/workspace/global scopes are also mirrored to pending inbox for matching sessions.",
    "Use session scope for temporary conversation context, project for stable repo/project facts, workspace for Aether workspace-level facts, and global only for truly cross-project user preferences, rules, corrections, or must/never requirements.",
    "If the user asks to remember something long-term, write that request in natural language in the note and choose the narrowest correct cross-session scope.",
    "Do not store transient logs or secrets.",
    "The written note is silently added to active memory and remains available in this session.",
  ].join("\n"),
  parameters: z.object({
    store: Memory.Store.optional().describe("Deprecated intended future store; write still goes to session memory."),
    action: z.enum(["add", "replace", "remove"]),
    value: z.string().optional().describe("Natural-language memory note."),
    scope: z
      .union([
        z.literal("global"),
        z.string().regex(/^(session|project|workspace):.+$/),
        Memory.LiveScope,
      ])
      .optional()
      .describe("Visibility scope. Use session:<current session id> unless the note should be shared."),
    salience_hint: Memory.SalienceHint.optional().describe("Initial importance hint; usage counts still start at zero."),
    salience_reason: z.string().optional().describe("Short reason for the salience hint."),
    profile: z
      .object({
        type: z.enum(["fact", "preference", "task"]),
        source: z.enum(["explicit", "inferred"]),
        content: z.string(),
      })
      .optional()
      .describe("Optional helper for user-profile-like notes. If provided with store=user, value is built automatically."),
    index: z.number().int().positive().optional(),
    match: z.string().optional(),
    reason: Memory.WriteReason.optional(),
  }),
  async execute(input, ctx) {
    const intendedStore = input.store ?? "memory"
    const deprecated = input.store ? ["store"] : []
    const value =
      intendedStore === "user" && input.profile
        ? `${input.profile.type}[${input.profile.source}]: ${input.profile.content}`
        : input.value
    const result = await Memory.write({
      session_id: ctx.sessionID,
      store: intendedStore,
      action: input.action,
      value,
      index: input.index,
      match: input.match,
      reason: input.reason,
      scope: input.scope,
      salience_hint: input.salience_hint,
      salience_reason: input.salience_reason,
    })

    if (!result.ok) return blocked(result.events[0]?.summary ?? "Write blocked")
    return {
      title: "Memory updated",
      output: [
        ...(deprecated.length ? ["deprecated: store is accepted for compatibility; memory_write always writes session memory first.", ""] : []),
        "Store: session",
        `File: ${result.session.file}`,
        `Used: ${result.session.used}`,
        "",
        renderEntries(result.session.entries),
      ].join("\n"),
      metadata: {
        blocked: false,
        store: "session",
        intended_store: intendedStore,
        scope: input.scope ?? "session-only",
        inbox_id: result.inbox?.id,
        ...(deprecated.length ? { deprecated } : {}),
        used: result.session.used,
        enabled: true,
      },
    }
  },
})

export const MemoryReadTool = Tool.define("memory_read", {
  description: [
    "Read durable USER entries or recent daily MEMORY entries for explicit memory-management requests.",
    "Do not use this for ordinary memory recall; use memory_search instead.",
  ].join("\n"),
  parameters: z.object({
    store: Memory.Store,
    index: z.number().int().positive().optional(),
  }),
  async execute(input, ctx) {
    if (!hasExplicitMemoryManagementIntent(ctx)) return memoryManagementRequired()
    const store = await Memory.read(input.store)
    if (!store.enabled) return blocked(`${store.store.toUpperCase()} store is disabled by settings.`)
    if (input.index) {
      const item = store.entries[input.index - 1]
      if (!item) return blocked(`Entry ${input.index} not found in ${input.store}`)
      return {
        title: "Memory entry",
        output: `${input.index}. ${item}`,
        metadata: { blocked: false, store: input.store, index: input.index },
      }
    }
    return {
      title: "Memory store",
      output: [`Store: ${store.store}`, `Used: ${store.used}/${store.limit}`, "", renderEntries(store.entries)].join("\n"),
      metadata: { blocked: false, store: store.store, used: store.used, limit: store.limit },
    }
  },
})

export const MemoryListTool = Tool.define("memory_list", {
  description: [
    "List USER and MEMORY stores with usage and entries for explicit memory-management requests.",
    "Do not use this for ordinary memory recall; use memory_search instead.",
  ].join("\n"),
  parameters: z.object({}),
  async execute(_input, ctx) {
    if (!hasExplicitMemoryManagementIntent(ctx)) return memoryManagementRequired()
    const stores = await Memory.list()
    const lines = [`MEMORY (${stores.memory.used}/${stores.memory.limit})`, renderEntries(stores.memory.entries)]
    if (stores.user.enabled) {
      lines.push("", `USER (${stores.user.used}/${stores.user.limit})`, renderEntries(stores.user.entries))
    }
    return {
      title: "Memory stores",
      output: lines.join("\n"),
      metadata: {
        blocked: false,
        user_enabled: stores.user.enabled,
        user_used: stores.user.used,
        user_limit: stores.user.limit,
        memory_used: stores.memory.used,
        memory_limit: stores.memory.limit,
      },
    }
  },
})

export const MemorySearchTool = Tool.define("memory_search", {
  description: [
    "Search the current session prepared memory pool by keyword.",
    "The pool is initialized from USER.md, matching pending inbox, recent daily memory, and current session short-term memory.",
    "This is the only supported tool for recalling Aether memory.",
    "Do not use read, glob, grep, bash, or other file tools to inspect Aether memory files.",
    "Search accepts phrases plus separated keywords; include related synonyms, Chinese/English terms, paths, tool names, API names, and error strings when useful.",
    "Hits are silently added to active memory and will remain injected for this session.",
  ].join("\n"),
  parameters: z.object({
    query: z.string(),
    store: Memory.Store.optional(),
    limit: z.number().int().positive().optional(),
  }),
  async execute(input, ctx) {
    const hits = await Memory.search({ ...input, session_id: ctx.sessionID })
    return {
      title: "Memory search",
      output: hits.length
        ? hits.map((hit) => `[${hit.source}] ${hit.index}. ${hit.text}`).join("\n")
        : "No matches.",
      metadata: { count: hits.length },
    }
  },
})

export const MemoryReloadTool = Tool.define("memory_reload", {
  description: [
    "Reload the current session memory cache from disk.",
    "This refreshes the prepared memory pool and clears active recalled memory.",
    "Use it after the user manually edits memory files or when the current session memory cache may be stale.",
  ].join("\n"),
  parameters: z.object({}),
  async execute(_input, ctx) {
    const result = await Memory.reload({ session_id: ctx.sessionID })
    return {
      title: "Memory reloaded",
      output: [
        `Pool entries: ${result.snapshot.entries.length}`,
        "Active memory cleared.",
      ].join("\n"),
      metadata: {
        entries: result.snapshot.entries.length,
      },
    }
  },
})

export const MemoryReflectTool = Tool.define("memory_reflect", {
  description: [
    "Run LLM-based memory reflection/consolidation explicitly.",
    "Reflection reads short-term session memory, writes day-by-day long-term MEMORY files, and applies USER.md profile patches.",
    "Manual calls default to current_session; daily cron calls should use global.",
  ].join("\n"),
  parameters: z.object({
    scope: Memory.ReflectionScope.optional(),
    dry_run: z.boolean().default(false),
  }),
  async execute(input, ctx) {
    const result = await Memory.reflect({
      session_id: ctx.sessionID,
      scope: input.scope,
      dry_run: input.dry_run,
      trigger: "manual",
    })
    return {
      title: "Memory reflection",
      output: result.events.length ? Memory.format(result.events) : result.summary || "No memory changes.",
      metadata: {
        blocked: result.status === "failed",
        status: result.status,
        run_id: result.run_id,
        count: result.events.length,
      },
    }
  },
})

export const MemoryRefreshTool = Tool.define("memory_refresh", {
  description: [
    "Initialize or refresh durable memory from historical local conversation databases.",
    "Use this only when the user explicitly asks to initialize, backfill, refresh, or import memory from previous conversations.",
    "This may call the configured reflection model when historical sources need promotion.",
    "Use scope=current_project to limit work to the current project, or scope=global to scan all local Aether databases.",
    "Set force=true only when the user explicitly asks to rebuild or rerun completed backfill work.",
  ].join("\n"),
  parameters: z.object({
    scope: Memory.RefreshScope.default("current_project"),
    force: z.boolean().default(false),
  }),
  async execute(input) {
    const result = await Memory.refreshRun({
      scope: input.scope,
      force: input.force,
    })
    const run = result.run
    const status = run?.status ?? result.status.run_status ?? result.status.state
    const lines = [
      `Status: ${status}`,
      `Scope: ${run?.scope ?? result.status.scope ?? input.scope}`,
      `Candidates: ${run?.candidate_count ?? result.status.candidate_count ?? 0}`,
      `Daily memories: ${run?.promoted_daily_count ?? result.status.promoted_daily_count ?? 0}`,
      `USER entries: ${run?.promoted_user_count ?? result.status.promoted_user_count ?? 0}`,
    ]
    const error = run?.error ?? run?.cache_refresh_error ?? result.status.error ?? result.status.cache_refresh_error
    if (error) lines.push(`Error: ${error}`)
    return {
      title: "Memory refresh",
      output: lines.join("\n"),
      metadata: {
        blocked: status === "failed" || status === "blocked",
        status,
        scope: run?.scope ?? result.status.scope ?? input.scope,
        run_id: run?.run_id,
        candidates: run?.candidate_count ?? result.status.candidate_count ?? 0,
        promoted_daily: run?.promoted_daily_count ?? result.status.promoted_daily_count ?? 0,
        promoted_user: run?.promoted_user_count ?? result.status.promoted_user_count ?? 0,
      },
    }
  },
})
