import { createSignal } from "solid-js"

export type VoiceRecorderState = "idle" | "recording" | "processing"

function getSupportedMimeType(): string {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return "audio/webm"
}

export function createVoiceRecorder() {
  const [state, setState] = createSignal<VoiceRecorderState>("idle")
  let mediaRecorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []

  function isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
  }

  async function start(): Promise<void> {
    if (state() !== "idle") return

    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    chunks = []

    const mimeType = getSupportedMimeType()
    mediaRecorder = new MediaRecorder(stream, { mimeType })

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    mediaRecorder.start()
    setState("recording")
  }

  function stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder || state() !== "recording") {
        reject(new Error("Not recording"))
        return
      }

      setState("processing")

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mediaRecorder!.mimeType })
        cleanup()
        resolve(blob)
      }

      mediaRecorder.onerror = () => {
        cleanup()
        reject(new Error("Recording error"))
      }

      mediaRecorder.stop()
    })
  }

  function cancel(): void {
    if (mediaRecorder && state() === "recording") {
      mediaRecorder.stop()
    }
    cleanup()
  }

  function cleanup(): void {
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    mediaRecorder = null
    chunks = []
    setState("idle")
  }

  return { state, start, stop, cancel, isSupported }
}
