import type { AgentPart as MessageAgentPart, FilePart, Part, TextPart } from "@opencode-ai/sdk/v2"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"

type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      selection?: {
        startLine: number
        endLine: number
        startChar: number
        endChar: number
      }
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }
  | { type: "skill"; start: number; end: number; value: string; name: string; path: string }

function selectionFromFileUrl(url: string): Extract<Inline, { type: "file" }>["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

function textPartValue(parts: Part[]) {
  const candidates = parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

export function skill(part: Part) {
  if (part.type !== "text") return
  const value = part.metadata?.nativeSkill
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !value.name.trim() ||
    !value.path.trim()
  )
    return
  return { name: value.name, path: value.path, source: "source" in value ? value.source : undefined }
}

/**
 * Extract prompt content from message parts for restoring into the prompt input.
 * This is used by undo to restore the original user prompt.
 */
export function extractPromptFromParts(parts: Part[], opts?: { directory?: string; attachmentName?: string }): Prompt {
  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const directory = opts?.directory
  const attachmentName = opts?.attachmentName ?? "attachment"

  const toRelative = (path: string) => {
    if (!directory) return path

    const prefix = directory.endsWith("/") ? directory : directory + "/"
    if (path.startsWith(prefix)) return path.slice(prefix.length)

    if (path.startsWith(directory)) {
      const next = path.slice(directory.length)
      if (next.startsWith("/")) return next.slice(1)
      return next
    }

    return path
  }

  const inline: Inline[] = []
  const images: ImageAttachmentPart[] = []
  const skills: Extract<Inline, { type: "skill" }>[] = []

  for (const part of parts) {
    const native = skill(part)
    if (native) {
      const source = native.source
      if (
        source &&
        typeof source === "object" &&
        "value" in source &&
        source.value === `$${native.name}` &&
        "start" in source &&
        typeof source.start === "number" &&
        Number.isInteger(source.start) &&
        source.start >= 0 &&
        "end" in source &&
        typeof source.end === "number" &&
        source.end === source.start + source.value.length
      )
        inline.push({
          type: "skill",
          name: native.name,
          path: native.path,
          value: source.value,
          start: source.start,
          end: source.end,
        })
      else {
        const value = `$${native.name}`
        const start = text.indexOf(value)
        const item = {
          type: "skill" as const,
          name: native.name,
          path: native.path,
          value,
          start,
          end: start + value.length,
        }
        if (start >= 0) inline.push(item)
        if (start < 0) skills.push(item)
      }
    }
    if (part.type === "file") {
      const filePart = part as FilePart
      const sourceText = filePart.source?.text
      if (sourceText) {
        const value = sourceText.value
        const start = sourceText.start
        const end = sourceText.end
        let path = value
        if (value.startsWith("@")) path = value.slice(1)
        if (!value.startsWith("@") && filePart.source && "path" in filePart.source) {
          path = filePart.source.path
        }
        inline.push({
          type: "file",
          start,
          end,
          value,
          path: toRelative(path),
          selection: selectionFromFileUrl(filePart.url),
        })
        continue
      }

      if (filePart.url.startsWith("data:")) {
        images.push({
          type: "image",
          id: filePart.id,
          filename: filePart.filename ?? attachmentName,
          mime: filePart.mime,
          dataUrl: filePart.url,
        })
      }
    }

    if (part.type === "agent") {
      const agentPart = part as MessageAgentPart
      const source = agentPart.source
      if (!source) continue
      inline.push({
        type: "agent",
        start: source.start,
        end: source.end,
        value: source.value,
        name: agentPart.name,
      })
    }
  }

  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  const result: Prompt = []
  let position = 0
  let cursor = 0

  const pushText = (content: string) => {
    if (!content) return
    result.push({
      type: "text",
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushFile = (item: Extract<Inline, { type: "file" }>) => {
    const content = item.value
    const attachment: FileAttachmentPart = {
      type: "file",
      path: item.path,
      content,
      start: position,
      end: position + content.length,
      selection: item.selection,
    }
    result.push(attachment)
    position += content.length
  }

  const pushAgent = (item: Extract<Inline, { type: "agent" }>) => {
    const content = item.value
    const mention: AgentPart = {
      type: "agent",
      name: item.name,
      content,
      start: position,
      end: position + content.length,
    }
    result.push(mention)
    position += content.length
  }

  for (const item of inline) {
    if (item.start < 0 || item.end < item.start) continue

    const expected = item.value
    if (!expected) continue

    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== expected
    const start = mismatch ? text.indexOf(expected, cursor) : item.start
    if (start === -1) {
      if (item.type === "skill") skills.push(item)
      continue
    }
    const end = mismatch ? start + expected.length : item.end

    pushText(text.slice(cursor, start))

    if (item.type === "file") pushFile(item)
    if (item.type === "agent") pushAgent(item)
    if (item.type === "skill") {
      result.push({
        type: "skill",
        name: item.name,
        path: item.path,
        content: item.value,
        start: position,
        end: position + item.value.length,
      })
      position += item.value.length
    }

    cursor = end
  }

  pushText(text.slice(cursor))
  for (const item of skills) {
    if (result.length) pushText(" ")
    result.push({
      type: "skill",
      name: item.name,
      path: item.path,
      content: item.value,
      start: position,
      end: position + item.value.length,
    })
    position += item.value.length
  }

  if (result.length === 0) {
    result.push({ type: "text", content: "", start: 0, end: 0 })
  }

  if (images.length === 0) return result
  return [...result, ...images]
}
