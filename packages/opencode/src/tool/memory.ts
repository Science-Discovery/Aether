import z from "zod"
import { Tool } from "./tool"
import { Memory } from "@/memory"

function block(reason: string) {
  return {
    title: "Memory action blocked",
    output: reason,
    metadata: {
      blocked: true,
    },
  }
}

function fmt(items: string[]) {
  if (!items.length) return "- (empty)"
  return items.map((item, idx) => `${idx + 1}. ${item}`).join("\n")
}

export const MemoryWriteTool = Tool.define("memory_write", {
  description: [
    "Write durable memory entries to the user or project store.",
    "This tool supports add/replace/remove operations and applies safety scanning automatically.",
    "Always prefer concise durable facts. Do not store temporary logs, large code blocks, or one-off debug noise.",
    "On blocked writes, the tool returns a safety/capacity reason. The assistant must continue safely.",
  ].join("\n"),
  parameters: z.object({
    store: Memory.Store.describe("Target store: user (global) or memory (current project)"),
    action: z.enum(["add", "replace", "remove"]),
    value: z.string().optional().describe("Memory text for add/replace"),
    index: z.number().int().positive().optional().describe("1-based index of target entry for replace/remove"),
    match: z.string().optional().describe("Substring match for target entry when index is not provided"),
    reason: z.enum(["auto_write", "history_extract", "reflection"]).optional(),
  }),
  async execute(input, ctx) {
    const result = await Memory.write({
      session_id: ctx.sessionID,
      store: input.store,
      action: input.action,
      value: input.value,
      index: input.index,
      match: input.match,
      reason: input.reason ?? "auto_write",
    })
    if (!result.ok) {
      return block(result.events[0]?.summary ?? "Write blocked")
    }
    const store = result.store ?? (await Memory.read(input.store))
    return {
      title: "Memory updated",
      output: [`Store: ${store.store}`, `Used: ${store.used}/${store.limit}`, "", fmt(store.entries)].join("\n"),
      metadata: {
        blocked: false,
        store: store.store,
        used: store.used,
        limit: store.limit,
      },
    }
  },
})

export const MemoryReadTool = Tool.define("memory_read", {
  description: [
    "Read memory entries from a specific store.",
    "Use this when you need exact durable memory contents before making a decision.",
  ].join("\n"),
  parameters: z.object({
    store: Memory.Store,
    index: z.number().int().positive().optional().describe("Optional 1-based index to read a single entry"),
  }),
  async execute(input) {
    const store = await Memory.read(input.store)
    if (input.index) {
      const item = store.entries[input.index - 1]
      if (!item) return block(`Entry ${input.index} not found in ${input.store} store`)
      return {
        title: "Memory entry",
        output: `${input.index}. ${item}`,
        metadata: {
          blocked: false,
          store: input.store,
          index: input.index,
        },
      }
    }
    return {
      title: "Memory store",
      output: [`Store: ${store.store}`, `Used: ${store.used}/${store.limit}`, "", fmt(store.entries)].join("\n"),
      metadata: {
        blocked: false,
        store: store.store,
        used: store.used,
        limit: store.limit,
      },
    }
  },
})

export const MemoryListTool = Tool.define("memory_list", {
  description: "List both memory stores with usage and all entries.",
  parameters: z.object({}),
  async execute() {
    const stores = await Memory.list()
    return {
      title: "Memory stores",
      output: [
        `USER (${stores.user.used}/${stores.user.limit})`,
        fmt(stores.user.entries),
        "",
        `MEMORY (${stores.memory.used}/${stores.memory.limit})`,
        fmt(stores.memory.entries),
      ].join("\n"),
      metadata: {
        user_used: stores.user.used,
        user_limit: stores.user.limit,
        memory_used: stores.memory.used,
        memory_limit: stores.memory.limit,
      },
    }
  },
})

export const MemorySearchTool = Tool.define("memory_search", {
  description: "Search entries in memory stores using exact substring matching.",
  parameters: z.object({
    query: z.string(),
    store: Memory.Store.optional(),
    limit: z.number().int().positive().optional(),
  }),
  async execute(input) {
    const hits = await Memory.search(input)
    return {
      title: "Memory search",
      output: hits.length
        ? hits.map((hit) => `[${hit.store}] ${hit.index}. ${hit.text}`).join("\n")
        : "No memory entries matched.",
      metadata: {
        count: hits.length,
      },
    }
  },
})

export const SessionSearchTool = Tool.define("session_search", {
  description: [
    "Search historical sessions by text over existing session/message records (no embedding).",
    "Use this tool proactively when users mention prior work, such as: previously, last time, remember, we discussed, earlier.",
    "Prefer this tool before answering from uncertain recollection.",
    "Respect settings: if cross-session search is disabled, do not force recall.",
    "Do not use session_read unless the user explicitly asks for full/raw/complete session content.",
  ].join("\n"),
  parameters: z.object({
    query: z.string().describe("Search query text"),
    limit: z.number().int().positive().optional(),
    scope: Memory.Scope.optional().describe("Override search scope: current_project or global"),
    extract_durable: z
      .boolean()
      .optional()
      .describe("Optionally extract conservative durable facts from snippets into memory stores"),
  }),
  async execute(input, ctx) {
    // Optional durable extraction is conservative and still goes through memory_write safety gates.
    const hits = await Memory.sessionSearch({
      session_id: ctx.sessionID,
      query: input.query,
      limit: input.limit,
      scope: input.scope,
    })
    if (input.extract_durable && hits.length > 0) {
      await Memory.extract({ session_id: ctx.sessionID, hits })
    }
    if (hits.length === 0) {
      return {
        title: "Session search",
        output: "No matching sessions found.",
        metadata: {
          count: 0,
        },
      }
    }
    return {
      title: "Session search",
      output: hits
        .map((hit, i) =>
          [
            `${i + 1}. ${hit.title} (${hit.session_id})`,
            `Summary: ${hit.summary}`,
            ...hit.snippets.map((x, idx) => `Snippet ${idx + 1}: ${x}`),
          ].join("\n"),
        )
        .join("\n\n"),
      metadata: {
        count: hits.length,
      },
    }
  },
})

export const SessionReadTool = Tool.define("session_read", {
  description: [
    "Read paginated full message history for a specific session.",
    "STRICT POLICY: only call this when the user explicitly asks for full/raw/complete historical session content.",
    "For normal recall use session_search first.",
  ].join("\n"),
  parameters: z.object({
    session_id: z.string(),
    page: z.number().int().positive().default(1),
    page_size: z.number().int().positive().max(100).default(20),
    scope: Memory.Scope.optional(),
  }),
  async execute(input, ctx) {
    // session_read stays opt-in: explicit user request first, then controlled page continuation.
    if (
      !Memory.canSessionRead({
        actor_session_id: ctx.sessionID,
        target_session_id: input.session_id,
        page: input.page,
        messages: ctx.messages,
      })
    ) {
      return block(
        "session_read is restricted: user must explicitly request full/raw history first. Follow-up pages are allowed after approval.",
      )
    }
    const page = await Memory.sessionRead(input)
    const lines = [
      `Session: ${page.title} (${page.session_id})`,
      `Page: ${page.page}`,
      `Page size: ${page.page_size}`,
      `Has more: ${page.has_more ? "yes" : "no"}`,
      `Next page: ${page.next_page ?? "-"}`,
      `Total messages: ${page.total_messages}`,
      "",
      ...page.messages.map((msg) =>
        [
          `[${msg.role}] ${msg.id}`,
          ...msg.parts.map((part) => {
            if (part.text) return `- (${part.type}) ${part.text}`
            if (part.data) return `- (${part.type}) ${JSON.stringify(part.data)}`
            return `- (${part.type})`
          }),
        ].join("\n"),
      ),
    ]
    return {
      title: "Session page",
      output: lines.join("\n\n"),
      metadata: {
        blocked: false,
        page: page.page,
        page_size: page.page_size,
        has_more: page.has_more,
        next_page: page.next_page,
      },
    }
  },
})
