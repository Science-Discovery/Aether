import z from "zod"

export const SessionBackupSchema = z.object({
  version: z.literal(1),
  info: z.record(z.string(), z.unknown()),
  messages: z.array(
    z.object({
      info: z.record(z.string(), z.unknown()),
      parts: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
})

export type SessionBackupData = z.infer<typeof SessionBackupSchema>

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
}

export type TranscriptSession = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type TranscriptMessage = {
  info: {
    role: "user" | "assistant"
    time: {
      created: number
      completed?: number
    }
    agent?: string
    modelID?: string
  }
  parts: TranscriptPart[]
}

type TextPart = {
  type: "text"
  text: string
  synthetic?: boolean
}

type ReasoningPart = {
  type: "reasoning"
  text: string
}

type ToolPart = {
  type: "tool"
  tool: string
  state: {
    status: "pending" | "running" | "completed" | "error"
    input?: unknown
    output?: string
    error?: string
  }
}

type TranscriptPart = TextPart | ReasoningPart | ToolPart | { type: string }

export function createSessionBackup<
  S extends Record<string, unknown>,
  M extends Record<string, unknown>,
  P extends Record<string, unknown>,
>(info: S, messages: Array<{ info: M; parts: P[] }>) {
  return {
    version: 1 as const,
    info,
    messages,
  }
}

function title(input: string) {
  if (!input) return input
  return input[0]!.toUpperCase() + input.slice(1)
}

function tool(part: TranscriptPart): part is ToolPart {
  return part.type === "tool" && "state" in part && "tool" in part
}

function text(part: TranscriptPart): part is TextPart {
  return part.type === "text" && "text" in part
}

function reasoning(part: TranscriptPart): part is ReasoningPart {
  return part.type === "reasoning" && "text" in part
}

function header(msg: TranscriptMessage["info"], include: boolean) {
  if (!include) return "## Assistant\n\n"
  const time = msg.time.completed ? `${((msg.time.completed - msg.time.created) / 1000).toFixed(1)}s` : ""
  const head = [title(msg.agent ?? "assistant"), msg.modelID ?? "unknown", time].filter(Boolean).join(" · ")
  return `## Assistant (${head})\n\n`
}

function part(input: TranscriptPart, opts: TranscriptOptions) {
  if (text(input) && !input.synthetic) return `${input.text}\n\n`
  if (reasoning(input)) return opts.thinking ? `_Thinking:_\n\n${input.text}\n\n` : ""
  if (!tool(input)) return ""

  const detail = [
    opts.toolDetails && input.state.input
      ? `\n**Input:**\n\`\`\`json\n${JSON.stringify(input.state.input, null, 2)}\n\`\`\`\n`
      : "",
    opts.toolDetails && input.state.status === "completed" && input.state.output
      ? `\n**Output:**\n\`\`\`\n${input.state.output}\n\`\`\`\n`
      : "",
    opts.toolDetails && input.state.status === "error" && input.state.error
      ? `\n**Error:**\n\`\`\`\n${input.state.error}\n\`\`\`\n`
      : "",
  ].join("")
  return `**Tool: ${input.tool}**\n${detail}\n`
}

function message(msg: TranscriptMessage, opts: TranscriptOptions) {
  const head = msg.info.role === "user" ? "## User\n\n" : header(msg.info, opts.assistantMetadata)
  return head + msg.parts.map((input) => part(input, opts)).join("")
}

export function formatTranscript(session: TranscriptSession, messages: TranscriptMessage[], opts: TranscriptOptions) {
  const head = [
    `# ${session.title}`,
    `**Session ID:** ${session.id}`,
    `**Created:** ${new Date(session.time.created).toLocaleString()}`,
    `**Updated:** ${new Date(session.time.updated).toLocaleString()}`,
    "---",
  ].join("\n\n")
  return `${head}\n\n${messages.map((msg) => `${message(msg, opts)}---\n\n`).join("")}`
}
