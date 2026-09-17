import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

export type FileQuoteQuestion = {
  sessionID: string
  path: string
  startLine?: number
  endLine?: number
  text: string
  summary: string
  createdAt: number
}

type Store = {
  question: FileQuoteQuestion | null
}

type Ctx = {
  store: Store
  setQuestion: (question: FileQuoteQuestion | null) => void
}

const Context = createContext<Ctx>()

export function FileQuoteProvider(props: ParentProps) {
  const [store, setStore] = createStore<Store>({
    question: null,
  })

  const ctx: Ctx = {
    store,
    setQuestion: (question) => setStore("question", question),
  }

  return <Context.Provider value={ctx}>{props.children}</Context.Provider>
}

export function useFileQuote() {
  const ctx = useContext(Context)
  if (!ctx) throw new Error("useFileQuote must be used within FileQuoteProvider")
  return ctx
}

export function useMaybeFileQuote() {
  return useContext(Context)
}
