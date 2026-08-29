import { DataProvider } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { SyncProvider, useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { OpenIntent } from "@/utils/open-intent"
import { known } from "./directory-guard"

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const location = useLocation()
  const navigate = useNavigate()
  const sync = useSync()
  const slug = createMemo(() => base64Encode(props.directory))

  createEffect(() => {
    const next = sync.data.path.directory
    if (!next || next === props.directory) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) => navigate(`/${slug()}/session/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/${slug()}/session/${sessionID}`}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  const global = useGlobalSDK()
  const server = useServer()
  let invalid = ""
  let blocked = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  createEffect(() => {
    const dir = resolved()
    if (!dir) return
    if (/aether[/\\]aether_\d+\.\d+\.\d+\.\d+/i.test(dir)) {
      navigate("/", { replace: true })
    }
  })

  const [guard] = createResource(
    () => {
      const dir = resolved()
      const key = server.key
      if (!dir || !key) return
      return { dir, key }
    },
    async (input) => {
      if (OpenIntent.consume(input.key, input.dir)) return "pass"
      const client = global.createClient({ throwOnError: true })
      const result = await client.project.directories()
      if (known(input.dir, result.data ?? [])) return "pass"
      return "block"
    },
  )

  const allowed = createMemo(() => guard.state === "ready" && guard() === "pass")

  createEffect(() => {
    const dir = resolved()
    if (!dir) return
    const state = guard.state
    if (state !== "ready" && state !== "errored") return
    if (allowed()) return
    const id = `${server.key}\n${dir}`
    if (blocked === id) return
    blocked = id
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved() && allowed() ? resolved() : undefined} keyed>
      {(resolved) => (
        <SDKProvider directory={() => resolved}>
          <SyncProvider>
            <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
