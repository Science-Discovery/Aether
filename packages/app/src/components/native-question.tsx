import { createEffect, createMemo, For, Index, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Message, NativeQuestion, TextPart } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { nativeQuestionAnchor, submittedNativeQuestion } from "./native-question-events"

export function NativeQuestionCard(props: { part: TextPart; message: Message }) {
  return (
    <Show when={props.message.role === "assistant" && props.part.nativeQuestion}>
      {(question) => <Question question={question()} session={props.part.sessionID} />}
    </Show>
  )
}

function Question(props: { question: NativeQuestion; session: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const key = createMemo(
    () => `${sdk.url}\n${sdk.directory}\n${props.session}\n${props.question.thread}\n${props.question.item}`,
  )
  const [store, setStore] = createStore<{
    busy: boolean
    error?: string
    draft: string[]
    sent?: string[]
    saved?: NativeQuestion
  }>({ busy: false, draft: [] })
  let revision = 0
  let version = 0
  let disposed = false
  const source = createMemo(() => JSON.stringify(props.question))
  const question = createMemo(() => {
    if (props.question.state === "answered") return props.question
    return store.saved ?? props.question
  })
  const saved = () => question().answers ?? store.sent
  const locked = () => store.busy || !!saved() || question().state !== "pending"
  const answers = () => saved() ?? store.draft
  const state = () =>
    question().state === "answered" ? "answered" : store.error && store.sent ? "uncertain" : question().state
  const complete = () =>
    answers().length === question().questions.length &&
    question().questions.every((_, index) => !!answers()[index]?.trim())

  createEffect(
    on(key, () => {
      revision++
      setStore({ busy: false, error: undefined, draft: [], sent: undefined, saved: undefined })
    }),
  )
  createEffect(
    on(source, () => {
      version++
      if (props.question.state === "pending") return
      if (store.saved?.state === "answered") return
      setStore("error", undefined)
      setStore("saved", reconcile({ ...props.question }))
    }),
  )
  onCleanup(() => {
    disposed = true
    revision++
  })

  async function submit() {
    if (disposed || store.busy || state() === "answered" || !complete()) return
    const scope = key()
    const run = ++revision
    const stamp = version
    const input = answers().map((answer) => answer.trim())
    const client = sdk.client
    setStore({ busy: true, error: undefined, sent: input })
    submittedNativeQuestion({
      url: sdk.url,
      directory: sdk.directory,
      session: props.session,
      thread: question().thread,
      item: question().item,
    })
    await client.native
      .replyQuestion(
        {
          sessionID: props.session,
          itemID: question().item,
          threadID: question().thread,
          answers: input,
        },
        { throwOnError: true },
      )
      .then((response) => {
        if (disposed || run !== revision || scope !== key() || stamp !== version) return
        if (!response.data) throw new Error(language.t("native.question.noResult"))
        if (response.data.thread !== question().thread || response.data.item !== question().item)
          throw new Error(language.t("native.question.noResult"))
        if (props.question.state === "answered") return
        setStore("saved", reconcile(response.data))
      })
      .catch((err: unknown) => {
        if (disposed || run !== revision || scope !== key() || stamp !== version) return
        const text = err && typeof err === "object" && "error" in err && typeof err.error === "string" ? err.error : err
        setStore("error", formatServerError(text, language.t))
      })
      .finally(() => {
        if (!disposed && run === revision && scope === key()) setStore("busy", false)
      })
  }

  return (
    <section
      id={nativeQuestionAnchor(props.session, props.question)}
      tabIndex={-1}
      class="my-2 rounded-md border border-border-base bg-background-base p-3 flex flex-col gap-3"
      data-component="native-question"
      data-state={state()}
      aria-label={language.t("native.question.title")}
      aria-busy={store.busy}
    >
      <div class="flex flex-col gap-1">
        <div class="text-14-medium text-text-strong">{language.t("native.question.title")}</div>
        <p class="text-12-regular text-text-weak" role="status">
          {language.t(`native.question.state.${state()}`)}
        </p>
      </div>
      <Index each={question().questions}>
        {(item, index) => (
          <fieldset class="flex flex-col gap-2 min-w-0" disabled={locked()}>
            <legend class="text-14-medium text-text-base mb-2 break-words">{item().title}</legend>
            <Show when={!locked() && item().options?.length}>
              <div class="flex flex-wrap gap-2" role="group" aria-label={item().title}>
                <For each={item().options}>
                  {(option) => (
                    <Button
                      type="button"
                      size="small"
                      variant={store.draft[index] === option ? "primary" : "secondary"}
                      aria-pressed={store.draft[index] === option}
                      onClick={() => setStore("draft", index, option)}
                    >
                      {option}
                    </Button>
                  )}
                </For>
              </div>
            </Show>
            <Show
              when={!locked()}
              fallback={
                <div class="text-14-regular text-text-base whitespace-pre-wrap break-words">{answers()[index]}</div>
              }
            >
              <TextField
                multiline
                label={language.t("native.question.answer")}
                hideLabel
                aria-label={`${language.t("native.question.answer")}: ${item().title}`}
                placeholder={language.t("native.question.placeholder")}
                value={store.draft[index] ?? ""}
                onChange={(value) => setStore("draft", index, value)}
              />
            </Show>
          </fieldset>
        )}
      </Index>
      <Show when={state() !== "answered" && (store.error || question().error)}>
        {(error) => (
          <p role="alert" class="text-12-regular text-text-weak break-words">
            {error()}
          </p>
        )}
      </Show>
      <Show when={state() !== "answered"}>
        <div>
          <Button type="button" size="small" disabled={store.busy || !complete()} onClick={() => void submit()}>
            {language.t(
              store.busy
                ? "native.question.submitting"
                : state() === "sending" || state() === "uncertain"
                  ? "native.question.check"
                  : state() === "failed"
                    ? "native.question.retry"
                    : "native.question.submit",
            )}
          </Button>
        </div>
      </Show>
    </section>
  )
}
