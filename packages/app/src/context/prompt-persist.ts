import type { FileSelection } from "./file"
import type { Prompt } from "./prompt"

const DEFAULT_PROMPT = [{ type: "text", content: "", start: 0, end: 0 }]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function range(value: unknown): FileSelection | undefined {
  if (!record(value)) return
  if (typeof value.startLine !== "number") return
  if (typeof value.startChar !== "number") return
  if (typeof value.endLine !== "number") return
  if (typeof value.endChar !== "number") return
  return {
    startLine: value.startLine,
    startChar: value.startChar,
    endLine: value.endLine,
    endChar: value.endChar,
  }
}

export function sanitizePrompt(value: unknown): Prompt {
  if (!Array.isArray(value)) return []
  return value.flatMap((part): Prompt => {
    if (!record(part)) return []
    if (part.type === "image" || "dataUrl" in part) return []
    if (typeof part.content !== "string") return []

    const start = typeof part.start === "number" ? part.start : 0
    const end = typeof part.end === "number" ? part.end : part.content.length
    if (part.type === "text") return [{ type: "text", content: part.content, start, end }]
    if (part.type === "agent" && typeof part.name === "string") {
      return [{ type: "agent", content: part.content, start, end, name: part.name }]
    }
    if (part.type !== "file" || typeof part.path !== "string") return []
    return [
      {
        type: "file",
        content: part.content,
        start,
        end,
        path: part.path,
        selection: range(part.selection),
      },
    ]
  })
}

export function sanitizePromptState(value: unknown): Record<string, unknown> {
  if (!record(value)) return { prompt: DEFAULT_PROMPT, context: { items: [] } }
  const prompt = sanitizePrompt(value.prompt)
  const context = record(value.context) && Array.isArray(value.context.items) ? value.context : { items: [] }
  return { ...value, prompt: prompt.length ? prompt : DEFAULT_PROMPT, context }
}
