import { describe, expect, test } from "bun:test"
import { isChatModel, isVoiceModel, type VoiceModel } from "./voice"

const base = {
  provider: { id: "google", name: "Google" },
}

function model(input: Partial<VoiceModel>): VoiceModel {
  return {
    ...base,
    id: "model",
    name: "Model",
    ...input,
  }
}

describe("voice model classification", () => {
  test("keeps multimodal chat models selectable for chat", () => {
    const gemini = model({
      id: "gemini-3-pro-preview",
      name: "Gemini 3 Pro Preview",
      capabilities: {
        input: { audio: true },
        output: { text: true, audio: false },
      },
      modalities: {
        input: ["text", "image", "video", "audio", "pdf"],
        output: ["text"],
      },
    })

    expect(isVoiceModel(gemini)).toBe(true)
    expect(isChatModel(gemini)).toBe(true)
  })

  test("keeps audio output models out of chat", () => {
    const tts = model({
      id: "gemini-2.5-pro-preview-tts",
      name: "Gemini 2.5 Pro Preview TTS",
      capabilities: {
        input: { audio: false },
        output: { text: false, audio: true },
      },
      modalities: {
        input: ["text"],
        output: ["audio"],
      },
    })

    expect(isVoiceModel(tts)).toBe(true)
    expect(isChatModel(tts)).toBe(false)
  })

  test("keeps audio-only transcription models out of chat", () => {
    const parakeet = model({
      id: "nvidia/parakeet-tdt-0.6b-v2",
      name: "Parakeet TDT 0.6B v2",
      capabilities: {
        input: { audio: true },
        output: { text: true, audio: false },
      },
      modalities: {
        input: ["audio"],
        output: ["text"],
      },
    })

    expect(isVoiceModel(parakeet)).toBe(true)
    expect(isChatModel(parakeet)).toBe(false)
  })

  test("recognizes transcription model names without modalities", () => {
    expect(isVoiceModel(model({ id: "whisper-large-v3", name: "Whisper Large V3" }))).toBe(true)
    expect(isVoiceModel(model({ id: "qwen2.5-omni-7b", name: "Qwen Omni" }))).toBe(true)
  })
})
