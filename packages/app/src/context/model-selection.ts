import type { ModelKey } from "./models-visibility"

export function resolveModelSelection(input: {
  candidates: Array<ModelKey | undefined>
  valid: (model: ModelKey) => boolean
  fallback: () => ModelKey | undefined
  ready: boolean
}) {
  if (!input.ready) return { model: undefined, unavailable: false }
  const item = input.candidates.find((model) => model && (input.valid(model) || model.providerID === "opencode"))
  if (!item) return { model: input.fallback(), unavailable: false }
  if (input.valid(item)) return { model: item, unavailable: false }
  return { model: undefined, unavailable: input.ready }
}
