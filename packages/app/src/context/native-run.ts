import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  FilePartInput,
  NativeQueueStatus,
  NativeRuntimeResponse,
  NativeSteered,
  TextPartInput,
} from "@opencode-ai/sdk/v2"
import { Identifier } from "@/utils/id"
import { formatServerError } from "@/utils/server-errors"

export type NativeQueue = NativeQueueStatus
export type NativeRun = NativeRuntimeResponse
export type NativeDraft = { text: string; parts?: Array<TextPartInput | FilePartInput> }

function reason(err: unknown) {
  if (err && typeof err === "object" && "error" in err && typeof err.error === "string") return err.error
  return formatServerError(err)
}

export function createNativeRun(opts: {
  key: Accessor<string>
  id: Accessor<string | undefined>
  enabled: Accessor<boolean>
  working: Accessor<boolean>
  selection: () => { model?: string; effort?: string }
  read: (id: string) => Promise<NativeRun | undefined>
  send: (input: {
    sessionID: string
    messageID: string
    turnID: string
  }) => Promise<{ queue: NativeQueue; delivery: NativeSteered } | undefined>
  enqueue: (input: {
    sessionID: string
    messageID: string
    text: string
    parts?: NativeDraft["parts"]
    model?: string
    effort?: string
  }) => Promise<NativeQueue | undefined>
  dequeue: (input: { sessionID: string; messageID: string }) => Promise<NativeQueue | undefined>
  resume: (id: string) => Promise<NativeQueue | undefined>
}) {
  const [store, setStore] = createStore<{
    key: string
    data?: NativeRun
    error?: string
    loading: boolean
    busy: Record<string, boolean | undefined>
    attempts: Record<
      string,
      | {
          id: string
          text: string
          parts?: NativeDraft["parts"]
          fingerprint: string
          selection: { model?: string; effort?: string }
        }
      | undefined
    >
    dispatches: Record<string, { id: string; turn: string } | undefined>
    notices: Record<
      string,
      | { type: "queued" | "accepted" | "uncertain" | "rejected" | "error" | "discarded" | "retry"; text?: string }
      | undefined
    >
  }>({ key: "", loading: false, busy: {}, attempts: {}, dispatches: {}, notices: {} })
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  let disposed = false
  const current = () => opts.enabled() && !!opts.id() && store.key === opts.key()
  const data = () => (current() ? store.data : undefined)

  function refresh(force = false): Promise<void> {
    const id = opts.id()
    if (disposed || !opts.enabled() || !id) return Promise.resolve()
    if (pending && current() && !force) return pending
    const key = opts.key()
    const run = ++epoch
    clearTimeout(timer)
    setStore({ key, loading: true, error: undefined, ...(current() ? {} : { data: undefined }) })
    pending = opts
      .read(id)
      .then((value) => {
        if (disposed || run !== epoch || !opts.enabled() || key !== opts.key()) return
        if (!value) throw new Error("The Aether server did not return the Codex run state.")
        setStore("data", value)
      })
      .catch((err: unknown) => {
        if (disposed || run !== epoch || key !== opts.key()) return
        setStore("error", reason(err))
      })
      .finally(() => {
        if (disposed || run !== epoch || key !== opts.key()) return
        pending = undefined
        setStore("loading", false)
        // Poll only the selected running/queued session; idle sessions refresh
        // on navigation, status events, or an explicit user action.
        if (opts.enabled() && (opts.working() || store.data?.active || store.data?.queue.items.length))
          timer = setTimeout(() => void refresh(), store.error ? 5_000 : 2_000)
      })
    return pending
  }

  createEffect(
    on([opts.key, opts.enabled], () => {
      epoch++
      clearTimeout(timer)
      pending = undefined
      setStore({ key: "", data: undefined, error: undefined, loading: false })
      if (opts.enabled() && opts.id()) void refresh()
    }),
  )
  createEffect(
    on(
      opts.working,
      () => {
        if (opts.enabled() && opts.id()) void refresh()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    disposed = true
    epoch++
    clearTimeout(timer)
  })

  async function submit(value: string | NativeDraft) {
    const id = opts.id()
    const key = opts.key()
    const input: NativeDraft = typeof value === "string" ? { text: value } : JSON.parse(JSON.stringify(value))
    if (
      disposed ||
      !id ||
      !opts.enabled() ||
      store.busy[key] ||
      (!input.text.trim() && !input.parts?.some((part) => part.type === "file" || (!part.ignored && part.text.trim())))
    )
      return false
    const fingerprint = JSON.stringify({
      text: input.text,
      parts: input.parts?.map((part) => ({ ...part, id: undefined })),
    })
    const prior = store.attempts[key]
    const retry = prior?.fingerprint === fingerprint
    if (prior && !retry) {
      setStore("notices", key, { type: "retry" })
      return false
    }
    const attempt = retry
      ? prior
      : {
          id: Identifier.ascending("message"),
          text: input.text,
          parts: input.parts,
          fingerprint,
          selection: opts.selection(),
        }
    setStore("attempts", key, attempt)
    setStore("busy", key, true)
    setStore("notices", key, undefined)
    return (async () => {
      const result = await opts.enqueue({
        sessionID: id,
        messageID: attempt.id,
        text: attempt.text,
        parts: attempt.parts,
        ...attempt.selection,
      })
      if (!result) throw new Error("The Aether server did not confirm the queued message.")
      setStore("attempts", key, undefined)
      setStore("notices", key, { type: "queued" })
      return true
    })()
      .catch((err: unknown) => {
        setStore("notices", key, { type: "error", text: reason(err) })
        return false
      })
      .finally(() => {
        setStore("busy", key, false)
        if (!disposed && key === opts.key()) void refresh(true)
      })
  }

  async function send(messageID: string) {
    const sessionID = opts.id()
    const key = opts.key()
    if (disposed || !sessionID || !opts.enabled() || store.busy[key]) return false
    const prior = store.dispatches[key]
    if (prior && prior.id !== messageID) return false
    const turn = prior?.turn ?? data()?.active?.turnID
    if (
      !turn ||
      (!prior &&
        (!data()?.active?.steer ||
          !data()?.queue.items.some((item) => item.id === messageID && item.state === "pending")))
    )
      return false
    setStore("dispatches", key, { id: messageID, turn })
    setStore("busy", key, true)
    setStore("notices", key, undefined)
    return opts
      .send({ sessionID, messageID, turnID: turn })
      .then((result) => {
        if (!result) throw new Error("The Aether server did not confirm the queued message delivery.")
        setStore("dispatches", key, undefined)
        setStore("notices", key, { type: result.delivery.status, text: result.delivery.error })
        if (!disposed && key === opts.key() && data()) setStore("data", "queue", result.queue)
        return result.delivery.status !== "rejected"
      })
      .catch((err: unknown) => {
        setStore("notices", key, { type: "error", text: reason(err) })
        return false
      })
      .finally(() => {
        setStore("busy", key, false)
        if (!disposed && key === opts.key()) void refresh(true)
      })
  }

  async function change(id?: string) {
    const sessionID = opts.id()
    const key = opts.key()
    if (disposed || !sessionID || !opts.enabled() || store.busy[key]) return
    setStore("busy", key, true)
    setStore("notices", key, undefined)
    await (id ? opts.dequeue({ sessionID, messageID: id }) : opts.resume(sessionID))
      .catch((err: unknown) => setStore("notices", key, { type: "error", text: reason(err) }))
      .finally(() => {
        setStore("busy", key, false)
        if (!disposed && key === opts.key()) void refresh(true)
      })
  }

  return {
    data,
    error: () => (current() ? store.error : undefined),
    loading: () => current() && store.loading,
    busy: () => !!store.busy[opts.key()],
    notice: () => store.notices[opts.key()],
    retry: () => !store.busy[opts.key()] && !!store.attempts[opts.key()],
    recover() {
      const attempt = store.attempts[opts.key()]
      return attempt ? submit({ text: attempt.text, parts: attempt.parts }) : Promise.resolve(false)
    },
    unconfirmed: () => (store.busy[opts.key()] ? undefined : store.dispatches[opts.key()]?.id),
    discard() {
      const key = opts.key()
      if (disposed || store.busy[key] || !store.attempts[key]) return
      setStore("attempts", key, undefined)
      setStore("notices", key, { type: "discarded" })
    },
    refresh,
    submit,
    send,
    remove: (id: string) => change(id),
    resume: () => change(),
  }
}
