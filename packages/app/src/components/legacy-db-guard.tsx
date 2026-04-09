import { createEffect, onCleanup } from "solid-js"
import { useServer } from "@/context/server"
import { showToast } from "@opencode-ai/ui/toast"

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
  const abort = new AbortController()
  let started = false

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

      const reset = async () => {
        await fetch(`${conn.url}/database/legacy/merge/state/reset`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...head,
          },
          body: "{}",
          signal: abort.signal,
        }).catch(() => undefined)
      }

      for (let i = 0; i <= retry.length; i++) {
        const state = await fetch(`${conn.url}/database/legacy/merge/state`, {
          headers: head,
          signal: abort.signal,
        })
          .then((x) => (x.ok ? x.json() : undefined))
          .catch(() => undefined)
        if (!state) {
          if (i === retry.length) return
          await new Promise((resolve) => setTimeout(resolve, retry[i]))
          if (abort.signal.aborted) return
          continue
        }

        const next = state as ArchiveState
        if (next.state === "done") {
          await reset()
          return
        }

        if (next.state === "error") {
          showToast({
            variant: "error",
            title: "旧会话记录复制失败",
            description: next.details?.[0] || next.error || "请查看后端服务日志。",
          })
          await reset()
          return
        }

        if (next.state !== "running") return
        const wait = retry[Math.min(i, retry.length - 1)]
        await new Promise((resolve) => setTimeout(resolve, wait))
        if (abort.signal.aborted) return
      }
    }

    void run()
  })

  return null
}
