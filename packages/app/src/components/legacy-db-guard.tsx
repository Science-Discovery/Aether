import { createEffect, onCleanup } from "solid-js"
import { useServer } from "@/context/server"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { showToast } from "@opencode-ai/ui/toast"

type Status = {
  directory: string
  should_merge: boolean
  source_count: number
}

type Merge = {
  mode: "noop" | "copy" | "agent"
  sessionID?: string
}

type ArchiveState = {
  state: "idle" | "running" | "done" | "error"
  updated: number
  error?: string
  details?: string[]
}

const retry = [200, 400, 800, 1200, 1800, 2500]

function auth(input: { username?: string; password?: string }) {
  const head: Record<string, string> = {}
  if (!input.password) return head
  head.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  return head
}

export function LegacyDBGuard() {
  const server = useServer()
  const layout = useLayout()
  const navigate = useNavigate()
  const abort = new AbortController()
  let started = false

  const done = (stamp: number) => `aether.legacy.done.${stamp}`

  onCleanup(() => abort.abort())

  createEffect(() => {
    if (started) return
    if (!server.current) return
    if (!server.isLocal()) return
    started = true

    const run = async () => {
      const conn = server.current?.http
      if (!conn) return
      const head = auth(conn)
      const status = await (async () => {
        for (let i = 0; i <= retry.length; i++) {
          const result = await fetch(`${conn.url}/database/legacy/status`, {
            headers: head,
            signal: abort.signal,
          })
            .then((x) => (x.ok ? x.json() : undefined))
            .catch(() => undefined)
          if (result) return result as Status
          if (i === retry.length) return
          await new Promise((resolve) => setTimeout(resolve, retry[i]))
          if (abort.signal.aborted) return
        }
      })()

      const complete = async () => {
        const state = await fetch(`${conn.url}/database/legacy/merge/state`, {
          headers: head,
          signal: abort.signal,
        })
          .then((x) => (x.ok ? x.json() : undefined))
          .catch(() => undefined)
        if (!state) return false
        const next = state as ArchiveState
        if (next.state === "done") {
          if (!sessionStorage.getItem(done(next.updated))) {
            sessionStorage.setItem(done(next.updated), "1")
            showToast({
              title: "旧会话记录整合到了新版本，请重启软件",
            })
          }
          await fetch(`${conn.url}/database/legacy/merge/state/reset`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...head,
            },
            body: "{}",
            signal: abort.signal,
          }).catch(() => undefined)
          return true
        }
        if (next.state === "error") {
          showToast({
            variant: "error",
            title: "旧会话记录整合失败",
            description: next.details?.[0] || next.error || "请查看后端服务日志。",
          })
          await fetch(`${conn.url}/database/legacy/merge/state/reset`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...head,
            },
            body: "{}",
            signal: abort.signal,
          }).catch(() => undefined)
          return true
        }
        return false
      }

      if (!status?.should_merge) {
        const ready = await complete()
        if (ready) return
      }

      const merge = status?.should_merge
        ? await fetch(`${conn.url}/database/legacy/merge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...head,
        },
        body: JSON.stringify({}),
        signal: abort.signal,
      })
        .then((x) => (x.ok ? x.json() : undefined))
        .catch(() => undefined)
        : undefined
      if (status?.should_merge && !merge) {
        showToast({
          variant: "error",
          title: "数据库整合启动失败",
          description: "请查看后端服务日志。",
        })
        return
      }

      const info = merge as Merge | undefined
      if (status && info?.mode === "agent" && info.sessionID) {
        layout.projects.open(status.directory)
        server.projects.touch(status.directory)
        const dir = base64Encode(status.directory)
        navigate(`/${dir}/session/${info.sessionID}`)
      }

      while (!abort.signal.aborted) {
        const state = await fetch(`${conn.url}/database/legacy/merge/state`, {
          headers: head,
          signal: abort.signal,
        })
          .then((x) => (x.ok ? x.json() : undefined))
          .catch(() => undefined)
        if (!state) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          continue
        }
        const next = state as ArchiveState
        if (next.state === "running") {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          continue
        }
        if (next.state === "done") {
          await complete()
          return
        }
        if (next.state === "error") {
          await complete()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    void run()
  })

  return null
}
