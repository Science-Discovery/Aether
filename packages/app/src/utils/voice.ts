export type VoiceModel = {
  id: string
  name: string
  provider: { id: string; name: string }
  capabilities?: { input: { audio: boolean } }
  modalities?: { input: Array<string> }
}

export function isVoiceModel(model: VoiceModel) {
  const text = `${model.id} ${model.name}`.toLowerCase()
  return (
    model.capabilities?.input.audio ||
    model.modalities?.input.includes("audio") ||
    /\b(asr|omni|realtime|whisper)\b|speech[-_ ]?to[-_ ]?text|transcri/.test(text)
  )
}
