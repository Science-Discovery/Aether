import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { NativePendingQuestions, NativeQuestion } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { observeNativeQuestion } from "./native-question-events"
import { Persist, persisted } from "@/utils/persist"

export type PendingQuestion = NativePendingQuestions[number]

export function createNativeQuestions(session: () => string | undefined, active: () => boolean = () => false) {
  const sdk = useSDK()
  const [store, setStore] = createStore({
    items: [] as PendingQuestion[],
    submitted: {} as Record<string, true>,
    updates: {} as Record<string, { question: NativeQuestion; version: number }>,
  })
  const key = (question: Pick<NativeQuestion, "thread" | "item">) => `${question.thread}\n${question.item}`

  createEffect(() => {
    const id = session()
    const url = sdk.url
    const directory = sdk.directory
    const client = sdk.client
    setStore(reconcile({ items: [], submitted: {}, updates: {} }))
    if (!id) return
    let disposed = false
    let busy = false
    let dirty = false
    let version = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (disposed) return
      if (busy) {
        dirty = true
        return
      }
      busy = true
      const stamp = version
      void client.native
        .questions({ sessionID: id }, { throwOnError: true })
        .then((result) => {
          if (disposed || !result.data) return
          setStore("items", reconcile(result.data))
          setStore(
            "updates",
            reconcile(Object.fromEntries(Object.entries(store.updates).filter(([, value]) => value.version > stamp))),
          )
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false
          if (!disposed && dirty) {
            dirty = false
            schedule()
          }
        })
    }
    const schedule = () => {
      if (timer || disposed) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, 400)
    }
    const events = sdk.event.listen((event) => {
      const data = event.details
      if (data.type !== "message.part.updated") return
      const part = data.properties.part
      if (part.sessionID !== id || part.type !== "text" || !part.nativeQuestion) return
      setStore("updates", key(part.nativeQuestion), { question: part.nativeQuestion, version: ++version })
      schedule()
    })
    const submitted = observeNativeQuestion((value) => {
      if (value.url !== url || value.directory !== directory || value.session !== id) return
      setStore("submitted", key(value), true)
      schedule()
    })
    refresh()
    const poll = setInterval(() => {
      if (store.items.length || active()) refresh()
    }, 15_000)
    window.addEventListener("focus", refresh)
    onCleanup(() => {
      disposed = true
      events()
      submitted()
      if (timer) clearTimeout(timer)
      clearInterval(poll)
      window.removeEventListener("focus", refresh)
    })
  })

  return createMemo(() =>
    store.items.filter((item) => {
      const id = key(item.question)
      const question = store.updates[id]?.question ?? item.question
      return !store.submitted[id] && question.state === "pending" && !question.answers
    }),
  )
}

export function NativeQuestionHint(props: {
  session: string
  items: PendingQuestion[]
  busy: boolean
  onOpen: (item: PendingQuestion) => void
}) {
  const sdk = useSDK()
  const scope = createMemo(() => props.session && JSON.stringify([sdk.url, sdk.directory, props.session]))
  return (
    <Show when={scope()} keyed>
      {(_) => <Reminder {...props} />}
    </Show>
  )
}

function sanitize(value: unknown) {
  if (!value || typeof value !== "object" || !("ignored" in value) || !Array.isArray(value.ignored))
    return { ignored: [] }
  return {
    ignored: [
      ...new Set(value.ignored.filter((item): item is string => typeof item === "string" && item.length <= 1000)),
    ],
  }
}

function Reminder(props: Parameters<typeof NativeQuestionHint>[0]) {
  const sdk = useSDK()
  const language = useLanguage()
  const [store, setStore, , ready] = persisted(
    {
      ...Persist.session(sdk.directory, props.session, `native-question-hints.v1:${base64Encode(sdk.url)}`),
      migrate: sanitize,
      sanitize,
    },
    createStore({ ignored: [] as string[] }),
  )
  const key = (item: PendingQuestion) => JSON.stringify([item.question.thread, item.question.item])
  const ignored = createMemo(() => new Set(store.ignored))
  const items = createMemo(() => (ready() ? props.items.filter((item) => !ignored().has(key(item))) : []))
  const ignore = () => {
    if (!ready() || props.busy) return
    const current = items().map(key)
    setStore("ignored", (previous) => [...new Set([...previous, ...current])])
  }
  return (
    <Show when={items().length}>
      <div class="flex items-center gap-2 py-1 text-12-regular text-text-weak" data-component="native-question-hint">
        <span role="status">{language.t("native.question.pending", { count: items().length })}</span>
        <Button size="small" variant="ghost" disabled={props.busy} onClick={() => props.onOpen(items()[0])}>
          {language.t(props.busy ? "native.question.locating" : "native.question.open")}
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={props.busy}
          title={language.t("native.question.ignore.description")}
          onClick={ignore}
        >
          {language.t("native.question.ignore")}
        </Button>
      </div>
    </Show>
  )
}
