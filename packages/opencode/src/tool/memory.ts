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

export const MemoryWriteTool = Tool.define("memory_write", {
  description: [
    "Directly edit durable memory entries in the USER or MEMORY store.",
    "MEMORY stores project/environment explicit durable facts.",
    "USER stores strict user-profile entries using type[source]: content format.",
    "Do not store transient logs or secrets.",
    "The main agent should use memory_write directly whenever it decides a durable memory/profile item should be stored or edited.",
  ].join("\n"),
  parameters: z.object({
    store: Memory.Store,
    action: z.enum(["add", "replace", "remove"]),
    value: z.string().optional().describe("Entry text. USER requires strict 'type[source]: content'."),
    profile: z
      .object({
        type: z.enum(["style", "workflow", "preference", "constraint", "capability"]),
        source: z.enum(["explicit", "inferred"]),
        content: z.string(),
      })
      .optional()
      .describe("Structured USER profile entry. If provided with store=user, value is built automatically."),
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
    const store = result.store ?? (await Memory.read(input.store))
    if (!store.enabled) {
      return {
        title: "Memory store disabled",
        output: `${store.store.toUpperCase()} store is disabled by settings.`,
        metadata: { blocked: false, store: store.store, enabled: false },
      }
    }
    return {
      title: "Memory updated",
      output: [`Store: ${store.store}`, `Used: ${store.used}/${store.limit}`, "", renderEntries(store.entries)].join("\n"),
      metadata: {
        blocked: false,
        store: store.store,
        used: store.used,
        limit: store.limit,
        enabled: store.enabled,
      },
    }
  },
})

export const MemoryReadTool = Tool.define("memory_read", {
  description: "Read durable memory entries from USER or MEMORY store.",
  parameters: z.object({
    store: Memory.Store,
    index: z.number().int().positive().optional(),
  }),
  async execute(input) {
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
  description: "List USER and MEMORY stores with usage and entries.",
  parameters: z.object({}),
  async execute() {
    const stores = await Memory.list()
    const lines = [`MEMORY (${stores.memory.used}/${stores.memory.limit})`, renderEntries(stores.memory.entries)]
    if (stores.user.enabled) {
      lines.push("", `USER (${stores.user.used}/${stores.user.limit})`, renderEntries(stores.user.entries))
    }
    return {
      title: "Memory stores",
      output: lines.join("\n"),
      metadata: {
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
  description: "Search USER and MEMORY entries by substring.",
  parameters: z.object({
    query: z.string(),
    store: Memory.Store.optional(),
    limit: z.number().int().positive().optional(),
  }),
  async execute(input) {
    const hits = await Memory.search(input)
    return {
      title: "Memory search",
      output: hits.length ? hits.map((hit) => `[${hit.store}] ${hit.index}. ${hit.text}`).join("\n") : "No matches.",
      metadata: { count: hits.length },
    }
  },
})

export const MemoryReflectTool = Tool.define("memory_reflect", {
  description: [
    "Run memory reflection/consolidation explicitly.",
    "Use strong mode near capacity or when aggressively deduping/merging; use light mode for routine cleanup.",
    "Optionally target only USER and/or MEMORY stores.",
  ].join("\n"),
  parameters: z.object({
    mode: z.enum(["light", "strong"]).default("light"),
    stores: z.array(Memory.Store).optional(),
  }),
  async execute(input, ctx) {
    const events = await Memory.reflect({
      session_id: ctx.sessionID,
      mode: input.mode,
      stores: input.stores,
    })
    return {
      title: "Memory reflection",
      output: events.length ? Memory.format(events) : "No memory changes.",
      metadata: { blocked: false, mode: input.mode, count: events.length },
    }
  },
})

export const SessionSearchTool = Tool.define("session_search", {
  description: [
    "Search historical sessions using existing message text records.",
    "Use this when users reference previous discussions, decisions, or work history.",
    "Results include summary and snippets. session_read remains explicit-only.",
  ].join("\n"),
  parameters: z.object({
    query: z.string(),
    limit: z.number().int().positive().optional(),
    scope: Memory.Scope.optional(),
  }),
  async execute(input, ctx) {
    const hits = await Memory.sessionSearch({
      session_id: ctx.sessionID,
      query: input.query,
      limit: input.limit,
      scope: input.scope,
    })
    if (!hits.length) return { title: "Session search", output: "No matching sessions found.", metadata: { count: 0 } }
    return {
      title: "Session search",
      output: hits
        .map((hit, idx) =>
          [
            `${idx + 1}. ${hit.title} (${hit.session_id})`,
            `Summary: ${hit.summary}`,
            ...hit.snippets.map((snippet, i) => `Snippet ${i + 1}: ${snippet}`),
          ].join("\n"),
        )
        .join("\n\n"),
      metadata: { count: hits.length },
    }
  },
})

export const SessionReadTool = Tool.define("session_read", {
  description: [
    "Read paginated full message history for a specific session.",
    "This tool is restricted and should only be used when the user explicitly asks for full/raw history.",
  ].join("\n"),
  parameters: z.object({
    session_id: z.string(),
    page: z.number().int().positive().default(1),
    page_size: z.number().int().positive().max(100).default(20),
    scope: Memory.Scope.optional(),
  }),
  async execute(input, ctx) {
    if (
      !Memory.canSessionRead({
        actor_session_id: ctx.sessionID,
        target_session_id: input.session_id,
        page: input.page,
        messages: ctx.messages,
      })
    ) {
      return blocked(
        "session_read is restricted: explicit user request for full/raw history is required before reading pages.",
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
      ...page.messages.map((message) =>
        [
          `[${message.role}] ${message.id}`,
          ...message.parts.map((part) => {
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
