import { createEffect, createUniqueId, For, on, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { LatexBinding } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLatex } from "@/context/latex"
import { useSDK } from "@/context/sdk"
import { formatServerError } from "@/utils/server-errors"
import { SettingsLatex } from "./settings-latex"
import { DialogLatexHelp } from "./dialog-latex-help"

type Props = {
  enabled: boolean
  active: boolean
  path: string
  auth?: string
  actions?: JSX.Element
  onNavigate: (path: string, line: number) => void
  children: JSX.Element
}

export function LatexPanel(props: Props) {
  return (
    <Show when={props.enabled} fallback={props.children}>
      <Workspace {...props} />
    </Show>
  )
}

function Workspace(props: Props) {
  const latex = useLatex()
  const sdk = useSDK()
  const file = useFile()
  const language = useLanguage()
  const dialog = useDialog()
  const choices = createUniqueId()
  const controls = createUniqueId()
  const state = latex.state
  const disabled = () =>
    state.automatic ||
    state.busy ||
    !file.ready() ||
    state.path !== props.path ||
    state.composing.includes(props.path) ||
    !latex.pending().some((draft) => draft.path === props.path)
  const hint = (key: "latex.fileSave" | "latex.fileDiscard") =>
    state.automatic ? language.t("latex.manualOnly") : language.t(key)
  const [local, setLocal] = createStore({ error: "" })
  createEffect(
    on(
      () => [props.active, props.path, sdk.url, sdk.directory] as const,
      ([active, path]) => {
        if (active) void latex.open(path)
      },
    ),
  )
  createEffect(
    on(
      () => props.path,
      (path) => onCleanup(() => latex.composing(path, false)),
    ),
  )
  const settings = () =>
    dialog.show(() => (
      <Dialog size="large">
        <SettingsLatex />
      </Dialog>
    ))
  const help = () => dialog.show(() => <DialogLatexHelp />)
  const status = () =>
    [
      latex.conflicts().length
        ? language.t("latex.paused")
        : state.saving
          ? language.t("latex.saving")
          : latex.pending().length
            ? language.t("latex.unsaved", { count: latex.pending().length })
            : state.path
              ? language.t("latex.saved")
              : "",
      state.project?.binding && latex.changed()
        ? language.t("latex.settingsPending")
        : state.queued
          ? language.t("latex.queued")
          : state.project?.latest
            ? language.t(`latex.state.${state.project.latest.state}`)
            : "",
    ]
      .filter(Boolean)
      .join(" · ")
  const compare = async (path: string) => {
    setLocal("error", "")
    const snapshot = await latex.compare(path).catch((cause) => {
      setLocal("error", formatServerError(cause, language.t))
    })
    if (!snapshot) return
    dialog.show(() => (
      <Dialog title={`${language.t("latex.compare")} · ${path}`} size="large">
        <div class="flex min-h-0 flex-col gap-3 p-4">
          <div class="grid min-h-0 grid-cols-2 gap-3">
            <For
              each={[
                { label: "latex.disk" as const, content: snapshot.disk },
                { label: "latex.draft" as const, content: snapshot.draft },
              ]}
            >
              {(item) => (
                <section class="min-w-0">
                  <h3 class="mb-2 text-12-medium">{language.t(item.label)}</h3>
                  <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border-weak-base p-3 text-12-regular">
                    {item.content}
                  </pre>
                </section>
              )}
            </For>
          </div>
          <Show when={state.error}>
            <p role="alert" class="text-12-regular">
              {state.error}
            </p>
          </Show>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="secondary"
              disabled={state.busy}
              onClick={() =>
                void latex.resolve(snapshot, "disk").then((ok) => {
                  if (ok) dialog.close()
                })
              }
            >
              {language.t("latex.useDisk")}
            </Button>
            <Button
              disabled={state.busy}
              onClick={() =>
                void latex.resolve(snapshot, "draft").then((ok) => {
                  if (ok) dialog.close()
                })
              }
            >
              {language.t("latex.useDraft")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }
  return (
    <div data-component="latex-workspace" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        class="shrink-0 border-b border-border-weak-base px-3 text-12-regular"
        classList={{ "min-h-8 flex flex-col justify-center py-[3px]": state.collapsed, "py-2": !state.collapsed }}
      >
        <div class="flex items-start gap-2">
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Button
              size="small"
              variant="secondary"
              aria-expanded={!state.collapsed && state.configuring}
              onClick={() => latex.configure(state.collapsed || !state.configuring)}
            >
              {state.project?.binding?.main ?? language.t("latex.project")}
            </Button>
            <Show when={!state.collapsed}>
              <label class="flex items-center gap-2 text-text-weak">
                <input
                  type="checkbox"
                  checked={state.automatic}
                  onChange={(event) => latex.automatic(event.currentTarget.checked)}
                />
                {language.t("latex.automatic")}
              </label>
            </Show>
            <Show when={state.collapsed}>
              <span
                class="min-w-0 flex-1 truncate text-text-weak"
                title={status()}
                data-component="latex-compact-status"
              >
                {status()}
              </span>
            </Show>
            <Button
              size="small"
              data-action="latex-compile"
              disabled={state.busy || latex.running() || latex.changed() || !file.ready() || !!latex.conflicts().length}
              onClick={() => void latex.compile()}
            >
              {state.saving ? language.t("latex.saving") : language.t("latex.compile")}
            </Button>
            <Show when={latex.running()}>
              <Button size="small" variant="secondary" onClick={() => void latex.cancel()}>
                {language.t("common.cancel")}
              </Button>
            </Show>
            <Show when={!state.collapsed}>
              <Button size="small" variant="secondary" onClick={() => void latex.refresh()} disabled={state.busy}>
                {language.t("latex.refresh")}
              </Button>
              <Button size="small" variant="secondary" onClick={settings}>
                {language.t("latex.settings")}
              </Button>
              <Button size="small" variant="secondary" onClick={latex.show}>
                {language.t("latex.preview")}
              </Button>
              <Button size="small" variant="secondary" data-action="latex-help" onClick={help}>
                {language.t("latex.help")}
              </Button>
            </Show>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Show when={!state.collapsed}>{props.actions}</Show>
            <Tooltip placement="top" gutter={4} value={hint("latex.fileDiscard")}>
              <span class="inline-flex">
                <IconButton
                  icon="close"
                  variant="ghost"
                  size="small"
                  data-action="latex-discard"
                  aria-label={language.t("latex.fileDiscard")}
                  disabled={disabled()}
                  onClick={() => void latex.discard(props.path)}
                />
              </span>
            </Tooltip>
            <Tooltip placement="top" gutter={4} value={hint("latex.fileSave")}>
              <span class="inline-flex">
                <IconButton
                  icon="check"
                  variant="ghost"
                  size="small"
                  data-action="latex-save"
                  aria-label={language.t("latex.fileSave")}
                  disabled={disabled()}
                  onClick={() => void latex.persist(props.path)}
                />
              </span>
            </Tooltip>
            <Button
              size="small"
              variant="secondary"
              data-action="latex-collapse"
              aria-expanded={!state.collapsed}
              aria-controls={controls}
              onClick={() => latex.collapse(!state.collapsed)}
            >
              {language.t(state.collapsed ? "latex.expand" : "latex.collapse")}
            </Button>
          </div>
        </div>
        <div id={controls} hidden={state.collapsed} data-component="latex-toolbar-details">
          <Show when={state.configuring}>
            <div
              class="mt-2 flex flex-col gap-2 rounded-md border border-border-weak-base p-3"
              data-component="latex-project-settings"
            >
              <label class="flex flex-wrap items-center gap-2">
                <span>{language.t("latex.root")}</span>
                <input
                  aria-label={language.t("latex.root")}
                  class="min-w-0 flex-1 rounded border border-border-weak-base bg-background-base px-2 py-1"
                  value={state.root}
                  onInput={(event) => latex.edit({ root: event.currentTarget.value })}
                />
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => void latex.open(props.path, state.root.trim() || ".")}
                  disabled={state.busy || latex.running()}
                >
                  {language.t("latex.open")}
                </Button>
              </label>
              <label class="flex flex-wrap items-center gap-2">
                <span>{language.t("latex.main")}</span>
                <input
                  aria-label={language.t("latex.main")}
                  list={choices}
                  placeholder={language.t("latex.choose")}
                  class="min-w-0 flex-1 rounded border border-border-weak-base bg-background-base px-2 py-1"
                  value={state.main}
                  onInput={(event) => latex.edit({ main: event.currentTarget.value })}
                />
                <datalist id={choices}>
                  <For
                    each={[
                      ...new Set([
                        ...(state.project?.candidates ?? []),
                        ...(state.project?.main ? [state.project.main] : []),
                      ]),
                    ]}
                  >
                    {(main) => <option value={main}>{main}</option>}
                  </For>
                </datalist>
              </label>
              <div class="flex flex-wrap items-center gap-2">
                <label>
                  {language.t("latex.driver")}{" "}
                  <select
                    aria-label={language.t("latex.driver")}
                    class="rounded border border-border-weak-base bg-background-base px-2 py-1"
                    value={state.driver}
                    onChange={(event) => latex.edit({ driver: event.currentTarget.value as LatexBinding["driver"] })}
                  >
                    <option value="auto">{language.t("latex.auto")}</option>
                    <option value="tectonic">Tectonic</option>
                    <option value="latexmk">latexmk</option>
                  </select>
                </label>
                <label>
                  {language.t("latex.program")}{" "}
                  <select
                    aria-label={language.t("latex.program")}
                    class="rounded border border-border-weak-base bg-background-base px-2 py-1"
                    value={state.program}
                    onChange={(event) => latex.edit({ program: event.currentTarget.value as LatexBinding["program"] })}
                  >
                    <option value="auto">{language.t("latex.auto")}</option>
                    <option value="pdflatex">pdfLaTeX</option>
                    <option value="xelatex">XeLaTeX</option>
                  </select>
                </label>
                <Button
                  size="small"
                  data-action="latex-bind"
                  onClick={() => void latex.bind()}
                  disabled={state.busy || latex.running() || !state.main || state.root !== state.project?.root}
                >
                  {language.t("latex.bind")}
                </Button>
              </div>
              <Show when={state.project?.reason === "ambiguous"}>
                <p class="text-text-weak">{language.t("latex.ambiguous")}</p>
              </Show>
              <Show when={state.project?.issue}>
                <p class="text-text-weak">{state.project?.issue}</p>
              </Show>
            </div>
          </Show>
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-text-weak">
            <span data-component="latex-preview-status" data-current={latex.current()}>
              {!latex.artifact()
                ? language.t("latex.empty")
                : latex.outdated()
                  ? language.t("latex.stale")
                  : latex.verified()
                    ? language.t("latex.current")
                    : language.t("latex.unverified")}
            </span>
            <span data-component="latex-save-status">
              {latex.conflicts().length
                ? language.t("latex.paused")
                : state.saving
                  ? language.t("latex.saving")
                  : latex.pending().length
                    ? language.t("latex.unsaved", { count: latex.pending().length })
                    : state.path
                      ? language.t("latex.saved")
                      : ""}
            </span>
            <Show when={state.queued}>
              <span>{language.t("latex.queued")}</span>
            </Show>
            <Show when={state.project?.latest}>
              <span data-component="latex-build-status">
                {language.t(`latex.state.${state.project!.latest!.state}`)}
              </span>
            </Show>
            <Show when={latex.artifact()?.completedAt}>
              <time>{new Date(latex.artifact()!.completedAt!).toLocaleTimeString(language.intl())}</time>
            </Show>
          </div>
          <label class="mt-1 flex items-center gap-2 text-text-weak">
            <input
              type="checkbox"
              checked={state.downloads}
              onChange={(event) => latex.downloads(event.currentTarget.checked)}
              disabled={state.busy || latex.running()}
            />
            {language.t("latex.downloads")}
          </label>
        </div>
        <Show when={state.status && !state.status.tools.some((tool) => tool.installed)}>
          <p class="mt-2 text-text-weak">{language.t("latex.unavailable")}</p>
        </Show>
        <Show when={state.error || state.loadError || local.error || latex.conflicts().length}>
          <p role="alert" class="mt-2 text-text-strong">
            {state.error ||
              state.loadError ||
              local.error ||
              language.t("latex.conflict", {
                files: latex
                  .conflicts()
                  .map((item) => item.path)
                  .join(", "),
              })}
          </p>
        </Show>
        <For each={latex.conflicts()}>
          {(draft) => (
            <Button size="small" variant="secondary" onClick={() => void compare(draft.path)}>
              {language.t("latex.compare")} · {draft.path}
            </Button>
          )}
        </For>
      </div>
      <div
        class="relative flex min-h-0 min-w-0 flex-1 flex-col"
        onCompositionStart={() => latex.composing(props.path, true)}
        onCompositionEnd={() => latex.composing(props.path, false)}
      >
        {props.children}
      </div>
      <Show when={state.project?.latest}>
        {(build) => (
          <details
            class="shrink-0 border-t border-border-weak-base text-12-regular"
            open={build().state === "failed"}
            data-component="latex-diagnostics"
          >
            <summary class="cursor-pointer px-3 py-2 text-text-weak">
              {language.t("latex.diagnostics", { count: build().diagnostics.length })}
            </summary>
            <div class="max-h-44 overflow-auto px-3 pb-2" data-component="latex-diagnostics-content">
              <Show when={build().error}>
                <p class="my-2">{build().error}</p>
              </Show>
              <For each={build().diagnostics}>
                {(item) => (
                  <button
                    class="my-1 block w-full text-left hover:underline disabled:no-underline"
                    disabled={!item.path}
                    onClick={() => {
                      if (item.path) props.onNavigate(item.path, item.line ?? 1)
                    }}
                  >
                    {item.path ? `${item.path}:${item.line ?? 1} — ` : ""}
                    {item.message}
                  </button>
                )}
              </For>
              <pre class="mt-2 whitespace-pre-wrap break-words text-text-weak">{build().log}</pre>
              <Show when={build().truncated}>
                <p>{language.t("latex.truncated")}</p>
              </Show>
            </div>
          </details>
        )}
      </Show>
    </div>
  )
}
