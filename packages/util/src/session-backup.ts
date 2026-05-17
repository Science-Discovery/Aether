import z from "zod"

export const SessionBackupSchema = z.object({
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

export type TranscriptTextPart = {
  type: "text"
  text: string
  synthetic?: boolean
}

export type TranscriptReasoningPart = {
  type: "reasoning"
  text: string
}

export type TranscriptToolPart = {
  type: "tool"
  tool: string
  state: {
    status: "pending" | "running" | "completed" | "error"
    input?: unknown
    output?: string
    error?: string
  }
}

export type TranscriptPart =
  | TranscriptTextPart
  | TranscriptReasoningPart
  | TranscriptToolPart
  | {
      type: string
    }

export function createSessionBackup<
  TSession extends Record<string, unknown>,
  TMessage extends Record<string, unknown>,
  TPart extends Record<string, unknown>,
>(info: TSession, messages: Array<{ info: TMessage; parts: TPart[] }>) {
  return {
    info,
    messages,
  }
}

function title(input: string) {
  if (!input) return input
  return input[0]!.toUpperCase() + input.slice(1)
}

function isTool(part: TranscriptPart): part is TranscriptToolPart {
  return part.type === "tool" && "state" in part && "tool" in part
}

function isText(part: TranscriptPart): part is TranscriptTextPart {
  return part.type === "text" && "text" in part
}

function isReasoning(part: TranscriptPart): part is TranscriptReasoningPart {
  return part.type === "reasoning" && "text" in part
}

export function formatTranscript(session: TranscriptSession, messages: TranscriptMessage[], opts: TranscriptOptions) {
  let text = `# ${session.title}\n\n`
  text += `**Session ID:** ${session.id}\n`
  text += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  text += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  text += `---\n\n`

  for (const msg of messages) {
    text += formatMessage(msg, opts)
    text += `---\n\n`
  }

  return text
}

export function formatMessage(msg: TranscriptMessage, opts: TranscriptOptions) {
  let text = ""
  if (msg.info.role === "user") text += `## User\n\n`
  if (msg.info.role === "assistant") text += formatAssistantHeader(msg.info, opts.assistantMetadata)
  for (const part of msg.parts) {
    text += formatPart(part, opts)
  }
  return text
}

export function formatAssistantHeader(msg: TranscriptMessage["info"], include: boolean) {
  if (!include) return `## Assistant\n\n`
  const time =
    msg.time.completed && msg.time.created ? `${((msg.time.completed - msg.time.created) / 1000).toFixed(1)}s` : ""
  const head = [title(msg.agent ?? "assistant"), msg.modelID ?? "unknown", time].filter(Boolean).join(" · ")
  return `## Assistant (${head})\n\n`
}

export function formatPart(part: TranscriptPart, opts: TranscriptOptions) {
  if (isText(part) && !part.synthetic) return `${part.text}\n\n`
  if (isReasoning(part)) return opts.thinking ? `_Thinking:_\n\n${part.text}\n\n` : ""
  if (!isTool(part)) return ""

  let text = `**Tool: ${part.tool}**\n`
  if (opts.toolDetails && part.state.input) {
    text += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
  }
  if (opts.toolDetails && part.state.status === "completed" && part.state.output) {
    text += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
  }
  if (opts.toolDetails && part.state.status === "error" && part.state.error) {
    text += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
  }
  return text + `\n`
}
