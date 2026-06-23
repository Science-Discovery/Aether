export type ConversationQuote = {
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

  if (kind !== "conversation-quote") return
  if (source !== "assistant") return
  if (action !== "ask") return
  if (typeof sourceMessageID !== "string" || !sourceMessageID) return
  if (typeof summary !== "string") return
  if (typeof fullText !== "string" || !fullText) return

  return {
    kind,
    source,
    action,
    sourceMessageID,
    summary,
    fullText,
  } satisfies ConversationQuote
}
