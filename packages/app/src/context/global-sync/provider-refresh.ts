import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { normalizeProviderList } from "./utils"

export type ProviderTarget = {
  key: string
  identity: object
  current: () => object | undefined
  load: () => Promise<ProviderListResponse | undefined>
  apply: (data: ProviderListResponse) => void
}

export function createProviderRefresh(input: {
  global: () => ProviderTarget
  child: (directory: string) => ProviderTarget | undefined
  list: () => string[]
  error?: (key: string, error: unknown) => void
}) {
  const gen = new Map<string, number>()

  const run = async (target: ProviderTarget | undefined) => {
    if (!target) return false
    const next = (gen.get(target.key) ?? 0) + 1
    gen.set(target.key, next)
    const data = await target.load()
    if (!data) return false
    if (gen.get(target.key) !== next) return false
    if (target.current() !== target.identity) return false
    target.apply(normalizeProviderList(data))
    return true
  }

  const all = async () => {
    const targets = [
      input.global(),
      ...input.list().flatMap((directory) => {
        const target = input.child(directory)
        return target ? [target] : []
      }),
    ]
    const results = await Promise.allSettled(targets.map(run))
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return
      input.error?.(targets[index]!.key, result.reason)
    })
  }

  return {
    all,
    global: () => run(input.global()),
    child: (directory: string) => run(input.child(directory)),
  }
}
