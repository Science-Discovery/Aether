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
    "All writes go to the current session memory file first; durable-looking notes may also be mirrored to a pending inbox for immediate cross-session memory_search recall.",
    "Later reflection can consolidate session and inbox items into USER or daily MEMORY.",
    "If the user asks to remember something long-term, write that request in natural language in the note.",
    "Use scope(project-...), scope(workspace-...), or scope(session-...) in the note when the preference/fact/task is not globally valid.",
    "Do not store transient logs or secrets.",
    "The written note is silently added to active memory and remains available in this session.",
  ].join("\n"),
  parameters: z.object({
    store: Memory.Store.default("memory").describe("Intended future store for reflection; write still goes to session memory."),
    action: z.enum(["add", "replace", "remove"]),
    value: z.string().optional().describe("Natural-language memory note."),
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
    const value =
      input.store === "user" && input.profile
        ? `${input.profile.type}[${input.profile.source}]: ${input.profile.content}`
        : input.value
    const result = await Memory.write({
      session_id: ctx.sessionID,
      store: input.store,
      action: input.action,
      value,
      index: input.index,
      match: input.match,
      reason: input.reason,
    })

    if (!result.ok) return blocked(result.events[0]?.summary ?? "Write blocked")
    return {
      title: "Memory updated",
      output: [
        "Store: session",
        `File: ${result.session.file}`,
        `Used: ${result.session.used}`,
        "",
        renderEntries(result.session.entries),
      ].join("\n"),
      metadata: {
        blocked: false,
        store: "session",
        intended_store: input.store,
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
    const lines = [
      `INBOX (${stores.inbox.used}/${stores.inbox.limit})`,
      renderEntries(stores.inbox.entries),
      "",
      `MEMORY (${stores.memory.used}/${stores.memory.limit})`,
      renderEntries(stores.memory.entries),
    ]
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
        inbox_used: stores.inbox.used,
        inbox_limit: stores.inbox.limit,
        memory_used: stores.memory.used,
        memory_limit: stores.memory.limit,
      },
    }
  },
})

export const MemorySearchTool = Tool.define("memory_search", {
  description: [
    "Search the current session prepared memory pool by keyword.",
    "The pool is initialized from USER.md, pending inbox memory, recent daily memory, and current session short-term memory.",
    "This is the only supported tool for recalling Aether memory.",
    "Do not use read, glob, grep, bash, or other file tools to inspect Aether memory files.",
    "Search accepts separated keywords; any keyword match is a candidate.",
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
    "Reflection reads short-term session memory plus pending inbox memory, writes day-by-day long-term MEMORY files, and applies USER.md profile patches.",
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
