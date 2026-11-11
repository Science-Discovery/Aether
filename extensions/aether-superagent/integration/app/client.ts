import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useLayout } from "@/context/layout"
import { OpenIntent } from "@/utils/open-intent"

export type NativeState = {
  enabled: boolean
  installed: boolean
  workspace?: { directory: string; defaultDirectory: string }
  master?: { session: string; directory: string }
  activity?: "not_started" | "idle" | "busy" | "retry" | "unavailable"
  schedule: { enabled: boolean; minutes: number }
  outbox?: { id: string; kind: string; state: string; error?: string; ticket?: string }[]
}

/** Bind requests and navigation to the backend that mounted this view. */
export function createSuperagentClient() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const platform = usePlatform()
  const server = useServer()
  const layout = useLayout()
  const navigate = useNavigate()
  const key = server.key
  const controller = new AbortController()
  const [state, set] = createStore({ alive: true })
  const valid = () => state.alive && server.key === key && !controller.signal.aborted
  createEffect(() => { if (server.key !== key) { set("alive", false); controller.abort() } })
  onCleanup(() => { set("alive", false); controller.abort() })
  return {
    valid,
    async request<T>(route: string, body?: object): Promise<T> {
      if (!valid()) throw new Error("Aether 后端已切换，请重新打开此页面。")
      // The requests bridge is also available in already-running Aether backends.
      const tunnel = route.startsWith("/native/") && body !== undefined
      const path = tunnel ? "/requests" : route
      const payload = tunnel ? { native: { path: route, body } } : body
      const response = await (platform.fetch ?? fetch)(new URL(`superagent${path}`, `${sdk.url.replace(/\/+$/, "")}/`), {
        method: body ? "POST" : "GET", headers: { ...sdk.auth(), "Content-Type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      })
      const result = await response.json()
      if (!valid()) throw new Error("页面已关闭或后端已切换。")
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
      return result as T
    },
    async open(target: { directory: string; session: string }, master = false) {
      // The composer persists its initial selection. Load the workspace's agent
      // order before mounting it for the first time in a coordinator session.
      if (!valid()) return
      if (master) {
        await sync.project.loadActiveMetadata(target.directory)
        if (!valid()) return
        const [metadata] = sync.peek(target.directory, { bootstrap: false })
        if (!metadata.modelReady || !metadata.agent.some((agent) => agent.name === "superagent"))
          throw new Error("未能加载主控角色，请重试打开主控会话。")
      }
      layout.projects.open(target.directory)
      OpenIntent.mark(key, target.directory)
      navigate(`/${base64Encode(target.directory)}/session/${target.session}`)
    },
  }
}
