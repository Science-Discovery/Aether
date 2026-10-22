export const sourceFormats = [
  "claude",
  "codex",
  "pi",
  "omp",
  "copilot",
  "opencode",
  "kilo",
  "qwen",
  "kimi",
  "vibe",
  "muse",
  "grok",
  "openhands",
  "qoder",
  "qodercn",
  "codebuddy",
] as const

export type SourceFormat = (typeof sourceFormats)[number]

export type Role = "user" | "assistant" | "system" | "tool"

export type EventKind = "message" | "tool_call" | "tool_result" | "thinking" | "compaction" | "context" | "opaque"

export type Provenance = {
  recordIndex: number
  recordType?: string
  sourceID?: string
  blockIndex?: number
}

export type Event = {
  kind: EventKind
  provenance: Provenance
  role?: Role
  timestamp?: string
  text?: string
  toolName?: string
  toolCallID?: string
  payload: Record<string, unknown>
}

export type ParsedSession = {
  source: SourceFormat
  path: string
  sha256: string
  sessionID?: string
  cwd?: string
  startedAt?: string
  cliVersion?: string
  model?: string
  provider?: string
  title?: string
  events: Event[]
  rawRecordCount: number
  parentActivity?: {
    timestamp?: number
    agent?: string
    callID?: string
  }
}

export type Loss = Record<string, number>

export type MigrateManifest = {
  source: SourceFormat
  path: string
  sha256: string
  sessionID?: string
  title?: string
  cwd?: string
  cliVersion?: string
  messages: number
  parts: number
  events: number
  loss: Loss
  warnings: string[]
}

export type SessionRef = {
  source: SourceFormat
  id: string
  path: string
  updated?: number
  title?: string
  cwd?: string
  parentID?: string
}
