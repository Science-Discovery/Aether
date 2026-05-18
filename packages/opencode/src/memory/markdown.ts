export type MemoryType = "preference" | "fact" | "task"
export type MemoryScope = "global" | `project:${string}`
export type MemoryStatus = "active" | "deprecated"

export type MemoryBlock = {
  id: string
  type: MemoryType
  scope: MemoryScope
  memory: string
  confidence: number
  weight: number
  evidence: string
  updated_at: string
  status: MemoryStatus
}

export type Shortcut = {
  shortcut: string
  triggers: string[]
  types: MemoryType[]
  target_ids: string[]
  weight: number
  instruction: string
}

export type MemoryDocument = {
  schema_version: number
  updated_at: string
  shortcuts: Shortcut[]
  memories: MemoryBlock[]
}

const SECTION_BY_TYPE: Record<MemoryType, string> = {
  preference: "Preferences",
  fact: "Facts",
  task: "Tasks",
}

export function emptyMemoryDocument(): MemoryDocument {
  return {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    shortcuts: [],
    memories: [],
  }
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseField(line: string) {
  const match = /^\s*(?:-\s*)?([^:]+):\s*(.*)$/.exec(line)
  if (!match) return
  return [match[1]!.trim(), match[2]!.trim()] as const
}

function sectionOf(id: string) {
  if (id.startsWith("PREF-")) return "preference"
  if (id.startsWith("FACT-")) return "fact"
  if (id.startsWith("TASK-")) return "task"
  return undefined
}

export function parseMemoryMarkdown(input: string): MemoryDocument {
  const doc = emptyMemoryDocument()
  const lines = input.replace(/\r\n/g, "\n").split("\n")
  let section = ""
  let currentShortcut: Partial<Shortcut> | undefined
  let currentMemory: Partial<MemoryBlock> & { id?: string } | undefined
  const flushShortcut = () => {
    if (!currentShortcut?.shortcut) return
    doc.shortcuts.push({
      shortcut: currentShortcut.shortcut,
      triggers: currentShortcut.triggers ?? [],
      types: currentShortcut.types ?? [],
      target_ids: currentShortcut.target_ids ?? [],
      weight: currentShortcut.weight ?? 0,
      instruction: currentShortcut.instruction ?? "",
    })
    currentShortcut = undefined
  }
  const flushMemory = () => {
    if (!currentMemory?.id) return
    const inferred = sectionOf(currentMemory.id)
    if (!currentMemory.type && inferred) currentMemory.type = inferred
    if (
      currentMemory.type &&
      currentMemory.scope &&
      currentMemory.memory &&
      currentMemory.evidence &&
      currentMemory.updated_at &&
      currentMemory.status
    ) {
      doc.memories.push({
        id: currentMemory.id,
        type: currentMemory.type,
        scope: currentMemory.scope,
        memory: currentMemory.memory,
        confidence: Number(currentMemory.confidence ?? 0),
        weight: Number(currentMemory.weight ?? 0),
        evidence: currentMemory.evidence,
        updated_at: currentMemory.updated_at,
        status: currentMemory.status,
      })
    }
    currentMemory = undefined
  }

  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line)
    if (h2) {
      flushShortcut()
      flushMemory()
      section = h2[1]!.trim()
      continue
    }

    const h3 = /^###\s+(.+)$/.exec(line)
    if (h3) {
      flushShortcut()
      flushMemory()
      currentMemory = { id: h3[1]!.trim() }
      continue
    }

    if (section === "Shortcut Directory" && line.startsWith("- shortcut:")) {
      flushShortcut()
      currentShortcut = { shortcut: line.replace("- shortcut:", "").trim() }
      continue
    }

    const field = parseField(line)
    if (!field) continue
    const [key, value] = field
    if (section === "Shortcut Directory" && currentShortcut) {
      if (key === "triggers") currentShortcut.triggers = parseList(value)
      if (key === "types") currentShortcut.types = parseList(value) as MemoryType[]
      if (key === "target_ids") currentShortcut.target_ids = parseList(value)
      if (key === "weight") currentShortcut.weight = Number(value)
      if (key === "instruction") currentShortcut.instruction = value
      continue
    }
    if (currentMemory) {
      if (key === "type") currentMemory.type = value as MemoryType
      if (key === "scope") currentMemory.scope = value as MemoryScope
      if (key === "memory") currentMemory.memory = value
      if (key === "confidence") currentMemory.confidence = Number(value)
      if (key === "weight") currentMemory.weight = Number(value)
      if (key === "evidence") currentMemory.evidence = value
      if (key === "updated_at") currentMemory.updated_at = value
      if (key === "status") currentMemory.status = value as MemoryStatus
    }
  }
  flushShortcut()
  flushMemory()
  return doc
}

function fmtNumber(value: number) {
  return Number.isFinite(value) ? String(Math.max(0, Math.min(1, value))) : "0"
}

export function renderMemoryDocument(input: MemoryDocument): string {
  const now = input.updated_at || new Date().toISOString()
  const lines: string[] = [
    "# Aether Memory",
    "",
    "<!--",
    `schema_version: ${input.schema_version || 1}`,
    `updated_at: ${now}`,
    "source: aether-memory.db",
    "search_target: true",
    "-->",
    "",
    "## Shortcut Directory",
    "",
    "> 这部分会被注入 system prompt。它不是完整记忆，只帮助 Agent 判断是否调用 memory.search。",
    "",
  ]

  for (const shortcut of input.shortcuts) {
    lines.push(
      `- shortcut: ${shortcut.shortcut}`,
      `  triggers: ${shortcut.triggers.join(", ")}`,
      `  types: ${shortcut.types.join(", ")}`,
      `  target_ids: ${shortcut.target_ids.join(", ")}`,
      `  weight: ${fmtNumber(shortcut.weight)}`,
      `  instruction: ${shortcut.instruction}`,
      "",
    )
  }

  for (const type of ["preference", "fact", "task"] as const) {
    lines.push("---", "", `## ${SECTION_BY_TYPE[type]}`, "")
    const memories = input.memories.filter((item) => item.type === type)
    for (const memory of memories) {
      lines.push(
        `### ${memory.id}`,
        `- type: ${memory.type}`,
        `- scope: ${memory.scope}`,
        `- memory: ${memory.memory}`,
        `- confidence: ${fmtNumber(memory.confidence)}`,
        `- weight: ${fmtNumber(memory.weight)}`,
        `- evidence: ${memory.evidence}`,
        `- updated_at: ${memory.updated_at}`,
        `- status: ${memory.status}`,
        "",
      )
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"
}
