import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { LatexBinding, LatexProject, LatexStatus } from "@opencode-ai/sdk/v2"
import { checksum } from "@opencode-ai/util/encode"
import { contains, dirty, save, source } from "@/components/latex-drafts"
import { formatServerError } from "@/utils/server-errors"
import { useFile } from "./file"
import { useLanguage } from "./language"
import { useSDK } from "./sdk"

// The editor and build state belong to the workspace, not a chat or a file tab.
export const { use: useLatex, provider: LatexProvider } = createSimpleContext({
  name: "Latex",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const file = useFile()
    const language = useLanguage()
    const [state, setState] = createStore({
      path: "",
      project: undefined as LatexProject | undefined,
      status: undefined as LatexStatus | undefined,
      root: "",
      main: "",
      driver: "auto" as LatexBinding["driver"],
      program: "auto" as LatexBinding["program"],
      configuring: false,
      collapsed: false,
      busy: false,
      saving: false,
      scanning: false,
      error: "",
      loadError: "",
      automatic: true,
      downloads: false,
      queued: false,
      preview: 0,
      composing: [] as string[],
      blocked: [] as string[],
      resolved: { path: "", content: "", nonce: 0 },
    })
    let epoch = 0
    let serial = 0
    let selection = 0
    let edits = 0
    let attempt = ""
    let target: { path: string; root?: string } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let watcher: ReturnType<typeof setTimeout> | undefined
    const scope = createMemo(() => `${sdk.url}\n${sdk.directory}`)
    const drafts = createMemo(() =>
      state.project?.binding
        ? file.drafts().filter((draft) => source(draft.path) && contains(state.project!.root, draft.path))
        : [],
    )
    const pending = createMemo(() => drafts().filter(dirty))
    const conflicts = createMemo(() =>
      drafts().filter((draft) => {
        if (state.blocked.includes(draft.path) || draft.base === undefined) return true
        const disk = state.project?.editors.find((item) => item.path === draft.path)
        return (
          dirty(draft) && !!disk && disk.checksum !== draft.base && disk.checksum !== (checksum(draft.content) ?? "")
        )
      }),
    )
    const running = createMemo(() => ["preparing", "running"].includes(state.project?.latest?.state ?? ""))
    const artifact = createMemo(() => state.project?.lastSuccessful)
    // A background scan is not evidence that the displayed build is outdated.
    const outdated = createMemo(() => {
      const project = state.project
      const build = artifact()
      return (
        !!build &&
        (pending().length > 0 ||
          conflicts().length > 0 ||
          project?.freshness.state === "stale" ||
          (!!project?.binding && project.binding.revision !== build.bindingRevision) ||
          (!!project?.freshness.sourceRevision && project.freshness.sourceRevision !== build.sourceRevision))
      )
    })
    const verified = createMemo(() => {
      const project = state.project
      const build = artifact()
      return (
        !!build &&
        !outdated() &&
        !state.loadError &&
        project?.freshness.state === "fresh" &&
        project.binding?.revision === build.bindingRevision &&
        project.freshness.sourceRevision === build.sourceRevision
      )
    })
    const current = createMemo(() => {
      const project = state.project
      const build = artifact()
      return (
        !!build &&
        project?.freshness.state === "fresh" &&
        project.binding?.revision === build.bindingRevision &&
        project.freshness.sourceRevision === build.sourceRevision &&
        project.latest?.id === build.id &&
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
        state.root !== binding.root ||
        state.main !== binding.main ||
        state.driver !== binding.driver ||
        state.program !== binding.program
      )
    })
    const stamp = (project: LatexProject) => `${project.binding?.revision}\n${project.freshness.sourceRevision}`
    const editors = () => drafts().map((draft) => draft.path)
    const error = (cause: unknown) => setState("error", formatServerError(cause, language.t))
    const assign = (project: LatexProject, form = false) => {
      setState("project", reconcile(project))
      if (!form) return
      setState({
        root: project.root,
        main: project.binding?.main ?? project.main ?? "",
        driver: project.binding?.driver ?? "auto",
        program: project.binding?.program ?? "auto",
        configuring: !project.binding,
        ...(!project.binding ? { collapsed: false } : {}),
      })
    }
    const schedule = () => {
      clearTimeout(timer)
      if (!state.automatic) return
      timer = setTimeout(() => void run(false), 1000)
    }
    const read = async (refresh = true, root = state.project?.root, form = false) => {
      if (!state.path) return
      const version = epoch
      const request = ++serial
      const revision = edits
      const initialize = form || (!state.project && !edits)
      const client = sdk.client
      setState("scanning", refresh)
      try {
        const project = (await client.latex.project({ path: state.path, root }, { throwOnError: true })).data
        if (!project || version !== epoch || request !== serial) return
        assign(project, initialize && edits === revision)
        const result = refresh
          ? (await client.latex.refresh({ root: project.root, editors: editors() }, { throwOnError: true })).data
          : project
        if (!result || version !== epoch || request !== serial) return
        assign(result)
        if (refresh) setState("loadError", "")
        return result
      } catch (cause) {
        if (version === epoch && request === serial)
          setState({
            loadError: formatServerError(cause, language.t),
            configuring: initialize || !state.project || state.configuring,
          })
      } finally {
        if (version === epoch && request === serial) setState("scanning", false)
      }
    }
    // Reload externally changed clean buffers; a concurrently edited draft is never replaced.
    const reload = async (project: LatexProject) => {
      const version = epoch
      await Promise.all(
        drafts()
          .filter((draft) => {
            const disk = project.editors.find((item) => item.path === draft.path)
            return !dirty(draft) && disk && disk.checksum !== draft.base
          })
          .map(async (draft) => {
            const snapshot = { ...draft }
            await file.load(snapshot.path, { force: true })
            if (
              version !== epoch ||
              file.draft(snapshot.path) !== snapshot.content ||
              file.draftBase(snapshot.path) !== snapshot.base
            )
              return
            const content = file.get(snapshot.path)?.content
            if (content?.type !== "text") return
            batch(() => {
              file.setDraft(snapshot.path, content.content)
              file.setDraftBase(snapshot.path, checksum(content.content) ?? "")
              setState("resolved", { path: snapshot.path, content: content.content, nonce: state.resolved.nonce + 1 })
            })
          }),
      )
    }
    const refresh = async () => {
      if (state.busy) return
      const project = await read(true)
      if (!project) return
      await reload(project)
      if (!state.automatic || !project.binding || state.error || state.loadError || conflicts().length) return
      const latest = project.latest
      if (
        pending().length ||
        !latest ||
        latest.bindingRevision !== project.binding.revision ||
        latest.sourceRevision !== project.freshness.sourceRevision
      )
        schedule()
    }
    const flush = async () => {
      const project = state.project
      if (!project?.binding || state.composing.length || conflicts().length) return false
      const version = epoch
      const client = sdk.client
      const buffer = file.capture()
      const root = project.root
      setState("saving", true)
      const result = await save({
        root: project.root,
        drafts: buffer.drafts,
        write: (draft) =>
          version === epoch
            ? client.file.write(
                { path: draft.path, content: draft.content, expectedChecksum: draft.base },
                { throwOnError: true },
              )
            : Promise.reject(new Error(language.t("latex.changed"))),
        saved: (draft, base) =>
          batch(() => {
            buffer.saved(draft.path, draft.content)
            if (version !== epoch || state.project?.root !== root) return
            setState("project", "freshness", "state", "stale")
            const index = state.project.editors.findIndex((item) => item.path === draft.path)
            if (index < 0) {
              setState("project", "editors", (items) => [...items, { path: draft.path, checksum: base }])
              return
            }
            setState("project", "editors", index, "checksum", base)
          }),
      })
      if (version !== epoch) return false
      setState("saving", false)
      if (!result.errors.length) return result.pending.length === 0
      setState({
        blocked: result.errors.map((item) => item.path),
        error: language.t("latex.saveFailed", { files: result.errors.map((item) => item.path).join(", ") }),
      })
      return false
    }
    async function run(manual: boolean, compile = true) {
      if (!manual && !state.automatic) return
      if (!state.project?.binding || !file.ready() || state.composing.length || conflicts().length) return
      if (state.busy) {
        setState("queued", true)
        return
      }
      if (!manual && state.error) return
      clearTimeout(timer)
      const version = epoch
      const binding = state.project.binding.revision
      const root = state.project.root
      const client = sdk.client
      setState({ busy: true, error: "", scanning: false })
      serial++
      try {
        const saved = await flush()
        if (version !== epoch || (!saved && (!manual || state.error || conflicts().length))) return
        const project = (await client.latex.refresh({ root, editors: editors() }, { throwOnError: true })).data
        if (!project || version !== epoch) return
        assign(project)
        setState("loadError", "")
        // Explicit builds use what this save wrote. Later typing stays in the editor;
        // automatic builds wait for the newest draft instead.
        if (conflicts().length || (!manual && (pending().length || state.composing.length))) {
          schedule()
          return
        }
        if (project.binding?.revision !== binding) throw new Error(language.t("latex.changed"))
        if (!compile || changed() || (!manual && !state.automatic)) return
        if (running()) {
          setState("queued", true)
          return
        }
        setState("queued", false)
        if (
          !manual &&
          (attempt === stamp(project) ||
            (project.latest?.sourceRevision === project.freshness.sourceRevision &&
              project.latest?.bindingRevision === binding))
        )
          return
        const downloads = manual && state.downloads
        // Download permission applies to this request only, including failed starts.
        if (manual) setState("downloads", false)
        attempt = stamp(project)
        setState("queued", false)
        const build = (
          await client.latex.build(
            {
              root,
              bindingRevision: binding,
              sourceRevision: project.freshness.sourceRevision,
              allowDownloads: downloads,
            },
            { throwOnError: true },
          )
        ).data
        if (version === epoch && build) setState("project", "latest", build)
      } catch (cause) {
        if (version === epoch) error(cause)
      } finally {
        if (version === epoch) {
          setState({ busy: false, saving: false })
          if (!state.error && !conflicts().length && (pending().length || (state.queued && !running()))) schedule()
        }
      }
    }
    const show = () => setState("preview", state.preview + 1)
    const activate = async (path: string, root?: string) => {
      if (!source(path)) return
      if (root === undefined && state.project && contains(state.project.root, path)) {
        target = undefined
        setState("path", path)
        return
      }
      // Automatic mode finishes the old save first. Manual mode leaves its drafts
      // in the file store so changing projects never silently writes them.
      if (state.busy) {
        target = { path, root }
        return
      }
      if (state.automatic && (pending().length || conflicts().length)) {
        target = { path, root }
        await run(true, false)
        if (pending().length || conflicts().length) return
        if (target?.path !== path || target.root !== root) return
      }
      target = undefined
      epoch++
      serial++
      const version = epoch
      clearTimeout(timer)
      edits = 0
      attempt = ""
      setState({
        path,
        project: undefined,
        busy: false,
        saving: false,
        scanning: false,
        error: "",
        loadError: "",
        queued: false,
        blocked: [],
        composing: [],
        downloads: false,
      })
      show()
      const project = await read(true, root, true)
      if (version !== epoch) return
      if (project?.binding && state.automatic) schedule()
      void sdk.client.latex
        .status({}, { throwOnError: true })
        .then((result) => {
          if (version === epoch) setState("status", result.data)
        })
        .catch((cause) => {
          if (version === epoch) error(cause)
        })
    }
    const open = async (path: string, root?: string) => {
      const request = ++selection
      if (!source(path)) return
      if (root !== undefined || !state.project || path === state.path || !contains(state.project.root, path)) {
        await activate(path, root)
        return
      }
      // A descendant may have its own main-document binding. Discover its
      // nearest project before reusing the current project's editing queue.
      const version = epoch
      const result = await sdk.client.latex.project({ path }, { throwOnError: true }).then(
        (value) => ({ data: value.data }),
        (cause: unknown) => ({ error: cause }),
      )
      if (version !== epoch || request !== selection) return
      if ("error" in result) {
        setState("loadError", formatServerError(result.error, language.t))
        return
      }
      const project = result.data
      if (!project) return
      if (project.root === state.project?.root && project.binding?.revision === state.project.binding?.revision) {
        target = undefined
        setState("path", path)
        return
      }
      await activate(path, project.root)
    }
    const bind = async () => {
      const project = state.project
      if (!project || !state.main || state.busy || running()) return
      const version = epoch
      const revision = edits
      setState({ busy: true, error: "" })
      try {
        await sdk.client.latex.bind(
          {
            root: project.root,
            main: state.main,
            driver: state.driver,
            program: state.program,
            expectedRevision: project.binding?.revision,
          },
          { throwOnError: true },
        )
        if (version !== epoch) return
        const result = await read(true, project.root, revision === edits)
        if (result && version === epoch && revision === edits) setState("configuring", false)
        attempt = ""
      } catch (cause) {
        if (version === epoch) error(cause)
      } finally {
        if (version === epoch) {
          setState("busy", false)
          if (!state.error) schedule()
        }
      }
    }
    const cancel = async () => {
      const build = state.project?.latest
      if (!build || !running()) return
      const version = epoch
      setState("queued", false)
      clearTimeout(timer)
      await sdk.client.latex
        .cancel({ id: build.id }, { throwOnError: true })
        .then(() => {
          if (version === epoch) void read(true)
        })
        .catch((cause) => {
          if (version === epoch) error(cause)
        })
    }
    const compare = async (path: string) => {
      const version = epoch
      await file.load(path, { force: true })
      if (version !== epoch) return
      const content = file.get(path)?.content
      if (content?.type !== "text") throw new Error(language.t("latex.changed"))
      return {
        path,
        disk: content.content,
        draft: file.draft(path) ?? "",
        base: checksum(content.content) ?? "",
        epoch: version,
      }
    }
    const resolve = async (snapshot: NonNullable<Awaited<ReturnType<typeof compare>>>, choice: "disk" | "draft") => {
      if (snapshot.epoch !== epoch || state.busy) {
        error(new Error(language.t("latex.changed")))
        return false
      }
      const version = epoch
      const buffer = file.capture()
      setState({ busy: true, error: "" })
      try {
        if (choice === "draft") {
          await sdk.client.file.write(
            { path: snapshot.path, content: snapshot.draft, expectedChecksum: snapshot.base },
            { throwOnError: true },
          )
          buffer.saved(snapshot.path, snapshot.draft)
        }
        if (version !== epoch) return false
        if (choice === "disk") {
          // Do not discard edits typed while the comparison was open.
          if (file.draft(snapshot.path) !== snapshot.draft) throw new Error(language.t("latex.typing"))
          const fresh = await compare(snapshot.path)
          if (!fresh || fresh.base !== snapshot.base) throw new Error(language.t("latex.changed"))
          if (file.draft(snapshot.path) !== snapshot.draft) throw new Error(language.t("latex.typing"))
          file.setDraft(snapshot.path, snapshot.disk)
          file.setDraftBase(snapshot.path, snapshot.base)
          setState("resolved", { path: snapshot.path, content: snapshot.disk, nonce: state.resolved.nonce + 1 })
        }
        setState(
          "blocked",
          state.blocked.filter((path) => path !== snapshot.path),
        )
        await read(true)
        return true
      } catch (cause) {
        if (version === epoch) error(cause)
        return false
      } finally {
        if (version === epoch) {
          setState("busy", false)
          if (!state.error) schedule()
        }
      }
    }
    createEffect(
      on(scope, () => {
        epoch++
        serial++
        selection++
        edits = 0
        attempt = ""
        target = undefined
        clearTimeout(timer)
        clearTimeout(watcher)
        setState({
          path: "",
          project: undefined,
          status: undefined,
          root: "",
          main: "",
          driver: "auto",
          program: "auto",
          busy: false,
          saving: false,
          scanning: false,
          error: "",
          loadError: "",
          configuring: false,
          collapsed: false,
          queued: false,
          blocked: [],
          composing: [],
          downloads: false,
          automatic: true,
        })
      }),
    )
    createEffect(
      on(
        () =>
          [
            drafts()
              .map((draft) => `${draft.path}\n${draft.base}\n${draft.content}`)
              .join("\0"),
            state.composing.join("\0"),
            file.ready(),
          ] as const,
        () => {
          clearTimeout(timer)
          if (pending().length && !state.composing.length && !conflicts().length) {
            setState("error", "")
            schedule()
          }
        },
      ),
    )
    createEffect(
      on(
        () => [state.busy, pending().length, conflicts().length, state.composing.length, state.automatic] as const,
        ([busy, pending, conflicts, composing, automatic]) => {
          if (!target || busy || composing || (automatic && (pending || conflicts))) return
          const next = target
          target = undefined
          void open(next.path, next.root)
        },
      ),
    )
    createEffect(
      on(scope, () => {
        const stop = sdk.event.on("file.watcher.updated", () => {
          clearTimeout(watcher)
          watcher = setTimeout(() => {
            if (state.path && !document.hidden) void refresh()
          }, 500)
        })
        onCleanup(stop)
      }),
    )
    createEffect(
      on(scope, () => {
        let polling = false
        const poll = setInterval(() => {
          if (polling || !state.path || state.busy || state.scanning || !running()) return
          polling = true
          void read(false)
            .then((project) => {
              if (project && !["preparing", "running"].includes(project.latest?.state ?? "")) {
                if (state.queued) schedule()
                void refresh()
              }
            })
            .finally(() => {
              polling = false
            })
        }, 500)
        onCleanup(() => clearInterval(poll))
      }),
    )
    const focus = () => {
      if (state.path && !document.hidden) void refresh()
    }
    const interval = setInterval(focus, 30_000)
    window.addEventListener("focus", focus)
    document.addEventListener("visibilitychange", focus)
    onCleanup(() => {
      epoch++
      clearTimeout(timer)
      clearTimeout(watcher)
      clearInterval(interval)
      window.removeEventListener("focus", focus)
      document.removeEventListener("visibilitychange", focus)
    })
    return {
      state,
      open,
      show,
      refresh,
      bind,
      cancel,
      compare,
      resolve,
      pending,
      conflicts,
      running,
      artifact,
      current,
      outdated,
      verified,
      changed,
      compile: () => run(true),
      save: () => run(true, false),
      edit: (value: Partial<Pick<typeof state, "root" | "main" | "driver" | "program">>) => {
        edits++
        setState(value)
      },
      configure: (value: boolean) => {
        setState("configuring", value)
        if (value) setState("collapsed", false)
      },
      collapse: (value: boolean) => setState("collapsed", value),
      downloads: (value: boolean) => setState("downloads", value),
      automatic: (value: boolean) => {
        setState("automatic", value)
        clearTimeout(timer)
        if (!value) setState("queued", false)
        if (value) schedule()
      },
      composing: (path: string, value: boolean) => {
        if (state.composing.includes(path) === value) return
        setState("composing", value ? [...state.composing, path] : state.composing.filter((item) => item !== path))
      },
      pdf: () => {
        const build = artifact()
        if (!build?.pdf) return
        return {
          build,
          root: build.root,
          key: `${build.root}\n${build.main}`,
          title: `${
            build.main
              .split(/[\\/]/)
              .pop()
              ?.replace(/\.tex$/i, "") ?? "document"
          }.pdf`,
          src: `${sdk.url}/latex/build/${encodeURIComponent(build.id)}/pdf?directory=${encodeURIComponent(sdk.directory)}`,
        }
      },
    }
  },
})
