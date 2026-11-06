import { Acp } from "./acp"
import { Claude } from "./claude"
import { list } from "./discover"
import { Engine } from "./schema"

export namespace Engines {
  let cache: { at: number; ttl: number; value: Engine.Status[] } | undefined
  let pending: Promise<Engine.Status[]> | undefined
  const configs = new Map<string, { at: number; value: { models?: Engine.Model[]; config?: Engine.Config[]; error?: string } }>()

  export function status(refresh = false): Promise<Engine.Status[]> {
    if (!refresh && cache && Date.now() - cache.at < cache.ttl) return Promise.resolve(cache.value)
    if (pending) return pending
    pending = Promise.all(
      list().map((def) => (def.protocol === "claude" ? Claude.probe() : Acp.probe(def.id))),
    )
      .then((value) => {
        cache = { at: Date.now(), ttl: value.some((item) => item.error) ? 30_000 : 300_000, value }
        return value
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  export async function inspect(id: Engine.ID, model?: string) {
    const key = `${id}\n${model ?? ""}`
    const known = configs.get(key)
    if (known && Date.now() - known.at < 600_000) return known.value
    const value = id === "claude" ? await Claude.inspect() : await Acp.inspect(id, model)
    if (!("error" in value && value.error)) configs.set(key, { at: Date.now(), value })
    return value
  }
}
