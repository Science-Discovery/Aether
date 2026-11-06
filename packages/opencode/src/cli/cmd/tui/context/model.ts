type Choice = { providerID: string; modelID: string }

type Model = {
  id: string
  disabled?: boolean
  capabilities?: { input?: { text?: boolean }; output?: { text?: boolean } }
  modalities?: { input: string[]; output?: string[] }
}

type Catalog = { id: string; models: Record<string, Model> }

function chat(model: Model) {
  return (
    !model.disabled &&
    (model.capabilities?.input?.text ?? model.modalities?.input.includes("text") ?? true) &&
    (model.capabilities?.output?.text ?? model.modalities?.output?.includes("text") ?? true)
  )
}

export function valid(providers: Catalog[], connected: string[], choice: Choice) {
  if (!connected.includes(choice.providerID)) return false
  const model = providers.find((provider) => provider.id === choice.providerID)?.models[choice.modelID]
  return !!model && chat(model)
}

export function select(providers: Catalog[], connected: string[], sources: (() => Choice | undefined)[]) {
  for (const source of sources) {
    const model = source()
    if (!model) continue
    if (valid(providers, connected, model)) return model
    if (model.providerID === "opencode") return undefined
  }
}

export function first(providers: Catalog[], connected: string[], defaults: Record<string, string>, ready: boolean) {
  if (!ready) return undefined
  for (const provider of providers) {
    if (!connected.includes(provider.id)) continue
    const preferred = provider.models[defaults[provider.id]]
    const model = preferred && chat(preferred) ? preferred : Object.values(provider.models).find(chat)
    if (model) return { providerID: provider.id, modelID: model.id }
  }
}
