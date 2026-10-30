import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { LatexBuild } from "@opencode-ai/sdk/v2/client"
import { checksum } from "@opencode-ai/util/encode"
import { showToast } from "@opencode-ai/ui/toast"
import { contains, dirty } from "@/components/latex-drafts"
import type { PdfLocate, PdfLocateUnavailable, PdfReveal } from "@/components/pdf-viewer-shell-official"
import { useFile } from "@/context/file"
import { useLatex } from "@/context/latex"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { identity, paper } from "@/utils/pdf-source"
import { useSessionLayout } from "./session-layout"
import type { useLatexReading } from "./use-latex-reading"

type Reading = Pick<ReturnType<typeof useLatexReading>, "key" | "document" | "target" | "updating"> & {
  state: Pick<ReturnType<typeof useLatexReading>["state"], "versions" | "displayed">
}

export function useLatexNavigation(reading: Reading) {
  const latex = useLatex()
  const file = useFile()
  const sdk = useSDK()
  const language = useLanguage()
  const layout = useSessionLayout()
  const [state, setState] = createStore({ reveal: undefined as PdfReveal | undefined, epoch: 0, busy: false })
  let serial = 0
  let epoch = 0
  const stamp = createMemo(() =>
    JSON.stringify([
      sdk.url,
      sdk.directory,
      latex.state.path,
      latex.state.project?.binding?.revision,
      latex.state.root,
      latex.state.main,
      latex.state.driver,
      latex.state.program,
      latex.state.composing,
      file.drafts().map((draft) => [draft.path, draft.base, draft.content]),
    ]),
  )
  createEffect(
    on(stamp, () => {
      epoch++
      setState("reveal", undefined)
    }),
  )
  onCleanup(() => {
    serial++
    epoch++
  })

  const notify = (reason: "stale" | "unavailable" | "missing" | "nomatch" | "busy" | "failed") =>
    showToast({
      title: language.t("latex.sync.locate"),
      description: language.t(`latex.sync.${reason}`),
      duration: 5000,
    })
  const problem = (cause: unknown) => {
    const text = JSON.stringify(cause) ?? String(cause)
    if (/source mapping|SyncTeX|synchronization/i.test(text)) return notify("unavailable")
    if (/409|changed|stale|revision|compile again/i.test(text)) return notify("stale")
    if (/404|no (matching|match|location)|not found/i.test(text)) return notify("nomatch")
    if (/503|unavailable|unsupported|synchronization/i.test(text)) return notify("unavailable")
    notify("failed")
  }
  const ready = (build: LatexBuild) => {
    if (
      file.drafts().some((draft) => contains(build.root, draft.path) && dirty(draft)) ||
      (latex.state.project?.root === build.root &&
        (latex.changed() || latex.conflicts().length || latex.state.composing.length))
    ) {
      notify("stale")
      return false
    }
    if (build.sync?.state !== "ready") {
      notify("unavailable")
      return false
    }
    return true
  }
  // Also verify clean cached drafts: another application may have compiled a
  // newer document while the editor still displays the previous saved text.
  const verify = async (build: LatexBuild) => {
    const drafts = file.drafts().filter((draft) => contains(build.root, draft.path))
    const result = await sdk.client.latex.refresh(
      { root: build.root, editors: drafts.map((draft) => draft.path) },
      { throwOnError: true },
    )
    const project = result.data
    return (
      !!project &&
      project.binding?.revision === build.bindingRevision &&
      project.freshness.sourceRevision === build.sourceRevision &&
      drafts.every(
        (draft) => project.editors.find((item) => item.path === draft.path)?.checksum === checksum(draft.content),
      )
    )
  }
  const forward = async (position: { path: string; line: number; column: number }) => {
    if (state.busy) return notify("busy")
    const project = latex.state.project
    if (!project?.binding || !contains(project.root, position.path)) return notify("missing")
    const same = reading.document()?.root === project.root && reading.document()?.main === project.binding.main
    if (same && reading.updating()) return notify("busy")
    const build = same
      ? reading.state.versions.find((item) => item.build.id === reading.state.displayed)?.build
      : project.lastSuccessful
    if (!build) return notify(same && reading.updating() ? "busy" : "missing")
    if (!ready(build)) return
    const request = ++serial
    const version = epoch
    const document = reading.key()
    const displayed = reading.state.displayed
    const valid = () =>
      request === serial && version === epoch && document === reading.key() && displayed === reading.state.displayed
    const checked = await verify(build).catch((cause: unknown) => {
      if (valid()) problem(cause)
    })
    if (!valid() || checked === undefined) return
    if (!checked) return notify("stale")
    const result = await sdk.client.latex
      .forward({ id: build.id, ...position }, { throwOnError: true })
      .catch((cause: unknown) => {
        if (valid()) problem(cause)
      })
    if (!valid() || !result?.data || !ready(build)) return
    if (state.busy) return notify("busy")
    if (!same) layout.reading().open(paper(build.root, build.main), build.main.replace(/\.tex$/i, ".pdf"))
    setState({
      epoch: version,
      reveal: {
        id: crypto.randomUUID(),
        document: identity(sdk.url, sdk.directory, build.root, build.main),
        version: build.id,
        page: result.data.page,
        rect: result.data.rect,
      },
    })
  }
  const inverse = async (input: PdfLocate) => {
    if (input.document !== reading.key() || input.version !== reading.state.displayed) return
    const build = reading.state.versions.find((item) => item.build.id === input.version)?.build
    if (!build || !ready(build)) return
    const request = ++serial
    const version = epoch
    const valid = () =>
      request === serial &&
      version === epoch &&
      input.document === reading.key() &&
      input.version === reading.state.displayed
    const checked = await verify(build).catch((cause: unknown) => {
      if (valid()) problem(cause)
    })
    if (!valid() || checked === undefined) return
    if (!checked) return notify("stale")
    const result = await sdk.client.latex
      .inverse({ id: input.version, page: input.page, x: input.x, y: input.y }, { throwOnError: true })
      .catch((cause: unknown) => {
        if (valid()) problem(cause)
      })
    if (!valid() || !result?.data) return
    const target = result.data
    await file.load(target.path, { force: true })
    if (!valid() || !ready(build)) return
    const content = file.get(target.path)?.content
    if (content?.type !== "text" || file.get(target.path)?.error) return notify("failed")
    const draft = file.draft(target.path)
    if (draft !== undefined && draft !== content.content) return notify("stale")
    const confirmed = await verify(build).catch((cause: unknown) => {
      if (valid()) problem(cause)
    })
    if (!valid() || confirmed === undefined) return
    if (!confirmed) return notify("stale")
    const tab = file.tab(target.path)
    layout.view().reviewPanel.open()
    layout.tabs().open(tab)
    layout.tabs().setActive(tab)
    file.locate(target.path, target.line, target.column ?? 1)
    file.reveal(target.path)
  }
  createEffect(
    on(
      () => latex.state.locating.nonce,
      () => {
        if (latex.state.locating.path) void forward({ ...latex.state.locating })
      },
      { defer: true },
    ),
  )
  return {
    forward,
    inverse,
    busy: (value: boolean) => setState("busy", value),
    reveal: () => {
      const value = state.reveal
      return value &&
        state.epoch === epoch &&
        value.document === reading.key() &&
        (!reading.target() || value.version === reading.target())
        ? value
        : undefined
    },
    unavailable: (input: PdfLocateUnavailable) => {
      if (input.document !== reading.key() || input.version !== reading.state.displayed) return
      if (input.id && input.id !== state.reveal?.id) return
      notify(input.reason)
    },
  }
}
