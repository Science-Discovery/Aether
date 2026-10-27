import { createEffect, createMemo, createUniqueId, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { LatexBinding, LatexProject, LatexStatus } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { checksum } from "@opencode-ai/util/encode"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { formatServerError } from "@/utils/server-errors"
import { contains, dirty, save } from "./latex-drafts"
import { PdfViewerShell } from "./pdf-viewer-shell-official"
import { SettingsLatex } from "./settings-latex"

type Props = {
  enabled: boolean
  active: boolean
  path: string
  auth?: string
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
  const sdk = useSDK()
  const file = useFile()
  const language = useLanguage()
  const dialog = useDialog()
  const choices = createUniqueId()
  const [state, setState] = createStore({
    project: undefined as LatexProject | undefined,
    status: undefined as LatexStatus | undefined,
    root: "",
    main: "",
    driver: "auto" as LatexBinding["driver"],
    program: "auto" as LatexBinding["program"],
    busy: false,
    error: "",
    loadError: "",
    scanning: false,
    downloads: false,
    pane: "source" as "source" | "pdf",
    width: 0,
    ratio: 0.5,
    configuring: false,
  })
  let container!: HTMLDivElement
  let epoch = 0
  let serial = 0
  let edits = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const scope = createMemo(() => `${sdk.url}\n${sdk.directory}\n${props.path}`)
  const drafts = createMemo(() => file.drafts().filter((draft) => contains(state.project?.root ?? "", draft.path)))
  const pending = createMemo(() => drafts().filter(dirty))
  const conflicts = createMemo(() =>
    drafts().filter((draft) => {
      const disk = state.project?.editors.find((editor) => editor.path === draft.path)
      return !!disk && disk.checksum !== draft.base && disk.checksum !== (checksum(draft.content) ?? "")
    }),
  )
  const active = createMemo(() => ["preparing", "running"].includes(state.project?.latest?.state ?? ""))
  const artifact = createMemo(() => state.project?.lastSuccessful)
  const current = createMemo(() => {
    const project = state.project
    const pdf = artifact()
    return (
      !!pdf &&
      project?.freshness.state === "fresh" &&
      project.binding?.revision === pdf.bindingRevision &&
      project.freshness.sourceRevision === pdf.sourceRevision &&
      project.latest?.id === pdf.id &&
      project.latest.state === "succeeded" &&
      pending().length === 0 &&
      conflicts().length === 0 &&
      !state.busy &&
      !state.error &&
      !state.loadError &&
      !state.scanning
    )
  })
  const changed = createMemo(() => {
    const binding = state.project?.binding
    return (
      !binding ||
      state.main !== binding.main ||
      state.root !== binding.root ||
      state.driver !== binding.driver ||
      state.program !== binding.program
    )
  })
  const error = (cause: unknown) => setState("error", formatServerError(cause, language.t))
  const settings = () =>
    dialog.show(() => (
      <Dialog size="large">
        <SettingsLatex />
      </Dialog>
    ))
  const assign = (project: LatexProject, form = false) => {
    setState("project", reconcile(project))
    if (!form) return
    setState({
      root: project.root,
      main: project.binding?.main ?? project.main ?? "",
      driver: project.binding?.driver ?? "auto",
      program: project.binding?.program ?? "auto",
      configuring: !project.binding,
    })
  }
  const editors = () => drafts().map((draft) => draft.path)
  const read = async (refresh = false, root = state.project?.root, form = false) => {
    const version = epoch
    const request = ++serial
    const revision = edits
    const initialize = form || (!state.project && edits === 0)
    const client = sdk.client
    setState("scanning", refresh)
    try {
      const project = (await client.latex.project({ path: props.path, root }, { throwOnError: true })).data
      if (!project || version !== epoch || request !== serial) return
      assign(project, initialize && edits === revision)
      const result = refresh
        ? (
            await client.latex.refresh(
              {
                root: project.root,
                editors: file
                  .drafts()
                  .filter((draft) => contains(project.root, draft.path))
                  .map((draft) => draft.path),
              },
              { throwOnError: true },
            )
          ).data
        : project
      if (!result || version !== epoch || request !== serial) return
      assign(result)
      if (refresh) setState("loadError", "")
      return result
    } catch (cause) {
      if (version !== epoch || request !== serial) return
      setState({
        loadError: formatServerError(cause, language.t),
        configuring: initialize || !state.project || state.configuring,
      })
    } finally {
      if (version === epoch && request === serial) setState("scanning", false)
    }
  }
  const refresh = () => {
    if (!props.active || document.hidden || state.busy) return
    void read(true)
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(refresh, 500)
  }
  createEffect(
    on(scope, () => {
      epoch++
      serial++
      edits = 0
      setState({
        project: undefined,
        root: "",
        main: "",
        driver: "auto",
        program: "auto",
        error: "",
        loadError: "",
        scanning: false,
        busy: false,
        configuring: false,
      })
    }),
  )
  createEffect(
    on(
      () => [props.active, scope()] as const,
      ([visible]) => {
        if (!visible) return
        const version = epoch
        void read(true)
        void sdk.client.latex
          .status({}, { throwOnError: true })
          .then((result) => {
            if (version === epoch) setState("status", result.data)
          })
          .catch((cause) => {
            if (version === epoch) error(cause)
          })
        const interval = setInterval(() => {
          if (document.hidden || state.busy || state.scanning || !active()) return
          void read(false).then((project) => {
            if (project && !["preparing", "running"].includes(project.latest?.state ?? "")) refresh()
          })
        }, 1500)
        const check = setInterval(refresh, 30_000)
        window.addEventListener("focus", refresh)
        document.addEventListener("visibilitychange", refresh)
        const stop = sdk.event.on("file.watcher.updated", schedule)
        onCleanup(() => {
          clearInterval(interval)
          clearInterval(check)
          clearTimeout(timer)
          window.removeEventListener("focus", refresh)
          document.removeEventListener("visibilitychange", refresh)
          stop()
          serial++
        })
      },
    ),
  )
  onMount(() => {
    const observer = new ResizeObserver((entries) => setState("width", entries[0]?.contentRect.width ?? 0))
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => {
    epoch++
    clearTimeout(timer)
  })

  const open = () => {
    const root = state.root.trim() || "."
    epoch++
    const version = epoch
    setState({ project: undefined, error: "", loadError: "", busy: true })
    void read(true, root, true).finally(() => {
      if (version === epoch) setState("busy", false)
    })
  }
  const bind = () => {
    const project = state.project
    if (!project || !state.main || state.busy) return
    const version = epoch
    const revision = edits
    setState({ busy: true, error: "", scanning: false })
    serial++
    void sdk.client.latex
      .bind(
        {
          root: project.root,
          main: state.main,
          driver: state.driver,
          program: state.program,
          expectedRevision: project.binding?.revision,
        },
        { throwOnError: true },
      )
      .then(async () => {
        if (version !== epoch) return
        const result = await read(true, project.root, edits === revision)
        if (result && version === epoch && edits === revision) setState("configuring", false)
      })
      .catch((cause) => {
        if (version === epoch) error(cause)
      })
      .finally(() => {
        if (version === epoch) setState("busy", false)
      })
  }
  const compile = async () => {
    const project = state.project
    if (!project?.binding || state.busy || active() || changed()) return
    const root = project.root
    const revision = project.binding.revision
    const version = epoch
    const client = sdk.client
    const directory = sdk.directory
    const buffer = file.capture()
    setState({ busy: true, error: "", scanning: false })
    serial++
    const result = await save({
      root,
      drafts: buffer.drafts,
      write: (draft) => {
        if (version !== epoch || directory !== sdk.directory)
          return Promise.reject(new Error(language.t("latex.changed")))
        return client.file.write(
          { path: draft.path, content: draft.content, expectedChecksum: draft.base },
          { throwOnError: true },
        )
      },
      saved: (draft) => buffer.saved(draft.path, draft.content),
    })
    if (version !== epoch) return
    if (result.errors.length) {
      setState("error", language.t("latex.saveFailed", { files: result.errors.map((item) => item.path).join(", ") }))
      return
    }
    if (result.pending.length) {
      setState("error", language.t("latex.typing"))
      return
    }
    const fresh = (await client.latex.refresh({ root, editors: editors() }, { throwOnError: true })).data
    if (!fresh || version !== epoch) return
    assign(fresh)
    setState("loadError", "")
    if (pending().length || conflicts().length) {
      setState(
        "error",
        language.t("latex.conflict", { files: [...pending(), ...conflicts()].map((item) => item.path).join(", ") }),
      )
      return
    }
    if (fresh.binding?.revision !== revision) throw new Error(language.t("latex.changed"))
    const build = (
      await client.latex.build(
        {
          root,
          bindingRevision: revision,
          sourceRevision: fresh.freshness.sourceRevision,
          allowDownloads: state.downloads,
        },
        { throwOnError: true },
      )
    ).data
    if (version !== epoch) return
    setState("downloads", false)
    if (build) setState("project", "latest", build)
  }
  const start = () => {
    const version = epoch
    void compile()
      .catch((cause) => {
        if (version === epoch) error(cause)
      })
      .finally(() => {
        if (version === epoch) setState("busy", false)
      })
  }
  const cancel = () => {
    const build = state.project?.latest
    if (!build || !active()) return
    const version = epoch
    void sdk.client.latex
      .cancel({ id: build.id }, { throwOnError: true })
      .then(() => {
        if (version === epoch) refresh()
      })
      .catch((cause) => {
        if (version === epoch) error(cause)
      })
  }

  return (
    <div ref={container} data-component="latex-workspace" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="shrink-0 border-b border-border-weak-base px-3 pb-2 text-12-regular">
        <div class="flex flex-wrap items-center gap-2">
          <Button size="small" variant="ghost" onClick={() => setState("configuring", !state.configuring)}>
            {state.project?.binding?.main ?? language.t("latex.project")}
          </Button>
          <Button
            size="small"
            data-action="latex-compile"
            disabled={state.busy || active() || changed() || !file.ready()}
            onClick={start}
          >
            {state.busy ? language.t("latex.saving") : language.t("latex.compile")}
          </Button>
          <Show when={active()}>
            <Button size="small" variant="ghost" onClick={cancel}>
              {language.t("common.cancel")}
            </Button>
          </Show>
          <Button size="small" variant="ghost" onClick={refresh} disabled={state.busy}>
            {language.t("latex.refresh")}
          </Button>
          <Button size="small" variant="ghost" onClick={settings}>
            {language.t("latex.settings")}
          </Button>
          <Show when={state.width < 760}>
            <Button
              size="small"
              variant={state.pane === "source" ? "secondary" : "ghost"}
              onClick={() => setState("pane", "source")}
            >
              {language.t("latex.source")}
            </Button>
            <Button
              size="small"
              variant={state.pane === "pdf" ? "secondary" : "ghost"}
              onClick={() => setState("pane", "pdf")}
            >
              {language.t("latex.preview")}
            </Button>
          </Show>
        </div>
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
                onInput={(event) => {
                  edits++
                  setState("root", event.currentTarget.value)
                }}
              />
              <Button size="small" variant="secondary" onClick={open} disabled={state.busy || active()}>
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
                onInput={(event) => {
                  edits++
                  setState("main", event.currentTarget.value)
                }}
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
                  onChange={(event) => {
                    edits++
                    setState("driver", event.currentTarget.value as LatexBinding["driver"])
                  }}
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
                  onChange={(event) => {
                    edits++
                    setState("program", event.currentTarget.value as LatexBinding["program"])
                  }}
                >
                  <option value="auto">{language.t("latex.auto")}</option>
                  <option value="pdflatex">pdfLaTeX</option>
                  <option value="xelatex">XeLaTeX</option>
                </select>
              </label>
              <Button
                size="small"
                data-action="latex-bind"
                onClick={bind}
                disabled={state.busy || active() || !state.main || state.root !== state.project?.root}
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
          <span data-component="latex-preview-status" data-current={current()}>
            {current()
              ? language.t("latex.current")
              : artifact()
                ? language.t("latex.stale")
                : language.t("latex.empty")}
          </span>
          <Show when={pending().length}>
            <span>{language.t("latex.unsaved", { count: pending().length })}</span>
          </Show>
          <Show when={state.project?.latest}>
            <span data-component="latex-build-status">{language.t(`latex.state.${state.project!.latest!.state}`)}</span>
          </Show>
          <Show when={artifact()?.completedAt}>
            <time>{new Date(artifact()!.completedAt!).toLocaleTimeString(language.intl())}</time>
          </Show>
          <Show when={state.project?.freshness.checkedAt}>
            <span>
              {language.t("latex.checked", {
                time: new Date(state.project!.freshness.checkedAt!).toLocaleTimeString(language.intl()),
              })}
            </span>
          </Show>
        </div>
        <label class="mt-1 flex items-center gap-2 text-text-weak">
          <input
            type="checkbox"
            checked={state.downloads}
            onChange={(event) => setState("downloads", event.currentTarget.checked)}
            disabled={state.busy || active()}
          />
          {language.t("latex.downloads")}
        </label>
        <Show when={state.status && !state.status.tools.some((tool) => tool.installed)}>
          <p class="mt-2 text-text-weak">{language.t("latex.unavailable")}</p>
        </Show>
        <Show when={state.error || state.loadError || conflicts().length}>
          <p role="alert" class="mt-2 text-text-strong">
            {state.error ||
              state.loadError ||
              language.t("latex.conflict", {
                files: conflicts()
                  .map((item) => item.path)
                  .join(", "),
              })}
          </p>
        </Show>
      </div>
      <div class="flex min-h-0 flex-1">
        <div
          class="relative min-h-0 min-w-0 flex-col"
          style={{
            display: state.width >= 760 || state.pane === "source" ? "flex" : "none",
            width: state.width >= 760 ? `${state.ratio * 100}%` : "100%",
          }}
        >
          {props.children}
          <Show when={state.width >= 760}>
            <ResizeHandle
              direction="horizontal"
              size={state.width * state.ratio}
              min={240}
              max={state.width - 240}
              onResize={(size) => setState("ratio", size / state.width)}
            />
          </Show>
        </div>
        <div
          class="min-h-0 min-w-0 flex-1 border-l border-border-weak-base"
          style={{ display: state.width >= 760 || state.pane === "pdf" ? "block" : "none" }}
          data-component="latex-preview"
        >
          <Show
            when={artifact()}
            fallback={<div class="p-6 text-12-regular text-text-weak">{language.t("latex.emptyHelp")}</div>}
          >
            {(pdf) => (
              <PdfViewerShell
                src={`${sdk.url}/latex/build/${encodeURIComponent(pdf().id)}/pdf?directory=${encodeURIComponent(sdk.directory)}`}
                authHeader={props.auth}
                mode="compact"
                class="h-full"
              />
            )}
          </Show>
        </div>
      </div>
      <Show when={state.project?.latest}>
        {(build) => (
          <details
            class="max-h-52 shrink-0 overflow-auto border-t border-border-weak-base px-3 py-2 text-12-regular"
            open={build().state === "failed"}
            data-component="latex-diagnostics"
          >
            <summary class="cursor-pointer text-text-weak">
              {language.t("latex.diagnostics", { count: build().diagnostics.length })}
            </summary>
            <Show when={build().error}>
              <p class="my-2">{build().error}</p>
            </Show>
            <For each={build().diagnostics}>
              {(item) => (
                <button
                  class="my-1 block w-full text-left hover:underline disabled:no-underline"
                  disabled={!item.path}
                  onClick={() => {
                    setState("pane", "source")
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
          </details>
        )}
      </Show>
    </div>
  )
}
