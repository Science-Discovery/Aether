// Adapted from realtime-tex-vsc-plugin (MIT; see LICENSE in this directory).
// Mapping between source positions and preview positions through rtex spans and placements.
import type { Fragment } from "./protocol"

export interface Span {
  id: number
  kind: string
  hash: number
  last_revision: number
  range: { start: number; end: number }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The span containing byte `b` (the last span starting at or before `b`). */
export function spanAt(spans: readonly Span[], b: number): Span | undefined {
  let best: Span | undefined
  for (const span of spans) {
    if (span.range.start <= b && (best === undefined || span.range.start >= best.range.start)) best = span
  }
  return best
}

export interface Target {
  page: number
  /** Baseline of the target row, sp from the page top. */
  y: number
  x: number
  size?: number
}

function rowCount(frags: readonly Fragment[]): number {
  return frags.reduce((n, f) => n + f.baselines.length, 0)
}

/** The row `fraction` (0..1) of the way through a unit placed at `frags`. */
export function targetInFragments(frags: readonly Fragment[], fraction: number): Target | undefined {
  const n = rowCount(frags)
  if (n === 0) return undefined
  let k = Math.min(n - 1, Math.max(0, Math.floor(fraction * n)))
  for (const f of frags) {
    if (k < f.baselines.length) return { page: f.page, y: f.baselines[k], x: f.xs[k] ?? f.x }
    k -= f.baselines.length
  }
  return undefined
}

export interface Hit {
  parId: number
  /** Position of the hit row within the unit, 0..1. */
  fraction: number
}

/** The unit row nearest to (page, y) among `placed` units (rows within `maxDist` sp). */
export function hitTest(
  placed: ReadonlyMap<number, readonly Fragment[]>,
  page: number,
  y: number,
  maxDist = 40 * 65536,
): Hit | undefined {
  let best: { parId: number; row: number; rows: number; dist: number } | undefined
  for (const [parId, frags] of placed) {
    const rows = rowCount(frags)
    let row = 0
    for (const f of frags) {
      for (let i = 0; i < f.baselines.length; i++, row++) {
        if (f.page !== page) continue
        const dist = Math.abs(y - (f.baselines[i] - 3 * 65536))
        if (dist <= maxDist && (best === undefined || dist < best.dist)) best = { parId, row, rows, dist }
      }
    }
  }
  if (!best) return undefined
  return { parId: best.parId, fraction: best.rows > 1 ? best.row / best.rows : 0 }
}

/** Byte offset of a 1-based line and UTF-16 column in `text`. */
export function byteOffset(text: string, line: number, column: number) {
  let start = 0
  for (let n = 1; n < line; n++) {
    const at = text.indexOf("\n", start)
    if (at < 0) return encoder.encode(text).length
    start = at + 1
  }
  const newline = text.indexOf("\n", start)
  const end = newline < 0 ? text.length : newline
  const char = Math.min(end, start + Math.max(0, column - 1))
  return encoder.encode(text.slice(0, char)).length
}

/** 1-based line and UTF-16 column of a UTF-16 offset in `text`. */
export function lineColumn(text: string, offset: number) {
  const prefix = text.slice(0, Math.min(text.length, Math.max(0, offset)))
  const at = prefix.lastIndexOf("\n")
  return { line: prefix.split("\n").length, column: prefix.length - at }
}

/** UTF-16 offset in `text` for a UTF-8 byte offset, snapped back to a character boundary. */
export function utf16Offset(text: string, byte: number) {
  const bytes = encoder.encode(text)
  let at = Math.min(bytes.length, Math.max(0, byte))
  while (at > 0 && (bytes[at] & 0xc0) === 0x80) at--
  return decoder.decode(bytes.subarray(0, at)).length
}

/** The part of `text` in a UTF-8 byte range. */
export function sliceBytes(text: string, start: number, end: number) {
  return decoder.decode(encoder.encode(text).subarray(start, end))
}
