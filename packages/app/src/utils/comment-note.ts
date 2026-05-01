import type { FileSelection } from "@/context/file"

export type PromptComment = {
  path: string
  selection?: FileSelection
  comment: string
  preview?: string
  origin?: "review" | "file"
}

export type ReadingQuote = {
  mode: "classic" | "quick"
  action: "ask" | "translate"
  contentType: "text" | "image"
  pdfFileName: string
  startPage: number
  endPage?: number
  summary: string
  fullText?: string
  imageDataUrl?: string
}

function selection(selection: unknown) {
  if (!selection || typeof selection !== "object") return undefined
  const startLine = Number((selection as FileSelection).startLine)
  const startChar = Number((selection as FileSelection).startChar)
  const endLine = Number((selection as FileSelection).endLine)
  const endChar = Number((selection as FileSelection).endChar)
  if (![startLine, startChar, endLine, endChar].every(Number.isFinite)) return undefined
  return {
    startLine,
    startChar,
    endLine,
    endChar,
  } satisfies FileSelection
}

export function createCommentMetadata(input: PromptComment) {
  return {
    opencodeComment: {
      path: input.path,
      selection: input.selection,
      comment: input.comment,
      preview: input.preview,
      origin: input.origin,
    },
  }
}

export function summarizeReadingQuoteText(text: string, maxLength = 180) {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return ""
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`
}

export function formatReadingPageRange(input: { startPage: number; endPage?: number }) {
  return input.endPage && input.endPage > input.startPage
    ? `${input.startPage}-${input.endPage}`
    : `${input.startPage}`
}

export function createReadingQuoteMetadata(input: ReadingQuote) {
  return {
    opencodeReadingQuote: {
      mode: input.mode,
      action: input.action,
      contentType: input.contentType,
      pdfFileName: input.pdfFileName,
      startPage: input.startPage,
      endPage: input.endPage,
      summary: input.summary,
      fullText: input.fullText,
      imageDataUrl: input.imageDataUrl,
    },
  }
}

export function readReadingQuoteMetadata(value: unknown) {
  if (!value || typeof value !== "object") return
  const meta = (value as { opencodeReadingQuote?: unknown }).opencodeReadingQuote
  if (!meta || typeof meta !== "object") return

  const mode = (meta as { mode?: unknown }).mode
  const action = (meta as { action?: unknown }).action
  const contentType = (meta as { contentType?: unknown }).contentType
  const pdfFileName = (meta as { pdfFileName?: unknown }).pdfFileName
  const startPage = Number((meta as { startPage?: unknown }).startPage ?? (meta as { page?: unknown }).page)
  const rawEndPage = (meta as { endPage?: unknown }).endPage
  const summary = (meta as { summary?: unknown }).summary
  const fullText = (meta as { fullText?: unknown }).fullText
  const imageDataUrl = (meta as { imageDataUrl?: unknown }).imageDataUrl

  if (mode !== "classic" && mode !== "quick") return
  if (action !== "ask" && action !== "translate") return
  if (contentType !== "text" && contentType !== "image") return
  if (typeof pdfFileName !== "string" || !pdfFileName) return
  if (!Number.isFinite(startPage) || startPage < 1) return
  if (typeof summary !== "string") return

  const endPage =
    typeof rawEndPage === "number" && Number.isFinite(rawEndPage) && rawEndPage >= startPage ? rawEndPage : undefined

  return {
    mode,
    action,
    contentType,
    pdfFileName,
    startPage,
    endPage,
    summary,
    fullText: typeof fullText === "string" ? fullText : undefined,
    imageDataUrl: typeof imageDataUrl === "string" ? imageDataUrl : undefined,
  } satisfies ReadingQuote
}

export function readCommentMetadata(value: unknown) {
  if (!value || typeof value !== "object") return
  const meta = (value as { opencodeComment?: unknown }).opencodeComment
  if (!meta || typeof meta !== "object") return
  const path = (meta as { path?: unknown }).path
  const comment = (meta as { comment?: unknown }).comment
  if (typeof path !== "string" || typeof comment !== "string") return
  const preview = (meta as { preview?: unknown }).preview
  const origin = (meta as { origin?: unknown }).origin
  return {
    path,
    selection: selection((meta as { selection?: unknown }).selection),
    comment,
    preview: typeof preview === "string" ? preview : undefined,
    origin: origin === "review" || origin === "file" ? origin : undefined,
  } satisfies PromptComment
}

export function formatCommentNote(input: { path: string; selection?: FileSelection; comment: string }) {
  const start = input.selection ? Math.min(input.selection.startLine, input.selection.endLine) : undefined
  const end = input.selection ? Math.max(input.selection.startLine, input.selection.endLine) : undefined
  const range =
    start === undefined || end === undefined
      ? "this file"
      : start === end
        ? `line ${start}`
        : `lines ${start} through ${end}`
  return `The user made the following comment regarding ${range} of ${input.path}: ${input.comment}`
}

export function parseCommentNote(text: string) {
  const match = text.match(
    /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/,
  )
  if (!match) return
  const start = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined
  const end = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined
  return {
    path: match[5],
    selection:
      start !== undefined && end !== undefined
        ? {
            startLine: start,
            startChar: 0,
            endLine: end,
            endChar: 0,
          }
        : undefined,
    comment: match[6],
  } satisfies PromptComment
}
