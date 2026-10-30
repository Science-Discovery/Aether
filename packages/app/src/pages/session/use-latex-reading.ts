import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { LatexVersion } from "@opencode-ai/sdk/v2/client"
import { useLatex } from "@/context/latex"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "./session-layout"
import { identity, paper, source, type LatexQuote } from "@/utils/pdf-source"

export function useLatexReading() {
  const latex = useLatex()
  const sdk = useSDK()
  const layout = useSessionLayout()
  const [state, setState] = createStore({
    versions: [] as LatexVersion[],
    selected: "",
    ready: "",
    displayed: "",
    error: "",
  })
  const document = createMemo(() => {
    const path = layout.reading().pdfPath()
    const item = path ? source(path) : undefined
    return layout.reading().active() && item?.kind === "latex" ? item : undefined
  })
  const key = createMemo(() => {
    const item = document()
    return item ? identity(sdk.url, sdk.directory, item.root, item.main) : undefined
  })
  let shown = -1
  createEffect(() => {
    const request = latex.state.preview
    const pdf = latex.pdf()
    if (!pdf || request === shown) return
    shown = request
    layout.reading().open(paper(pdf.root, pdf.build.main), pdf.title)
  })

  let serial = 0
  const refresh = async () => {
    const item = document()
    if (!item) return
    const version = ++serial
    const scope = key()
    const result = await sdk.client.latex.versions({ root: item.root }, { throwOnError: true }).then(
      (value) => ({ data: value.data }),
      (error: unknown) => ({ error: String(error) }),
    )
    if (version !== serial || key() !== scope) return
    if ("error" in result) {
      setState("error", result.error)
      return
    }
    setState(
      "versions",
      (result.data ?? [])
        .filter((entry) => entry.build.main === item.main)
        .sort((a, b) => b.build.createdAt - a.build.createdAt),
    )
    setState("error", "")
  }
  createEffect(
    on(key, () => {
      serial++
      setState({ versions: [], selected: "", ready: "", displayed: "", error: "" })
      void refresh()
    }),
  )
  createEffect(
    on(
      () => latex.pdf()?.build.id,
      () => void refresh(),
      { defer: true },
    ),
  )
  createEffect(() => {
    if (!key()) return
    const timer = setInterval(() => {
      if (!globalThis.document.hidden) void refresh()
    }, 15_000)
    onCleanup(() => clearInterval(timer))
  })
  const target = createMemo(() => state.selected || state.versions[0]?.build.id)
  createEffect(() => {
    const id = target()
    if (!id) return
    let disposed = false
    let token: string | undefined
    const client = sdk.client
    const renew = async () => {
      const result = await client.latex.lease({ id, token }, { throwOnError: true }).catch((error: unknown) => {
        if (!disposed) setState("error", String(error))
      })
      if (!result?.data) return
      token = result.data.token
      if (disposed) {
        void client.latex.release({ id, token }).catch(() => undefined)
        return
      }
      setState("ready", id)
    }
    void renew()
    const timer = setInterval(() => void renew(), 30_000)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      if (token) void client.latex.release({ id, token }).catch(() => undefined)
    })
  })
  // The displayed PDF remains protected while its replacement loads or waits for a selection.
  createEffect(() => {
    const id = state.displayed
    if (!id) return
    let disposed = false
    let token: string | undefined
    const client = sdk.client
    const renew = async () => {
      const result = await client.latex.lease({ id, token }, { throwOnError: true }).catch(() => undefined)
      if (!result?.data) return
      token = result.data.token
      if (disposed) void client.latex.release({ id, token }).catch(() => undefined)
    }
    void renew()
    const timer = setInterval(() => void renew(), 30_000)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      if (token) void client.latex.release({ id, token }).catch(() => undefined)
    })
  })
  onCleanup(() => serial++)

  const capture = (version?: string): LatexQuote | undefined => {
    const item = document()
    const entry = state.versions.find((value) => value.build.id === (version ?? state.displayed))
    if (!item || !entry) return
    return { root: item.root, main: item.main, build: entry.build.id, hash: entry.pdfHash }
  }
  return {
    state,
    document,
    key,
    refresh,
    target,
    capture,
    select: (id: string) => setState("selected", id),
    displayed: (id: string) => setState("displayed", id),
    url: () =>
      state.ready
        ? `${sdk.url}/latex/build/${encodeURIComponent(state.ready)}/pdf?directory=${encodeURIComponent(sdk.directory)}`
        : "",
    outdated: () => {
      const item = document()
      return (
        (!!state.displayed && !!state.versions[0] && state.displayed !== state.versions[0].build.id) ||
        (item?.root === latex.state.project?.root &&
          item?.main === latex.state.project?.binding?.main &&
          latex.outdated())
      )
    },
    reference: async (quote: LatexQuote) => {
      await sdk.client.latex.reference({ id: quote.build, reference: crypto.randomUUID() }, { throwOnError: true })
    },
  }
}
