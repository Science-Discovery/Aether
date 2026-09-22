import { DataProvider } from "@opencode-ai/ui/context"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useLocation, useNavigate, useParams, useResolvedPath } from "@solidjs/router"
import { createEffect, createMemo, createResource, onCleanup, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { SyncProvider, useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { OpenIntent } from "@/utils/open-intent"
import { formatServerError } from "@/utils/server-errors"
import { forget, fresh, known, remember } from "./directory-guard"

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const location = useLocation()
  const params = useParams()
  const navigate = useNavigate()
  const root = useResolvedPath(() => "")
  const sync = useSync()
  const server = useServer()
  const slug = createMemo(() => base64Encode(props.directory))

  createEffect(() => {
    const next = sync.data.path.directory
    if (!next || next === props.directory) return
    if (decode64(params.dir) !== props.directory) return
    const path = root()
    if (!path || !location.pathname.startsWith(`${path}/`)) return
    const suffix = location.pathname.slice(path.length)
    OpenIntent.mark(server.key, next)
    navigate(`/${base64Encode(next)}${suffix}${location.search}${location.hash}`, { replace: true })
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
  onCleanup(() => forget(server.key))

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

  const [guard, actions] = createResource(
    () => {
      const dir = resolved()
      const key = server.key
      if (!dir || !key) return
      return { dir, key }
    },
    async (input, info): Promise<{ dir: string; key: string } | undefined> => {
      if (OpenIntent.consume(input.key, input.dir)) return input
      // Session links can use a different spelling of the directory already open on this server.
      if (info.value?.key === input.key && known(input.dir, [info.value.dir])) return input
      if (fresh(input.key, input.dir)) return input
      const client = global.createClient({ throwOnError: true })
      const result = await client.project.directories()
      remember(input.key, result.data ?? [])
      if (known(input.dir, result.data ?? [])) return input
    },
  )

  const allowed = createMemo(() => {
    if (guard.state !== "ready") return false
    const value = guard()
    return !!value && value.key === server.key && known(resolved(), [value.dir])
  })

  createEffect(() => {
    const dir = resolved()
    if (!dir) return
    if (guard.state !== "ready") return
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
    <Show
      when={resolved() && allowed() ? resolved() : undefined}
      keyed
      fallback={
        <Show
          when={guard.state === "pending" || guard.state === "refreshing"}
          fallback={
            <Show when={guard.state === "errored"}>
              <div class="size-full flex items-center justify-center p-6">
                <div class="flex flex-col items-center gap-4 max-w-md text-center">
                  <div role="alert" class="flex flex-col gap-2">
                    <p class="text-16-medium text-text-strong">{language.t("common.requestFailed")}</p>
                    <p class="text-14-regular text-text-weak break-words">
                      {formatServerError(guard.error, language.t)}
                    </p>
                  </div>
                  <Button onClick={() => actions.refetch()}>{language.t("directory.retry")}</Button>
                </div>
              </div>
            </Show>
          }
        >
          <div class="size-full flex items-center justify-center p-6" aria-busy="true">
            <div class="size-6 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
          </div>
        </Show>
      }
    >
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
