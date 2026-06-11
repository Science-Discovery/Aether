export type VoiceModel = {
  id: string
  name: string
  provider: { id: string; name: string }
  capabilities?: {
    input: { text?: boolean; audio?: boolean }
    output?: { text?: boolean; audio?: boolean }
  }
  modalities?: { input: Array<string>; output?: Array<string> }
}

export function isVoiceModel(model: VoiceModel) {
  const text = `${model.id} ${model.name}`.toLowerCase()
  const input = model.capabilities?.input.audio || model.modalities?.input.includes("audio")
  const output = model.capabilities?.output?.audio || model.modalities?.output?.includes("audio")
  if (input || output) return true
  return /\b(asr|omni|realtime|whisper)\b|speech[-_ ]?to[-_ ]?text|transcri/.test(text)
}

export function isChatModel(model: VoiceModel) {
  const input = model.capabilities?.input.text ?? model.modalities?.input.includes("text") ?? true
  if (!input) return false
  if (model.capabilities?.output?.text !== undefined) return model.capabilities.output.text
  const output = model.modalities?.output
  if (output) return output.includes("text")
  return true
}
