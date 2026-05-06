export interface TranscriptionOptions {
  endpoint: string
  apiKey?: string
  model: string
  audioBlob: Blob
  conversationContext?: Array<{ role: string; content: string }>
  signal?: AbortSignal
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

export async function transcribeAudio(options: TranscriptionOptions): Promise<string> {
  const { endpoint, apiKey, model, audioBlob, conversationContext, signal } = options

  const base64Audio = await blobToBase64(audioBlob)
  const audioFormat = getAudioFormat(audioBlob.type)

  const messages: Array<{ role: string; content: unknown }> = [
    {
      role: "system",
      content:
        "You are a speech-to-text transcription assistant. Transcribe the audio and clean up the result: " +
        "remove filler words (um, uh, 嗯, 啊, 那个, 就是, 然后, etc.), false starts, and repetitions. " +
        "Use the conversation context to correct technical terms and domain-specific vocabulary. " +
        "Output ONLY the clean transcribed text. No explanations, no quotes, no prefixes.",
    },
  ]

  if (conversationContext && conversationContext.length > 0) {
    messages.push({
      role: "system",
      content:
        "Conversation context for reference (use this to correct technical terms):\n" +
        conversationContext.map((m) => `${m.role}: ${m.content}`).join("\n"),
    })
  }

  messages.push({
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: {
          data: `data:;base64,${base64Audio}`,
          format: audioFormat,
        },
      },
      {
        type: "text",
        text: "转录这段音频，去除语气词和口头禅，输出整理后的干净文本。",
      },
    ],
  })

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  let url = endpoint
  if (!url.endsWith("/chat/completions")) {
    url = url.replace(/\/+$/, "") + "/chat/completions"
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      modalities: ["text"],
    }),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`Transcription API error (${response.status}): ${errorText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error("No response body")

  const decoder = new TextDecoder()
  let text = ""
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (payload === "[DONE]") continue

      try {
        const chunk = JSON.parse(payload)
        const content = chunk.choices?.[0]?.delta?.content
        if (content) text += content
      } catch {
        // skip malformed chunks
      }
    }
  }

  const result = text.trim()
  if (!result) throw new Error("empty")
  return result
}
