// Adapted from realtime-tex-vsc-plugin (MIT).
import type { FontDesc } from "./protocol"

export function fontKey(desc: FontDesc): string {
  if (desc.filename) return `file:${desc.filename}#${desc.subfont ?? 0}`
  return `tfm:${desc.name ?? desc.id}`
}

export type FontResource =
  | { kind: "sfnt"; data: Uint8Array }
  | { kind: "type1"; upem: number; glyphs: Record<number, string>; slant?: number; extend?: number }
  | { kind: "missing"; reason: string }

export type ImageResource =
  | { kind: "bitmap" | "pdf"; mime: string; data: Uint8Array }
  | { kind: "missing"; reason: string }
