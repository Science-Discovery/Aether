type Base = {
  id: string
  version: number
  question: string
  text: string
  summary: string
}

export type Reference = Base &
  (
    | {
        kind: "conversation"
        messageID: string
        start: number
        end: number
      }
    | {
        kind: "pdf"
        path: string
        filename: string
        mode: "quick" | "classic"
        sourceSession?: string
        startPage: number
        endPage: number
        selection: string
        fingerprint?: string
        content: "text" | "image"
        image?: string
        settings: {
          questionPrompt: string
          contextPageRange?: 0 | 1 | 2
        }
        totalPages?: number
      }
  )

export function referenceKey(ref: Reference) {
  if (ref.kind === "conversation") return JSON.stringify([ref.kind, ref.messageID, ref.start, ref.end])
  return JSON.stringify([ref.kind, ref.path, ref.startPage, ref.endPage, ref.selection, ref.content, ref.fingerprint])
}

export function cloneReferences(refs: readonly Reference[]): Reference[] {
  return refs.map((ref) => (ref.kind === "pdf" ? { ...ref, settings: { ...ref.settings } } : { ...ref }))
}

export function restoreReferences(refs: readonly Reference[]) {
  return cloneReferences(refs).map((ref) => ({ ...ref, id: crypto.randomUUID(), version: 1 }))
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function sanitizeReferences(value: unknown): Reference[] {
  if (!Array.isArray(value)) return []
  const refs = value.flatMap((ref): Reference[] => {
    if (!record(ref) || typeof ref.id !== "string" || !ref.id || !integer(ref.version)) return []
    if (typeof ref.question !== "string" || typeof ref.text !== "string" || typeof ref.summary !== "string") return []
    const base = {
      id: ref.id,
      version: ref.version,
      question: ref.question,
      text: ref.text,
      summary: ref.summary,
    }
    if (ref.kind === "conversation") {
      if (typeof ref.messageID !== "string" || !ref.messageID) return []
      if (!integer(ref.start) || !integer(ref.end) || ref.end < ref.start) return []
      return [{ ...base, kind: ref.kind, messageID: ref.messageID, start: ref.start, end: ref.end }]
    }
    if (ref.kind !== "pdf" || typeof ref.path !== "string" || !ref.path || typeof ref.filename !== "string") return []
    if (ref.mode !== "quick" && ref.mode !== "classic") return []
    if (!integer(ref.startPage) || !ref.startPage || !integer(ref.endPage) || ref.endPage < ref.startPage) return []
    if (typeof ref.selection !== "string" || (ref.content !== "text" && ref.content !== "image")) return []
    if (!record(ref.settings) || typeof ref.settings.questionPrompt !== "string") return []
    const range = ref.settings.contextPageRange
    return [
      {
        ...base,
        kind: ref.kind,
        path: ref.path,
        filename: ref.filename,
        mode: ref.mode,
        ...(typeof ref.sourceSession === "string" ? { sourceSession: ref.sourceSession } : {}),
        startPage: ref.startPage,
        endPage: ref.endPage,
        selection: ref.selection,
        ...(typeof ref.fingerprint === "string" && ref.fingerprint ? { fingerprint: ref.fingerprint } : {}),
        content: ref.content,
        settings: {
          questionPrompt: ref.settings.questionPrompt,
          ...(range === 0 || range === 1 || range === 2 ? { contextPageRange: range } : {}),
        },
        ...(integer(ref.totalPages) && ref.totalPages >= ref.endPage ? { totalPages: ref.totalPages } : {}),
      },
    ]
  })
  const ids = new Set<string>()
  const keys = new Set<string>()
  return refs.filter((ref) => {
    const key = referenceKey(ref)
    if (ids.has(ref.id) || keys.has(key)) return false
    ids.add(ref.id)
    keys.add(key)
    return true
  })
}

export function canAsk(text: string, refs: readonly Reference[]) {
  return !!text.trim() || refs.some((ref) => !!ref.question.trim())
}

export function missingImages(refs: readonly Reference[]) {
  return refs.some((ref) => ref.kind === "pdf" && ref.content === "image" && !ref.image?.trim())
}

export function addReference(refs: readonly Reference[], ref: Reference) {
  const key = referenceKey(ref)
  const match =
    refs.find((item) => referenceKey(item) === key) ??
    refs.find(
      (item) =>
        ref.kind === "pdf" &&
        !!ref.fingerprint &&
        item.kind === "pdf" &&
        !item.fingerprint &&
        referenceKey(item) === referenceKey({ ...ref, fingerprint: undefined }),
    )
  if (!match) return cloneReferences([...refs, ref])
  return cloneReferences(
    refs.map((item) => (item.id === match.id ? { ...ref, id: item.id, version: item.version + 1 } : item)),
  )
}

export function updateReference(refs: readonly Reference[], id: string, question: string) {
  return cloneReferences(refs.map((ref) => (ref.id === id ? { ...ref, question, version: ref.version + 1 } : ref)))
}

export function clearReferences(refs: readonly Reference[], snapshot: readonly Reference[]) {
  const versions = new Map(snapshot.map((ref) => [ref.id, ref.version]))
  return cloneReferences(refs.filter((ref) => versions.get(ref.id) !== ref.version))
}

export type PdfMark = {
  id: string
  number: number
  pages: { page: number; quads: number[][] }[]
}

export function pdfMarks(
  refs: readonly Reference[],
  path: string | undefined,
  fingerprint: string | undefined,
): PdfMark[] {
  if (!path || !fingerprint) return []
  return refs.flatMap((ref, index): PdfMark[] => {
    if (ref.kind !== "pdf" || ref.path !== path || ref.fingerprint !== fingerprint) return []
    let value: unknown
    try {
      value = JSON.parse(ref.selection)
    } catch {
      return []
    }
    const points = (value: unknown, size: number): value is number[] =>
      Array.isArray(value) && value.length === size && value.every((n) => typeof n === "number" && Number.isFinite(n))
    if (ref.content === "image") {
      if (!points(value, 4)) return []
      const [x, y, right, bottom] = value
      if (x === right || y === bottom) return []
      return [
        {
          id: ref.id,
          number: index + 1,
          pages: [{ page: ref.startPage, quads: [[x, y, right, y, x, bottom, right, bottom]] }],
        },
      ]
    }
    if (!Array.isArray(value)) return []
    const pages = value.flatMap((part) => {
      if (
        !record(part) ||
        !integer(part.page) ||
        part.page < ref.startPage ||
        part.page > ref.endPage ||
        !Array.isArray(part.quads)
      )
        return []
      const quads = part.quads.filter((quad): quad is number[] => points(quad, 8))
      return quads.length ? [{ page: part.page, quads }] : []
    })
    return pages.length ? [{ id: ref.id, number: index + 1, pages }] : []
  })
}
