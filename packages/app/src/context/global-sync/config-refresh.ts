import type { Config } from "@opencode-ai/sdk/v2/client"

export function createConfigRefresh(input: {
  active: () => boolean
  load: () => Promise<Config | undefined>
  apply: (config: Config) => void
}) {
  let version = 0
  return async () => {
    const serial = ++version
    const config = await input.load()
    if (!config || !input.active() || serial !== version) return
    input.apply(config)
  }
}
