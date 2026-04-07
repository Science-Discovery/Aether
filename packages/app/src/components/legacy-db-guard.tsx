import { createEffect, onCleanup } from "solid-js"
import { useServer } from "@/context/server"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { showToast } from "@opencode-ai/ui/toast"

type Status = {
  directory: string
  has_legacy: boolean
  message: string
  dismissed: boolean
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

function key(url: string) {
  return `aether.legacy.prompt.once.${url}`
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
      if (info.dismissed) return
      if (sessionStorage.getItem(key(conn.url)) === "1") return

      const open = (sessionID?: string) => {
        layout.projects.open(info.directory)
        server.projects.touch(info.directory)
        const dir = base64Encode(info.directory)
        if (!sessionID) {
          navigate(`/${dir}`)
          return
        }
        navigate(`/${dir}/session/${sessionID}`)
      }

      showToast({
        persistent: true,
        icon: "download",
        title: "侦测到旧版本的对话记录",
        description: "是否全部合并到新版本的对话中?",
        actions: [
          {
            label: "立即合并",
            onClick: async () => {
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
                .then((x) => (x.ok ? x.json() : undefined))
                .catch(() => undefined)
              if (!merge) {
                showToast({
                  variant: "error",
                  title: "数据库合并启动失败",
                  description: "请稍后重试或检查后端服务日志。",
                })
                return
              }
              sessionStorage.setItem(key(conn.url), "1")
              open((merge as Merge).sessionID)
            },
          },
          {
            label: "取消",
            onClick: () => {
              showToast({
                persistent: true,
                icon: "download",
                title: "侦测到旧版本的对话记录",
                description: "已取消，是否下次开启Aether时执行对话记录合并。",
                actions: [
                  {
                    label: "下一次提醒我",
                    onClick: () => {
                      sessionStorage.setItem(key(conn.url), "1")
                    },
                  },
                  {
                    label: "不再询问",
                    onClick: async () => {
                      await fetch(`${conn.url}/database/legacy/preference`, {
                        method: "PATCH",
                        headers: {
                          "content-type": "application/json",
                          ...head,
                        },
                        body: JSON.stringify({
                          dismissed: true,
                        }),
                        signal: abort.signal,
                      }).catch(() => undefined)
                      sessionStorage.setItem(key(conn.url), "1")
                      showToast({
                        description:
                          "已关闭，如需将对话合并到新版本请参考https://aether.aiphys.cn中的常见问题。",
                      })
                    },
                  },
                ],
              })
            },
          },
        ],
      })
    }

    void run()
  })

  return null
}
