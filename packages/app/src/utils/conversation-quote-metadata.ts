import { readReadingQuoteMetadata, type ReadingQuote } from "./comment-note"

export type ConversationQuote = {
  id?: string
  question?: string
  order?: number
  start?: number
  end?: number
  kind: "conversation-quote"
  source: "assistant"
  action: "ask"
  sourceMessageID: string
  summary: string
  fullText: string
}

export function createConversationQuoteMetadata(input: ConversationQuote) {
  return {
    opencodeConversationQuote: {
      id: input.id,
      question: input.question,
      order: input.order,
      start: input.start,
      end: input.end,
      kind: input.kind,
      source: input.source,
      action: input.action,
      sourceMessageID: input.sourceMessageID,
      summary: input.summary,
      fullText: input.fullText,
    },
  }
}

export function readConversationQuoteMetadata(value: unknown) {
  if (!value || typeof value !== "object") return
  const meta = (value as { opencodeConversationQuote?: unknown }).opencodeConversationQuote
  if (!meta || typeof meta !== "object") return

  const kind = (meta as { kind?: unknown }).kind
  const source = (meta as { source?: unknown }).source
  const action = (meta as { action?: unknown }).action
  const sourceMessageID = (meta as { sourceMessageID?: unknown }).sourceMessageID
  const summary = (meta as { summary?: unknown }).summary
  const fullText = (meta as { fullText?: unknown }).fullText
  const extra = meta as Partial<ConversationQuote>

  if (kind !== "conversation-quote") return
  if (source !== "assistant") return
  if (action !== "ask") return
  if (typeof sourceMessageID !== "string" || !sourceMessageID) return
  if (typeof summary !== "string") return
  if (typeof fullText !== "string" || !fullText) return

  return {
    ...(typeof extra.id === "string" ? { id: extra.id } : {}),
    ...(typeof extra.question === "string" ? { question: extra.question } : {}),
    ...(Number.isInteger(extra.order) && extra.order! >= 0 ? { order: extra.order } : {}),
    ...(Number.isInteger(extra.start) && extra.start! >= 0 ? { start: extra.start } : {}),
    ...(Number.isInteger(extra.start) && extra.start! >= 0 && Number.isInteger(extra.end) && extra.end! >= extra.start!
      ? { end: extra.end }
      : {}),
    kind,
    source,
    action,
    sourceMessageID,
    summary,
    fullText,
  } satisfies ConversationQuote
}
export type QuoteReference = { kind: "conversation"; quote: ConversationQuote } | { kind: "pdf"; quote: ReadingQuote }

export function readQuoteReferences(parts: readonly { type?: string; metadata?: unknown }[]): QuoteReference[] {
  return parts
    .flatMap((part): QuoteReference[] => {
      const conversation = readConversationQuoteMetadata(part.metadata)
      if (conversation) return [{ kind: "conversation", quote: conversation }]
      const pdf = readReadingQuoteMetadata(part.metadata)
      return pdf ? [{ kind: "pdf", quote: pdf }] : []
    })
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => (a.ref.quote.order ?? a.index) - (b.ref.quote.order ?? b.index))
    .map(({ ref }) => ref)
}
