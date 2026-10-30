import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { NativeTasks as Tasks, Session } from "@opencode-ai/sdk/v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { Question } from "./native-question"

// Idle child answers update a different native session, so no parent message
// event is guaranteed. Notify only task buttons viewing the submitted scope.
const updates = new Set<(scope: string) => void>()

export function NativeTaskButton(props: { sessionID: string; onOpen: () => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore({ count: 0, pending: 0 })
  const key = () => `${sdk.url}\n${sdk.directory}\n${props.sessionID}`
  let revision = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    const scope = key()
    const stamp = ++revision
    await sdk.client.native
      .tasks({ sessionID: props.sessionID }, { throwOnError: true })
      .then((result) => {
        if (disposed || revision !== stamp || key() !== scope || !result.data) return
        setState({
          count: result.data.length,
          pending: result.data.flatMap((task) => task.questions).filter((question) => question.state === "pending")
            .length,
        })
      })
      .catch(() => undefined)
  }
  const updated = (scope: string) => {
    if (!disposed && key() === scope) void refresh()
  }
  updates.add(updated)
  const events = sdk.event.listen((event) => {
    const data = event.details
    if (data.type !== "message.part.updated" && data.type !== "message.updated" && data.type !== "session.status")
      return
    const id =
      data.type === "message.part.updated"
        ? data.properties.part.sessionID
        : data.type === "message.updated"
          ? data.properties.info.sessionID
          : data.properties.sessionID
    if (id !== props.sessionID || timer) return
    const scope = key()
    timer = setTimeout(() => {
      timer = undefined
      if (!disposed && key() === scope) void refresh()
    }, 1000)
  })
  createEffect(
    on(key, () => {
      revision++
      clearTimeout(timer)
      timer = undefined
      setState({ count: 0, pending: 0 })
      void refresh()
    }),
  )
  onCleanup(() => {
    disposed = true
    revision++
    clearTimeout(timer)
    updates.delete(updated)
    events()
  })
  return (
    <Show when={state.count}>
      <Button size="small" variant="ghost" onClick={props.onOpen}>
        {language.t("native.tasks.count", { count: state.count })}
        <Show when={state.pending}> · {language.t("native.tasks.pending", { count: state.pending })}</Show>
      </Button>
    </Show>
  )
}

export function NativeTasks(props: { sessionID: string; onSelect: (session: Session) => void }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore<{ tasks: Tasks; busy: boolean; error?: string; opening?: string }>({
    tasks: [],
    busy: false,
  })
  const key = () => `${sdk.url}\n${sdk.directory}\n${props.sessionID}`
  let revision = 0
  let disposed = false
  async function refresh() {
    if (state.busy) return
    const scope = key()
    const stamp = revision
    setState("busy", true)
    await sdk.client.native
      .tasks({ sessionID: props.sessionID }, { throwOnError: true })
      .then((result) => {
        if (disposed || revision !== stamp || key() !== scope) return
        if (!result.data) throw new Error(language.t("native.question.noResult"))
        setState("tasks", reconcile(result.data, { key: "thread" }))
        setState("error", undefined)
      })
      .catch((err: unknown) => {
        if (!disposed && revision === stamp && key() === scope) setState("error", formatServerError(err, language.t))
      })
      .finally(() => {
        if (!disposed && revision === stamp && key() === scope) setState("busy", false)
      })
  }
  async function open(thread: string) {
    if (state.opening) return
    const scope = key()
    const stamp = revision
    setState("opening", thread)
    await sdk.client.native
      .openTask({ sessionID: props.sessionID, threadID: thread }, { throwOnError: true })
      .then((result) => {
        if (disposed || revision !== stamp || key() !== scope) return
        if (result.data) props.onSelect(result.data)
      })
      .catch((err: unknown) => {
        if (!disposed && revision === stamp && key() === scope) setState("error", formatServerError(err, language.t))
      })
      .finally(() => {
        if (!disposed && revision === stamp && key() === scope) setState("opening", undefined)
      })
  }
  createEffect(
    on(key, () => {
      revision++
      setState({ tasks: [], busy: false, error: undefined, opening: undefined })
      void refresh()
    }),
  )
  const timer = setInterval(() => {
    if (document.visibilityState !== "hidden") void refresh()
  }, 3000)
  onCleanup(() => {
    disposed = true
    revision++
    clearInterval(timer)
  })
  return (
    <Dialog title={language.t("native.slash.tasks")}>
      <div class="p-4 max-h-[75vh] overflow-y-auto flex flex-col gap-3">
        <p class="text-12-regular text-text-weak">{language.t("native.tasks.description")}</p>
        <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void refresh()}>
          {language.t("native.tasks.refresh")}
        </Button>
        <Show when={state.error}>
          {(error) => (
            <p role="alert" class="break-words">
              {error()}
            </p>
          )}
        </Show>
        <Show when={!state.tasks.length && !state.busy && !state.error}>{language.t("native.tasks.empty")}</Show>
        <For each={state.tasks}>
          {(task) => (
            <section class="border border-border-base rounded-md p-3 flex flex-col gap-2">
              <div class="flex items-center justify-between gap-2">
                <strong>{task.name}</strong>
                <span>{language.t(`native.tasks.${task.state}`)}</span>
              </div>
              <Show when={task.output}>
                <details>
                  <summary class="cursor-pointer">{language.t("native.tasks.result")}</summary>
                  <pre class="whitespace-pre-wrap break-words text-12-regular">{task.output}</pre>
                </details>
              </Show>
              <For each={task.questions}>
                {(question) => (
                  <Question
                    session={props.sessionID}
                    question={question}
                    send={async (answers) => {
                      const scope = key()
                      const target = {
                        sessionID: props.sessionID,
                        threadID: question.thread,
                        itemID: question.item,
                        answers,
                      }
                      const result = await sdk.client.native.replyTask(target, { throwOnError: true })
                      if (!result.data) throw new Error(language.t("native.question.noResult"))
                      if (result.data.thread !== target.threadID || result.data.item !== target.itemID)
                        throw new Error(language.t("native.question.noResult"))
                      if (result.data.state === "answered" || result.data.state === "sending")
                        updates.forEach((update) => update(scope))
                      return result.data
                    }}
                  />
                )}
              </For>
              <Button
                size="small"
                variant="ghost"
                disabled={!!state.opening || task.state === "running"}
                onClick={() => void open(task.thread)}
              >
                {language.t("native.tasks.open")}
              </Button>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  )
}
