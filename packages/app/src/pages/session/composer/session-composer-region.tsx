import { Index, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { getFilename } from "@opencode-ai/util/path"
import { PromptInput } from "@/components/prompt-input"
import { AskEditor, type AskEditorProps } from "@/components/ask-editor"
import type { Reference } from "@/utils/ask-reference"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { type FollowupDraft, type FollowupEdit } from "@/components/prompt-input/submit"
import { useMaybeFileQuote } from "@/context/file-quote"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { formatReadingPageRange } from "@/utils/comment-note"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: FollowupEdit
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const prompt = usePrompt()
  const language = useLanguage()
  const fileQuote = useMaybeFileQuote()
  const route = useSessionKey()
  const references = createMemo(() => prompt.references.items())
  const [editor, setEditor] = createSignal<{ reference: Reference; anchor: AskEditorProps["anchor"] }>()
  createEffect(on(route.sessionKey, () => setEditor(undefined)))
  createEffect(() => {
    const current = editor()
    if (current && !references().some((ref) => ref.id === current.reference.id)) setEditor(undefined)
  })
  const fileQuoteQuestion = createMemo(() => {
    const pending = fileQuote?.store.question
    return pending?.sessionID === route.params.id ? pending : null
  })

  const handoffPrompt = createMemo(() => getSessionHandoff(route.sessionKey())?.prompt)

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(route.sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    route.sessionKey()
    const ready = props.ready
    const delay = 140

    clear()
    setStore("ready", false)
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(clear)

  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => {
      setStore("height", el.getBoundingClientRect().height)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      class="shrink-0 w-full pb-3 flex flex-col justify-center items-center bg-background-stronger pointer-events-none"
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-[2400px] md:mx-auto 2xl:max-w-[3000px]": props.centered,
        }}
      >
        <Show when={props.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock
                request={request}
                onSubmit={props.onResponseSubmit}
                collapseLabel={language.t("session.question.collapse")}
                expandLabel={language.t("session.question.expand")}
              />
            </div>
          )}
        </Show>

        <Show when={props.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  props.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={!props.state.blocked()}>
          <Show
            when={prompt.ready()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                  {handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={dock()}>
              <div
                classList={{
                  "overflow-hidden": true,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": `${full() * value()}px`,
                }}
              >
                <div ref={(el) => setStore("body", el)}>
                  <SessionTodoDock
                    sessionID={route.params.id}
                    todos={props.state.todos()}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={value()}
                  />
                </div>
              </div>
            </Show>
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              <Show when={props.followup?.items.length}>
                <SessionFollowupDock
                  items={props.followup!.items}
                  sending={props.followup!.sending}
                  onSend={props.followup!.onSend}
                  onEdit={props.followup!.onEdit}
                />
              </Show>
              <Show when={references().length > 0}>
                <div
                  data-component="ask-reference-list"
                  class="mb-2 flex flex-col gap-2 pr-1"
                  classList={{ "max-h-64 overflow-y-auto": references().length > 2 }}
                >
                  <Index each={references()}>
                    {(item, index) => {
                      const [expanded, setExpanded] = createSignal(false)
                      const [failed, setFailed] = createSignal(false)
                      const pdf = createMemo(() => {
                        const ref = item()
                        return ref.kind === "pdf" ? ref : undefined
                      })
                      const image = () => pdf()?.image
                      createEffect(
                        on(
                          () => item().id,
                          () => setExpanded(false),
                        ),
                      )
                      createEffect(on(image, () => setFailed(false)))
                      return (
                        <div
                          data-reference-id={item().id}
                          class="rounded-lg border border-border-weak-base bg-surface-base px-3 py-2 shadow-xs"
                        >
                          <div class="flex items-center gap-2">
                            <span class="shrink-0 text-11-medium text-text-weak">
                              {language.t("ask.reference.title", { number: index + 1 })}
                            </span>
                            <span class="min-w-0 flex-1 truncate text-12-medium text-text-strong">
                              {pdf()?.filename ?? language.t("ask.reference.conversation")}
                            </span>
                            <Show when={pdf()}>
                              {(ref) => (
                                <span class="shrink-0 text-11-medium text-text-weak">
                                  p.{formatReadingPageRange(ref())}
                                </span>
                              )}
                            </Show>
                            <IconButton
                              icon="edit"
                              size="small"
                              variant="ghost"
                              aria-label={language.t("common.edit")}
                              onClick={(event) =>
                                setEditor({ reference: item(), anchor: event.currentTarget.getBoundingClientRect() })
                              }
                            />
                            <IconButton
                              icon="close"
                              size="small"
                              variant="ghost"
                              aria-label={language.t("common.delete")}
                              onClick={() => prompt.references.remove(item().id)}
                            />
                          </div>
                          <Show when={pdf()?.content === "image"}>
                            <Show
                              when={image() && !failed()}
                              fallback={
                                <div class="mt-2 text-12-regular text-text-weak">
                                  {language.t("ask.reference.missingImage")}
                                </div>
                              }
                            >
                              <img
                                src={image()}
                                alt={item().summary}
                                class="mt-2 h-20 max-w-full rounded-md border border-border-weak-base object-contain"
                                onError={() => setFailed(true)}
                              />
                            </Show>
                          </Show>
                          <div
                            class="mt-1 whitespace-pre-wrap break-words text-12-regular text-text-weak [overflow-wrap:anywhere]"
                            classList={{ "line-clamp-2": !expanded(), "max-h-48 overflow-auto": expanded() }}
                          >
                            {expanded() ? item().text : item().summary}
                          </div>
                          <button
                            type="button"
                            class="mt-1 text-11-medium text-text-weak hover:text-text-strong"
                            aria-expanded={expanded()}
                            onClick={() => setExpanded(!expanded())}
                          >
                            {language.t(expanded() ? "ask.reference.collapse" : "ask.reference.expand")}
                          </button>
                          <Show when={item().question}>
                            <div class="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-t border-border-weak-base pt-2 text-13-regular text-text-strong [overflow-wrap:anywhere]">
                              <span class="text-text-weak">{language.t("ask.reference.question")}: </span>
                              {item().question}
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </Index>
                </div>
              </Show>
              <Show when={editor()} keyed>
                {(value) => (
                  <AskEditor
                    title={
                      value.reference.kind === "pdf"
                        ? value.reference.filename
                        : language.t("ask.reference.conversation")
                    }
                    preview={value.reference.text}
                    image={value.reference.kind === "pdf" ? value.reference.image : undefined}
                    question={value.reference.question}
                    anchor={value.anchor}
                    editing
                    onCancel={() => setEditor(undefined)}
                    onSave={(question) => {
                      prompt.references.update(value.reference.id, question)
                      setEditor(undefined)
                    }}
                  />
                )}
              </Show>
              <Show when={fileQuoteQuestion()} keyed>
                {(question) => (
                  <div class="mb-2 rounded-lg border border-border-weak-base bg-surface-base px-3 py-2 shadow-xs">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <div class="text-11-medium uppercase tracking-wide text-text-weak">
                          {`${getFilename(question.path)}${question.startLine !== undefined ? ` · L${question.startLine}${question.endLine !== undefined && question.endLine !== question.startLine ? `-L${question.endLine}` : ""}` : ""} · File Quote`}
                        </div>
                        <div class="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-13-regular text-text-strong">
                          {question.text}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="shrink-0 rounded-md px-1 py-0.5 text-12-medium text-text-weak transition hover:bg-surface-hover hover:text-text-strong"
                        onClick={() => fileQuote?.setQuestion(null)}
                        aria-label={language.t("common.clear")}
                      >
                        x
                      </button>
                    </div>
                  </div>
                )}
              </Show>
              <PromptInput
                ref={props.inputRef}
                newSessionWorktree={props.newSessionWorktree}
                onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                edit={props.followup?.edit}
                onEditLoaded={props.followup?.onEditLoaded}
                shouldQueue={props.followup?.queue}
                onQueue={props.followup?.onQueue}
                onAbort={props.followup?.onAbort}
                onSubmit={props.onSubmit}
              />
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
