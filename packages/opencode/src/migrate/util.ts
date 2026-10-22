import type { Event, Loss } from "./model"
import { MigrateError } from "./error"

const images = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const base64 = /^[A-Za-z0-9+/]*={0,2}$/
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function uuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const match = /^(?:urn:uuid:)?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i.exec(value)
  if (!match) return undefined
  return `${match[1]}-${match[2]}-${match[3]}-${match[4]}-${match[5]}`.toLowerCase()
}

export function requireUUID(value: unknown, label: string): string {
  const id = uuid(value)
  if (!id) throw new MigrateError(`${label} is not a UUID`)
  return id
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((item) => {
      if (typeof item === "string") return item ? [item] : []
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string")
        return [(item as Record<string, unknown>).text as string]
      return []
    })
    .filter(Boolean)
    .join("\n")
}

export function validRFC3339(value: unknown): string | undefined {
  const text = str(value)
  if (!text || !rfc3339.test(text) || Number.isNaN(Date.parse(text))) return undefined
  return text
}

export function toMillis(value: unknown): number | undefined {
  const text = validRFC3339(value)
  if (!text) return undefined
  return Date.parse(text)
}

export function fromMillis(value: number): string {
  return new Date(value).toISOString()
}

export function portableDataImage(value: unknown): [string, string] | undefined {
  const text = str(value)
  if (!text || !text.startsWith("data:")) return undefined
  const comma = text.indexOf(",")
  if (comma < 0) return undefined
  const header = text.slice(0, comma)
  const data = text.slice(comma + 1)
  if (!header.endsWith(";base64")) return undefined
  const mime = header.slice(5, -7)
  if (!images.has(mime) || !validBase64(data)) return undefined
  return [mime, data]
}

export function imageURLFromClaudeSource(value: unknown): string | undefined {
  const source = obj(value)
  const type = str(source.type)
  if (type === "base64") {
    const mime = str(source.media_type)
    const data = str(source.data)
    if (mime && images.has(mime) && data && validBase64(data)) return `data:${mime};base64,${data}`
    return undefined
  }
  if (type === "url") {
    const url = str(source.url)
    if (url && (url.startsWith("https://") || url.startsWith("http://"))) return url
  }
  return undefined
}

export function imageFilePart(url: string, header: { id: string; sessionID: string; messageID: string }) {
  const data = portableDataImage(url)
  if (!data) return undefined
  return {
    id: header.id,
    sessionID: header.sessionID,
    messageID: header.messageID,
    type: "file" as const,
    mime: data[0],
    url,
  }
}

export function titleText(value: unknown): string | undefined {
  const text = str(value)
  if (!text) return undefined
  const clean = text.replace(/\s+/g, " ").trim()
  if (!clean) return undefined
  const head = clean.slice(0, 300).toLowerCase()
  if (
    head.startsWith("# agents.md") ||
    head.startsWith("<instructions") ||
    head.startsWith("<environment_context") ||
    head.startsWith("<user_instructions") ||
    head.startsWith("<permissions") ||
    head.startsWith("<system") ||
    head.startsWith("<developer") ||
    head.includes("agents.md instructions")
  ) {
    return undefined
  }
  return clean.length > 80 ? `${clean.slice(0, 80)}...` : clean
}

export function omissionKey(event: Event): string {
  if (event.kind === "message" && event.role !== "user" && event.role !== "assistant") return "message:privileged_role"
  if (event.kind === "compaction" && event.payload.replacement_history_expanded === true) {
    return "compaction:replacement_history_expanded"
  }
  if (event.kind === "context") {
    const block = str(event.payload.block_type)
    if (event.role === "system" && block === "image") return "context:privileged_image"
    const record = str(event.payload.source_record_type)
    if (record) return `context:${record}`
    return `context:${block ?? "unknown"}`
  }
  if (event.kind === "thinking") return "thinking"
  if (event.kind === "opaque") {
    const reason =
      str(event.payload.reason) ??
      str(event.payload.source_record_type) ??
      str(event.payload.source_event_type) ??
      str(event.payload.source_block_type) ??
      str(event.payload.source_item_type) ??
      "unknown"
    return `opaque:${reason}`
  }
  return event.kind
}

export function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false
  if (typeof value === "number" && value === 0) return false
  if (Array.isArray(value) && value.length === 0) return false
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return false
  return true
}

export function bump(loss: Loss, key: string, count = 1) {
  loss[key] = (loss[key] ?? 0) + count
}

export function sorted(loss: Loss): Loss {
  return Object.fromEntries(Object.entries(loss).sort(([a], [b]) => a.localeCompare(b)))
}

export function opaque(provenance: Event["provenance"], reason: string, payload: Record<string, unknown> = {}): Event {
  return { kind: "opaque", provenance, payload: { reason, ...payload } }
}

function validBase64(value: string) {
  return value.length % 4 === 0 && base64.test(value)
}
