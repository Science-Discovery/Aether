export type ModelKey = { providerID: string; modelID: string }

function disabledModelID(model: ModelKey) {
  return `${model.providerID}/${model.modelID}`
}

function uniqueList(list: string[]) {
  return Array.from(new Set(list))
}

export function setModelsVisibilityInDisabledList(before: string[], models: ModelKey[], state: boolean) {
  const seen = new Set<string>()
  const keys = models.filter((model) => {
    const id = disabledModelID(model)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  if (keys.length === 0) return uniqueList(before)

  if (state) {
    const remove = new Set(keys.flatMap((model) => [disabledModelID(model), model.modelID]))
    return uniqueList(before.filter((item) => !remove.has(item)))
  }

  const next = uniqueList(before)
  const disabled = new Set(next)
  for (const model of keys) {
    const id = disabledModelID(model)
    if (disabled.has(id) || disabled.has(model.modelID)) continue
    next.push(id)
    disabled.add(id)
  }
  return next
}
