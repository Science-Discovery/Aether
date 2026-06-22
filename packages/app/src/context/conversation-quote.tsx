import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type ConversationQuotePendingQuestion = {
  kind: "assistant-text-question"
  sessionID: string
  sourceMessageID: string
  text: string
  summary: string
  createdAt: number
}

type Store = {
  pendingQuestions: ConversationQuotePendingQuestion[]
}

type Ctx = {
  store: Store
  addPendingQuestion: (question: ConversationQuotePendingQuestion) => void
  removePendingQuestion: (question: ConversationQuotePendingQuestion) => void
  clearPendingQuestions: (sessionID?: string) => void
}

const Context = createContext<Ctx>()

export function ConversationQuoteProvider(props: ParentProps) {
  const [store, setStore] = createStore<Store>({
    pendingQuestions: [],
  })

  const ctx: Ctx = {
    store,
    addPendingQuestion: (question) =>
      setStore("pendingQuestions", (items) => [
        ...items.filter((item) => item.sessionID !== question.sessionID || item.sourceMessageID !== question.sourceMessageID || item.text !== question.text),
        question,
      ]),
    removePendingQuestion: (question) =>
      setStore("pendingQuestions", (items) =>
        items.filter(
          (item) =>
            item.sessionID !== question.sessionID ||
            item.sourceMessageID !== question.sourceMessageID ||
            item.text !== question.text,
        ),
      ),
    clearPendingQuestions: (sessionID) =>
      setStore("pendingQuestions", (items) => (sessionID ? items.filter((item) => item.sessionID !== sessionID) : [])),
  }

  return <Context.Provider value={ctx}>{props.children}</Context.Provider>
}

export function useConversationQuote() {
  const ctx = useContext(Context)
  if (!ctx) throw new Error("useConversationQuote must be used within ConversationQuoteProvider")
  return ctx
}

export function useMaybeConversationQuote() {
  return useContext(Context)
}
