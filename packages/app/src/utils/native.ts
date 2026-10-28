import type { NativeEngineInput, NativeCodexModel } from "@opencode-ai/sdk/v2"

export type NativeEngine = NativeEngineInput
export type NativePermission = NonNullable<NativeEngine["permission"]>
export type NativeMode = "default" | "plan"
export type NativeModel = NativeCodexModel

export function nativeModel(models: NativeModel[], id?: string) {
  if (id) return models.find((model) => model.id === id)
  return models.find((model) => model.default) ?? models[0]
}

export function nativeEffort(model: NativeModel | undefined, value?: string) {
  if (!model) return
  if (value && model.efforts.includes(value)) return value
  if (model.effort && model.efforts.includes(model.effort)) return model.effort
}
