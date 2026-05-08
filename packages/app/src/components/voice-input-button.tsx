import { Component, createSignal, createEffect, on, onCleanup } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useParams } from "@solidjs/router"
import { createVoiceRecorder, type VoiceRecorderState } from "@/utils/voice-recorder"
import { transcribeAudio } from "@/utils/voice-transcription"

export interface VoiceInputButtonProps {
  onTranscription: (text: string) => void
  onStateChange?: (state: VoiceRecorderState | "transcribing") => void
}

export const VoiceInputButton: Component<VoiceInputButtonProps> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const sdk = useSDK()
  const sync = useSync()
  const params = useParams()
  const recorder = createVoiceRecorder()
  const [transcribing, setTranscribing] = createSignal(false)
  let abortController: AbortController | null = null

  onCleanup(() => {
    recorder.cancel()
    abortController?.abort()
  })

  const state = (): VoiceRecorderState | "transcribing" => {
    if (transcribing()) return "transcribing"
    return recorder.state()
  }

  createEffect(on(state, (s) => props.onStateChange?.(s)))

  const tooltipText = () => {
    switch (state()) {
      case "recording":
        return language.t("prompt.action.voiceInput.recording")
      case "transcribing":
      case "processing":
        return language.t("prompt.action.voiceInput.transcribing")
      default:
        return language.t("prompt.action.voiceInput")
    }
  }

  const getConversationContext = () => {
    const sessionID = params.id
    if (!sessionID) return []
    const messages = sync.data.message[sessionID] ?? []
    return messages.slice(-10).flatMap((msg) => {
      const parts = sync.data.part[msg.id] ?? []
      const textContent = parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("")
      if (!textContent) return []
      return [{ role: msg.role, content: textContent }]
    })
  }

  const handleClick = async () => {
    if (state() === "transcribing") return

    if (state() === "recording") {
      try {
        const audioBlob = await recorder.stop()
        setTranscribing(true)

        const voiceModel = settings.voice.model()
        if (!voiceModel) {
          showToast({ title: language.t("prompt.action.voiceInput.error.noEndpoint") })
          return
        }
        const parts = voiceModel.split("/")
        const providerID = parts.length > 1 ? parts[0] : ""
        const modelID = parts.length > 1 ? parts.slice(1).join("/") : voiceModel

        if (!providerID) {
          showToast({ title: language.t("prompt.action.voiceInput.error.noEndpoint") })
          return
        }

        abortController = new AbortController()
        const text = await transcribeAudio({
          serverUrl: sdk.url,
          providerID,
          modelID,
          audioBlob,
          conversationContext: getConversationContext(),
          signal: abortController.signal,
        })

        props.onTranscription(text)
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return
        console.error("[VoiceInput] Transcription error:", e)
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === "empty") {
          showToast({ title: language.t("prompt.action.voiceInput.error.noSpeech") })
        } else {
          showToast({
            title: language.t("prompt.action.voiceInput.error.transcription"),
            description: msg,
          })
        }
      } finally {
        setTranscribing(false)
        abortController = null
      }
      return
    }

    if (!recorder.isSupported()) {
      showToast({ title: language.t("prompt.action.voiceInput.error.notSupported") })
      return
    }

    const voiceModel = settings.voice.model()
    if (!voiceModel || !voiceModel.includes("/")) {
      showToast({ title: language.t("prompt.action.voiceInput.error.noEndpoint") })
      return
    }

    try {
      await recorder.start()
    } catch (e: unknown) {
      console.error("[VoiceInput] Recorder start error:", e)
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("NotAllowedError") || msg.includes("Permission")) {
        showToast({ title: language.t("prompt.action.voiceInput.error.permission") })
      } else {
        showToast({
          title: language.t("prompt.action.voiceInput.error.notSupported"),
          description: msg,
        })
      }
    }
  }

  return (
    <Tooltip placement="top" gutter={4} value={tooltipText()}>
      <Button
        data-action="prompt-voice-input"
        variant="ghost"
        onClick={handleClick}
        classList={{
          "h-7 w-7 p-0 shrink-0 flex items-center justify-center": true,
          "text-icon-weak": state() === "idle",
          "text-red-500": state() === "recording",
          "text-icon-base opacity-60": state() === "transcribing" || state() === "processing",
        }}
        disabled={state() === "transcribing" || state() === "processing"}
        aria-label={tooltipText()}
      >
        <Icon
          name="microphone"
          class="size-4"
          classList={{
            "animate-pulse": state() === "recording",
          }}
        />
      </Button>
    </Tooltip>
  )
}
