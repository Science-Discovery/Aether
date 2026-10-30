import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { NativeElicitation, NativeElicitationField, NativeElicitationReceipt } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { formatServerError } from "@/utils/server-errors"

type Content = Record<string, string | number | boolean | string[]>

export function NativeElicitationDock(props: { session?: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore<{ items: NativeElicitation[]; error?: string }>({ items: [] })
  const removed = new Set<string>()
  createEffect(
    on(
      () => `${sdk.url}\n${sdk.directory}\n${props.session ?? ""}`,
      () => {
        const id = props.session
        const client = sdk.client
        setState({ items: [], error: undefined })
        removed.clear()
        if (!id) return
        let disposed = false
        let busy = false
        let dirty = false
        const refresh = () => {
          if (disposed) return
          if (busy) {
            dirty = true
            return
          }
          busy = true
          void client.native
            .elicitations({ sessionID: id }, { throwOnError: true })
            .then((result) => {
              if (disposed || !result.data) return
              setState("items", reconcile(result.data.filter((item) => !removed.has(item.id))))
              setState("error", undefined)
            })
            .catch((err: unknown) => {
              if (!disposed && state.items.length) setState("error", formatServerError(err, language.t))
            })
            .finally(() => {
              busy = false
              if (dirty && !disposed) {
                dirty = false
                refresh()
              }
            })
        }
        const events = sdk.event.listen((event) => {
          if (event.details.type === "native.elicitation.changed" && event.details.properties.sessionID === id)
            refresh()
        })
        const timer = setInterval(refresh, 10_000)
        refresh()
        onCleanup(() => {
          disposed = true
          clearInterval(timer)
          events()
        })
      },
    ),
  )
  return (
    <Show when={state.items.length}>
      <div class="max-h-[55vh] overflow-y-auto mb-2 flex flex-col gap-2" data-component="native-elicitations">
        <Show when={state.error}>{(error) => <div role="alert">{error()}</div>}</Show>
        <For each={state.items}>
          {(item) => (
            <Elicitation
              request={item}
              onDone={() => {
                removed.add(item.id)
                setState("items", (items) => items.filter((value) => value.id !== item.id))
              }}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

export function Elicitation(props: {
  request: NativeElicitation
  onDone: () => void
  send?: (action: "accept" | "decline" | "cancel", content: Content | null) => Promise<NativeElicitationReceipt>
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const platform = usePlatform()
  const [state, setState] = createStore<{
    draft: Record<string, string | boolean | string[] | undefined>
    busy: boolean
    error?: string
  }>({ draft: {}, busy: false })
  const key = () => `${sdk.url}\n${sdk.directory}\n${props.request.sessionID}\n${props.request.id}`
  let revision = 0
  let disposed = false
  createEffect(
    on(key, () => {
      revision++
      setState(
        "draft",
        reconcile(
          props.request.mode === "form"
            ? Object.fromEntries(
                props.request.fields.flatMap((field) =>
                  field.default === undefined
                    ? []
                    : [[field.name, typeof field.default === "number" ? String(field.default) : field.default]],
                ),
              )
            : {},
        ),
      )
      setState({ busy: false, error: undefined })
    }),
  )
  onCleanup(() => {
    disposed = true
    revision++
  })
  const choices = (field: NativeElicitationField) => {
    const value = state.draft[field.name]
    return Array.isArray(value) ? value : []
  }
  const content = (): Content =>
    props.request.mode !== "form"
      ? {}
      : Object.fromEntries(
          props.request.fields.flatMap((field) => {
            const value = state.draft[field.name]
            if (value === undefined || ((field.type === "number" || field.type === "integer") && value === ""))
              return []
            return [[field.name, field.type === "number" || field.type === "integer" ? Number(value) : value]]
          }),
        )
  async function submit(action: "accept" | "decline" | "cancel") {
    if (disposed || state.busy) return
    const scope = key()
    const stamp = ++revision
    const input = action === "accept" && props.request.mode === "form" ? content() : null
    const target = { sessionID: props.request.sessionID, id: props.request.id, action, content: input }
    setState({ busy: true, error: undefined })
    await (
      props.send
        ? props.send(action, input)
        : sdk.client.native.replyElicitation(target, { throwOnError: true }).then((result) => result.data)
    )
      .then((result) => {
        if (disposed || stamp !== revision || scope !== key()) return
        if (!result || result.id !== target.id || result.action !== action)
          throw new Error(language.t("native.question.noResult"))
        setState("draft", reconcile({}))
        props.onDone()
      })
      .catch((err: unknown) => {
        if (!disposed && stamp === revision && scope === key()) setState("error", formatServerError(err, language.t))
      })
      .finally(() => {
        if (!disposed && stamp === revision && scope === key()) setState("busy", false)
      })
  }
  const open = () => {
    if (props.request.mode !== "url") return
    const link = props.request.url
    const scope = key()
    const url = URL.parse(link)
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return
    void Promise.resolve()
      .then(() => platform.openLink(link))
      .catch((err: unknown) => {
        if (!disposed && key() === scope) setState("error", formatServerError(err, language.t))
      })
  }
  const style = "rounded border border-border-base bg-background-base text-text-base px-2 py-1 w-full"
  return (
    <section
      class="rounded-md border border-border-base bg-background-base p-3 flex flex-col gap-3"
      data-component="native-elicitation"
      aria-busy={state.busy}
    >
      <div class="text-14-medium text-text-strong">
        {language.t("native.elicitation.title", { server: props.request.server })}
      </div>
      <p class="text-14-regular whitespace-pre-wrap break-words">{props.request.message}</p>
      <Show when={props.request.mode === "form" ? props.request.fields : undefined}>
        {(fields) => (
          <For each={fields()}>
            {(field) => (
              <fieldset disabled={state.busy} class="flex flex-col gap-1">
                <legend class="text-14-medium break-words">
                  {field.title}
                  {field.required ? " *" : ""}
                </legend>
                <Show when={field.description}>
                  {(description) => <p class="text-12-regular text-text-weak">{description()}</p>}
                </Show>
                <Show when={field.type === "array"}>
                  <For each={field.options}>
                    {(option) => (
                      <label class="flex items-center gap-2 text-14-regular">
                        <input
                          type="checkbox"
                          checked={choices(field).includes(option.value)}
                          onChange={(event) =>
                            setState(
                              "draft",
                              field.name,
                              event.currentTarget.checked
                                ? [...choices(field), option.value]
                                : choices(field).filter((value) => value !== option.value),
                            )
                          }
                        />
                        {option.title}
                      </label>
                    )}
                  </For>
                </Show>
                <Show when={field.type === "boolean" || (field.type === "string" && field.options)}>
                  <select
                    class={style}
                    aria-label={field.title}
                    value={
                      state.draft[field.name] === undefined
                        ? ""
                        : field.type === "boolean"
                          ? String(state.draft[field.name])
                          : String(field.options?.findIndex((item) => item.value === state.draft[field.name]))
                    }
                    onChange={(event) =>
                      setState(
                        "draft",
                        field.name,
                        event.currentTarget.value === ""
                          ? undefined
                          : field.type === "boolean"
                            ? event.currentTarget.value === "true"
                            : field.options![Number(event.currentTarget.value)].value,
                      )
                    }
                  >
                    <option value="">{language.t("native.elicitation.choose")}</option>
                    <Show
                      when={field.type === "boolean"}
                      fallback={
                        <For each={field.options}>
                          {(option, index) => <option value={String(index())}>{option.title}</option>}
                        </For>
                      }
                    >
                      <option value="true">{language.t("native.elicitation.yes")}</option>
                      <option value="false">{language.t("native.elicitation.no")}</option>
                    </Show>
                  </select>
                </Show>
                <Show
                  when={
                    field.type === "number" || field.type === "integer" || (field.type === "string" && !field.options)
                  }
                >
                  <input
                    class={style}
                    aria-label={field.title}
                    type={field.type === "string" ? "text" : "number"}
                    step={field.type === "integer" ? "1" : "any"}
                    min={field.type === "string" ? undefined : field.min}
                    max={field.type === "string" ? undefined : field.max}
                    maxLength={field.type === "string" ? (field.max ?? 10_000) : undefined}
                    value={String(state.draft[field.name] ?? "")}
                    onInput={(event) => setState("draft", field.name, event.currentTarget.value)}
                  />
                </Show>
              </fieldset>
            )}
          </For>
        )}
      </Show>
      <Show when={props.request.mode === "url" ? props.request.url : undefined}>
        {(url) => (
          <>
            <div class="text-12-regular text-text-weak break-all">{url()}</div>
            <p class="text-12-regular text-text-weak">{language.t("native.elicitation.urlHint")}</p>
            <Button size="small" variant="secondary" disabled={state.busy} onClick={open}>
              {language.t("native.elicitation.open")}
            </Button>
          </>
        )}
      </Show>
      <Show when={state.error}>
        {(error) => (
          <div role="alert" class="text-12-regular break-words">
            {error()}
          </div>
        )}
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button size="small" disabled={state.busy} onClick={() => void submit("accept")}>
          {language.t(
            state.busy
              ? "native.question.submitting"
              : props.request.mode === "url"
                ? "native.elicitation.complete"
                : "native.question.submit",
          )}
        </Button>
        <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void submit("decline")}>
          {language.t("native.elicitation.decline")}
        </Button>
        <Button size="small" variant="ghost" disabled={state.busy} onClick={() => void submit("cancel")}>
          {language.t("native.elicitation.cancel")}
        </Button>
      </div>
    </section>
  )
}
