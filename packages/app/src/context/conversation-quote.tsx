import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type ConversationQuotePendingQuestion =
  | {
      kind: "assistant-text-question"
      sessionID: string
      sourceMessageID: string
      text: string
      summary: string
      createdAt: number
    }
  | null

type Store = {
  pendingQuestion: ConversationQuotePendingQuestion
}

type Ctx = {
  store: Store
  setPendingQuestion: (question: ConversationQuotePendingQuestion) => void
  clearPendingQuestion: () => void
}

const ConversationQuoteContext = createContext<Ctx>()

export function ConversationQuoteProvider(props: ParentProps) {
  const [store, setStore] = createStore<Store>({
    pendingQuestion: null,
  })

  const ctx: Ctx = {
    store,
    setPendingQuestion: (question) => setStore("pendingQuestion", question),
    clearPendingQuestion: () => setStore("pendingQuestion", null),
  }

  return <ConversationQuoteContext.Provider value={ctx}>{props.children}</ConversationQuoteContext.Provider>
}

export function useConversationQuote() {
  const ctx = useContext(ConversationQuoteContext)
  if (!ctx) throw new Error("useConversationQuote must be used within ConversationQuoteProvider")
  return ctx
}

export function useMaybeConversationQuote() {
  return useContext(ConversationQuoteContext)
}
