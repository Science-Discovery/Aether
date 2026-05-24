import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

export const popularProviders = [
  "tatu-maas",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "alibaba-cn",
  "alibaba-coding-plan-cn",
  "deepseek",
  "moonshotai-cn",
  "moonshot-cn",
  "zhipuai",
  "zhipuai-coding-plan",
  "minimax-cn",
  "minimax-cn-coding-plan",
  "tencent-coding-plan",
  "siliconflow-cn",
  "baidu",
  "qianfan",
  "ernie",
  "baidu-qianfan",
  "opencode",
  "opencode-go",
  "anthropic",
  "openai",
  "github-copilot",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

export function rank(id: string) {
  const index = popularProviders.indexOf(id)
  return index >= 0 ? index : popularProviders.length
}

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider.all.length > 0) return projectStore.provider
    }
    return globalSync.data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () => providers().all.filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => connected.has(p.id))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter(
        (p) => connected.has(p.id) && (p.id !== "opencode" || Object.values(p.models).some((m) => m.cost?.input)),
      )
    },
  }
}
