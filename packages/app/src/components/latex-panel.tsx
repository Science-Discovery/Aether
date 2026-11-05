import { createEffect, createMemo, createUniqueId, For, on, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { LatexBinding } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
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
  onLocate?: () => void
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
  const controls = createUniqueId()
  const projectMenu = createUniqueId()
  const mainList = createUniqueId()
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
  const [form, setForm] = createStore({
    root: state.root,
    main: state.main,
    driver: state.driver,
    program: state.program,
    realtime: state.realtime,
    dirty: { root: false, main: false, driver: false, program: false, realtime: false },
    suggestions: false,
  })
  const clean = () => ({ root: false, main: false, driver: false, program: false, realtime: false })
  createEffect(
    on(
      () => [state.configuring, sdk.url, sdk.directory] as const,
      () => {
        setForm({
          root: state.root,
          main: state.main,
          driver: state.driver,
          program: state.program,
          realtime: state.realtime,
          dirty: clean(),
          suggestions: false,
        })
      },
    ),
  )
  createEffect(
    on(
      () => [state.root, state.main, state.driver, state.program, state.realtime] as const,
      ([root, main, driver, program, realtime]) => {
        if (!state.configuring) return
        if (!form.dirty.root) setForm("root", root)
        if (!form.dirty.main) setForm("main", main)
        if (!form.dirty.driver) setForm("driver", driver)
        if (!form.dirty.program) setForm("program", program)
        if (!form.dirty.realtime) setForm("realtime", realtime)
      },
    ),
  )
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  const candidates = createMemo(() => {
    const value = form.main.trim().toLowerCase()
    return [...new Set([...(state.project?.candidates ?? []), ...(state.project?.main ? [state.project.main] : [])])]
      .filter((item) => !value || item.toLowerCase().includes(value))
      .slice(0, 8)
  })
  createEffect(() => {
    if (!state.configuring || state.collapsed) return
    const pointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menu?.contains(target) || trigger?.contains(target)) return
      if (target instanceof Element && target.closest('[data-component="select-content"]')) return
      latex.configure(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") latex.configure(false)
    }
    document.addEventListener("pointerdown", pointer, true)
    window.addEventListener("keydown", key, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", pointer, true)
      window.removeEventListener("keydown", key, true)
    })
  })
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
  const selectDriver = (value: LatexBinding["driver"]) => {
    setForm("driver", value)
    setForm("dirty", "driver", true)
    if (value !== "tectonic") latex.downloads(false)
  }
  const selectProgram = (value: LatexBinding["program"]) => {
    setForm("program", value)
    setForm("dirty", "program", true)
    if (value !== "lualatex") setForm("realtime", false)
  }
  const apply = async (realtime: boolean) => {
    latex.edit({
      root: form.root,
      main: form.main,
      driver: form.driver,
      program: form.program,
      realtime: realtime && form.program === "lualatex",
    })
    if (form.driver !== "tectonic") latex.downloads(false)
    await latex.bind()
  }
  const save = async () => {
    const realtime = form.program === "lualatex" ? form.realtime : false
    if (state.realtime && !realtime) {
      await leaveRealtime()
      return
    }
    await apply(realtime)
  }
  const help = () => dialog.show(() => <DialogLatexHelp />)
  const leaveRealtime = async () => {
    if (latex.current() && !state.realtimeDirty) {
      await apply(false)
      return
    }
    latex.configure(false)
    dialog.show(() => (
      <Dialog title={language.t("latex.realtime.leaveTitle")}>
        <div class="flex flex-col gap-3 p-4">
          <p class="text-12-regular text-text-weak">{language.t("latex.realtime.leaveBody")}</p>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                dialog.close()
                setForm("realtime", true)
              }}
            >
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                dialog.close()
                void apply(false)
              }}
            >
              {language.t("latex.realtime.discardSwitch")}
            </Button>
            <Button
              onClick={() => {
                dialog.close()
                void (async () => {
                  if (form.program !== "lualatex") {
                    await apply(false)
                    return
                  }
                  await apply(true)
                  const ok = await latex.compileVersion()
                  if (ok) await apply(false)
                })()
              }}
            >
              {language.t("latex.realtime.saveSwitch")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }
  const reading = () =>
    state.reading.root === state.project?.root && state.reading.main === state.project?.binding?.main
      ? state.reading
      : undefined
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
          : reading()?.updating && !latex.running()
            ? language.t("latex.preview.updating")
            : state.project?.latest
              ? language.t(`latex.state.${state.project.latest.state}`)
              : "",
      !reading()?.updating && (reading()?.outdated || latex.outdated()) ? language.t("latex.preview.stale") : "",
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
            <div class="relative shrink-0">
              <Button
                ref={trigger}
                size="small"
                variant="secondary"
                data-action="latex-project-settings"
                aria-haspopup="dialog"
                aria-controls={projectMenu}
                aria-expanded={state.configuring && !state.collapsed}
                onClick={() => latex.configure(state.collapsed || !state.configuring)}
              >
                <span class="max-w-48 truncate">
                  {state.project?.binding?.main ?? form.main ?? state.project?.main ?? language.t("latex.project")}
                </span>
                <Icon
                  name="chevron-down"
                  size="small"
                  class={
                    state.configuring && !state.collapsed ? "rotate-180 transition-transform" : "transition-transform"
                  }
                />
              </Button>
              <Show when={state.configuring && !state.collapsed}>
                <div
                  ref={menu}
                  id={projectMenu}
                  role="dialog"
                  aria-label={language.t("latex.project")}
                  data-component="latex-project-settings"
                  class="absolute left-0 top-full z-50 mt-1 flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha p-3 text-text-strong shadow-[var(--shadow-lg-border-base)]"
                >
                  <p class="text-12-medium text-text-weak">{language.t("latex.project")}</p>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-regular text-text-weak">{language.t("latex.root")}</span>
                    <span class="flex items-center gap-2">
                      <input
                        aria-label={language.t("latex.root")}
                        class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-12-regular"
                        value={form.root}
                        onInput={(event) => {
                          setForm("root", event.currentTarget.value)
                          setForm("dirty", "root", true)
                        }}
                      />
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => void latex.open(props.path, form.root.trim() || ".")}
                        disabled={state.busy || latex.running()}
                      >
                        {language.t("latex.open")}
                      </Button>
                    </span>
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-12-regular text-text-weak">{language.t("latex.main")}</span>
                    <span class="relative">
                      <input
                        aria-label={language.t("latex.main")}
                        aria-autocomplete="list"
                        aria-controls={mainList}
                        aria-expanded={form.suggestions && candidates().length > 0}
                        autocomplete="off"
                        placeholder={language.t("latex.choose")}
                        class="min-w-0 w-full rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-12-regular"
                        value={form.main}
                        onFocus={() => setForm("suggestions", true)}
                        onBlur={() => setTimeout(() => setForm("suggestions", false), 120)}
                        onInput={(event) => {
                          setForm("main", event.currentTarget.value)
                          setForm("dirty", "main", true)
                          setForm("suggestions", true)
                        }}
                      />
                      <Show when={form.suggestions && candidates().length > 0}>
                        <div
                          id={mainList}
                          role="listbox"
                          aria-label={language.t("latex.main")}
                          class="absolute left-0 right-0 top-full z-10 mt-1 max-h-40 overflow-auto rounded-md border border-border-base bg-surface-raised-stronger-non-alpha p-1 shadow-[var(--shadow-lg-border-base)]"
                        >
                          <For each={candidates()}>
                            {(item) => (
                              <button
                                type="button"
                                role="option"
                                aria-selected={form.main === item}
                                class="block w-full truncate rounded px-2 py-1 text-left text-12-regular text-text-strong hover:bg-surface-raised-base-hover"
                                onPointerDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  setForm("main", item)
                                  setForm("dirty", "main", true)
                                  setForm("suggestions", false)
                                }}
                              >
                                {item}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </span>
                  </label>
                  <div class="flex items-center gap-2">
                    <span class="shrink-0 text-12-regular text-text-weak">{language.t("latex.driver")}</span>
                    <div class="min-w-0 flex-1">
                      <select
                        aria-hidden="true"
                        tabIndex={-1}
                        aria-label={language.t("latex.driver")}
                        class="sr-only"
                        value={form.driver}
                        onChange={(event) => selectDriver(event.currentTarget.value as LatexBinding["driver"])}
                      >
                        <option value="auto">{language.t("latex.auto")}</option>
                        <option value="tectonic">Tectonic</option>
                        <option value="latexmk">latexmk</option>
                      </select>
                      <Select
                        options={["auto", "tectonic", "latexmk"] as const}
                        current={form.driver}
                        label={(value) =>
                          value === "auto" ? language.t("latex.auto") : value === "tectonic" ? "Tectonic" : "latexmk"
                        }
                        onSelect={(value) => value && selectDriver(value)}
                        size="small"
                        variant="secondary"
                        triggerVariant="settings"
                        triggerStyle={{ width: "100%" }}
                        triggerProps={{ "aria-label": language.t("latex.driver"), "data-action": "latex-driver" }}
                      />
                    </div>
                    <span class="shrink-0 text-12-regular text-text-weak">{language.t("latex.program")}</span>
                    <div class="min-w-0 flex-1">
                      <select
                        aria-hidden="true"
                        tabIndex={-1}
                        aria-label={language.t("latex.program")}
                        class="sr-only"
                        value={form.program}
                        onChange={(event) => selectProgram(event.currentTarget.value as LatexBinding["program"])}
                      >
                        <option value="auto">{language.t("latex.auto")}</option>
                        <option value="pdflatex">pdfLaTeX</option>
                        <option value="xelatex">XeLaTeX</option>
                        <option value="lualatex">LuaLaTeX</option>
                      </select>
                      <Select
                        options={["auto", "pdflatex", "xelatex", "lualatex"] as const}
                        current={form.program}
                        label={(value) =>
                          value === "auto"
                            ? language.t("latex.auto")
                            : value === "pdflatex"
                              ? "pdfLaTeX"
                              : value === "xelatex"
                                ? "XeLaTeX"
                                : "LuaLaTeX"
                        }
                        onSelect={(value) => value && selectProgram(value)}
                        size="small"
                        variant="secondary"
                        triggerVariant="settings"
                        triggerStyle={{ width: "100%" }}
                        triggerProps={{ "aria-label": language.t("latex.program"), "data-action": "latex-program" }}
                      />
                    </div>
                  </div>
                  <Show when={form.program === "lualatex"}>
                    <label class="flex items-center gap-2 text-text-weak">
                      <input
                        type="checkbox"
                        data-action="latex-realtime"
                        checked={form.realtime}
                        disabled={state.busy || latex.running()}
                        onChange={(event) => {
                          setForm("realtime", event.currentTarget.checked)
                          setForm("dirty", "realtime", true)
                        }}
                      />
                      {language.t("latex.realtime.toggle")}
                    </label>
                  </Show>
                  <Show when={state.project?.reason === "ambiguous"}>
                    <p class="text-12-regular text-text-weak">{language.t("latex.ambiguous")}</p>
                  </Show>
                  <Show when={state.project?.issue}>
                    <p class="text-12-regular text-text-weak">{state.project?.issue}</p>
                  </Show>
                  <div class="flex justify-end border-t border-border-weak-base pt-2">
                    <Button
                      size="small"
                      data-action="latex-bind"
                      onClick={() => void save()}
                      disabled={state.busy || latex.running() || !form.main || form.root !== state.project?.root}
                    >
                      {language.t("latex.bind")}
                    </Button>
                  </div>
                </div>
              </Show>
            </div>
            <Show when={!state.collapsed}>
              <label class="flex items-center gap-2 text-text-weak">
                <input
                  type="checkbox"
                  checked={state.automatic}
                  disabled={state.realtime}
                  title={state.realtime ? language.t("latex.realtime.autosaveOff") : undefined}
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
              <Show when={props.onLocate}>
                <Button
                  size="small"
                  variant="secondary"
                  data-action="latex-locate"
                  title={language.t("latex.sync.shortcut")}
                  onClick={() => props.onLocate?.()}
                >
                  {language.t("latex.sync.locate")}
                </Button>
              </Show>
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
              onClick={() => {
                if (!state.collapsed) latex.configure(false)
                latex.collapse(!state.collapsed)
              }}
            >
              {language.t(state.collapsed ? "latex.expand" : "latex.collapse")}
            </Button>
          </div>
        </div>
        <div id={controls} hidden={state.collapsed} data-component="latex-toolbar-details">
          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-text-weak">
            <span data-component="latex-preview-status" data-current={latex.current()}>
              {reading()?.updating
                ? language.t("latex.preview.updating")
                : !latex.artifact()
                  ? language.t("latex.empty")
                  : reading()?.outdated || latex.outdated()
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
          <Show when={form.driver === "tectonic"}>
            <label class="mt-1 flex items-center gap-2 text-text-weak">
              <input
                type="checkbox"
                checked={state.downloads}
                onChange={(event) => latex.downloads(event.currentTarget.checked)}
                disabled={state.busy || latex.running()}
              />
              {language.t("latex.downloads")}
            </label>
          </Show>
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
