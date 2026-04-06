import { createEffect, onCleanup } from "solid-js"
import { useServer } from "@/context/server"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"

type Status = {
  directory: string
  has_legacy: boolean
  message: string
  legacy_count: number
}

type Merge = {
  sessionID?: string
}

const retry_delays = [200, 400, 800, 1200, 1800, 2500]

function auth(input: { url: string; username?: string; password?: string }) {
  const head: Record<string, string> = {}
  if (!input.password) return head
  head.Authorization = `Basic ${btoa(`${input.username ?? "opencode"}:${input.password}`)}`
  return head
}

function key(url: string, count: number) {
  return `aether.legacy.prompt.${url}.${count}`
}

export function LegacyDBGuard() {
  const server = useServer()
  const layout = useLayout()
  const navigate = useNavigate()
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
      const status = await (async () => {
        for (let i = 0; i <= retry_delays.length; i++) {
          const result = await fetch(`${conn.url}/database/legacy/status`, {
            headers: head,
            signal: abort.signal,
          })
            .then((x) => (x.ok ? x.json() : undefined))
            .catch(() => undefined)
          if (result) return result
          if (i === retry_delays.length) return
          await new Promise((resolve) => setTimeout(resolve, retry_delays[i]))
          if (abort.signal.aborted) return
        }
      })()
      if (!status) return
      const info = status as Status
      if (!info.has_legacy) return
      if (localStorage.getItem(key(conn.url, info.legacy_count)) === "1") return

      const yes = confirm("侦测到旧版本的数据文件，是否合并到新版本")
      localStorage.setItem(key(conn.url, info.legacy_count), "1")
      if (!yes) return

      const merge = await fetch(`${conn.url}/database/legacy/merge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...head,
        },
        body: JSON.stringify({
          mode: "auto",
          session: true,
        }),
        signal: abort.signal,
      })
        .then((x) => x.json())
        .catch(() => undefined)
      if (!merge) return
      const sessionID = (merge as Merge).sessionID
      layout.projects.open(info.directory)
      server.projects.touch(info.directory)
      const dir = base64Encode(info.directory)
      if (!sessionID) {
        navigate(`/${dir}`)
        return
      }
      navigate(`/${dir}/session/${sessionID}`)
    }

    void run()
  })

  return null
}
