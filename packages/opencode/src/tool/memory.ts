import z from "zod"
import { Memory } from "@/memory"
import { Tool } from "./tool"

const MemoryType = z.enum(["preference", "fact", "task"])

function renderResults(results: Awaited<ReturnType<typeof Memory.search>>["results"]) {
  if (!results.length) return '<memory_search results="0">No matching long-term memories.</memory_search>'
  return [
    `<memory_search results="${results.length}">`,
    ...results.map((item) =>
      [
        `  <memory id="${item.id}" type="${item.type}" scope="${item.scope}" confidence="${item.confidence}" weight="${item.weight}">`,
        `    ${item.memory}`,
        "  </memory>",
      ].join("\n"),
    ),
    "</memory_search>",
    "Results are ranked by relevance, scope, weight, and recency. These are long-term memory evidence; raw event ids are not exposed.",
  ].join("\n")
}

export const MemorySearchTool = Tool.define("memory_search", {
  description: [
    "Search Aether long-term memory. Use this when a memory shortcut suggests relevant user preferences, facts, or tasks.",
    "Use mode=overview when the user asks for a broad summary of remembered context instead of a narrow keyword lookup.",
    "Search only reads AETHER_MEMORY.md and does not read raw session files or aether-memory.db events.",
  ].join("\n"),
  parameters: z.object({
    query: z.string().min(1),
    mode: z.enum(["search", "overview"]).optional(),
    types: z.array(MemoryType).optional(),
    limit: z.number().int().optional(),
    currentProjectID: z.string().optional(),
  }),
  async execute(input) {
    const result = await Memory.search(input)
    return {
      title: `${result.results.length} memory result${result.results.length === 1 ? "" : "s"}`,
      output: renderResults(result.results),
      metadata: {
        count: result.results.length,
        ids: result.results.map((item) => item.id),
      },
    }
  },
})

export const MemoryRememberTool = Tool.define("memory_remember", {
  description:
    "Record a user-requested memory. Explicit memories are immediately passed to quick LLM reflection, which may write the accepted memory into AETHER_MEMORY.md.",
  parameters: z.object({
    text: z.string().min(1),
    type: MemoryType.optional(),
    project_id: z.string().optional(),
  }),
  async execute(input, ctx) {
    const result = await Memory.remember({
      text: input.text,
      type: input.type,
      intent: "explicit",
      source: {
        createdAt: Date.now(),
        projectID: input.project_id,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        role: "user",
      },
      signal: ctx.abort,
    })
    return {
      title: `Memory event ${result.status}`,
      output: `Memory event ${result.eventID} ${result.status}.${result.reason ? ` Reason: ${result.reason}` : ""}`,
      metadata: result,
    }
  },
})

export const MemoryForgetTool = Tool.define("memory_forget", {
  description: "Forget matching long-term memories. Natural-language requests are searched first, then matching Markdown memory blocks are deleted through MemoryService.",
  parameters: z.object({
    query: z.string().min(1).optional(),
    ids: z.array(z.string().min(1)).optional(),
    type: MemoryType.optional(),
  }),
  async execute(input, ctx) {
    const result = await Memory.forget({
      query: input.query,
      ids: input.ids,
      type: input.type,
      source: {
        createdAt: Date.now(),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        role: "user",
      },
      signal: ctx.abort,
    })
    return {
      title: result.status === "deleted" ? "Memory forgotten" : "No matching memory",
      output:
        result.status === "deleted"
          ? `Deleted memory ids: ${result.deletedIDs.join(", ")}`
          : "No matching long-term memory was found. No tombstone was recorded.",
      metadata: result,
    }
  },
})

export const MemoryReflectTool = Tool.define("memory_reflect", {
  description: [
    "Run memory reflection. Defaults to quick LLM reflection over user memory events only.",
    "Use mode=daily only when the user explicitly asks for full/global/daily memory reflection.",
  ].join("\n"),
  parameters: z.object({
    mode: z.enum(["quick", "daily", "manual"]).optional(),
    reason: z.string().optional(),
  }),
  async execute(input, ctx) {
    const result = await Memory.reflect({ mode: input.mode ?? "quick", reason: input.reason ?? "tool", signal: ctx.abort })
    return {
      title: `Memory reflect: ${result.summary}`,
      output: result.summary,
      metadata: result,
    }
  },
})
