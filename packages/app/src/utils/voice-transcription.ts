export interface TranscriptionOptions {
  serverUrl: string
  providerID: string
  modelID: string
  audioBlob: Blob
  conversationContext?: Array<{ role: string; content: string }>
  signal?: AbortSignal
  headers?: Record<string, string>
  projectID?: string
  saveAudio?: boolean
}

export interface TranscriptionResult {
  text: string
  audioPath?: string
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.split(",")[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function getAudioFormat(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav"
  if (mimeType.includes("mp3")) return "mp3"
  if (mimeType.includes("ogg")) return "ogg"
  if (mimeType.includes("mp4")) return "mp4"
  return "webm"
}

export async function transcribeAudio(options: TranscriptionOptions): Promise<TranscriptionResult> {
  const { serverUrl, providerID, modelID, audioBlob, conversationContext, signal, projectID, saveAudio } = options

  const audioBase64 = await blobToBase64(audioBlob)
  const audioFormat = getAudioFormat(audioBlob.type)

  const response = await fetch(`${serverUrl}/voice/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify({
      providerID,
      modelID,
      audioBase64,
      audioFormat,
      context: conversationContext,
      projectID,
      saveAudio,
    }),
    signal,
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Unknown error" }))
    throw new Error(data.error || `API error (${response.status})`)
  }

  const data = await response.json()
  const text = data.text?.trim()
  if (!text) throw new Error("empty")
  return { text, audioPath: data.audioPath }
}
