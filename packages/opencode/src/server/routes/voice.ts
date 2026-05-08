import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderID } from "../../provider/schema"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"

const log = Log.create({ service: "voice" })

export const VoiceRoutes = lazy(() =>
  new Hono().post(
    "/transcribe",
    validator(
      "json",
      z.object({
        providerID: ProviderID.zod,
        modelID: z.string(),
        audioBase64: z.string(),
        audioFormat: z.string(),
        context: z
          .array(z.object({ role: z.string(), content: z.string() }))
          .optional(),
      }),
    ),
    async (c) => {
      const { providerID, modelID, audioBase64, audioFormat, context } =
        c.req.valid("json")

      const provider = await Provider.getProvider(providerID)
      if (!provider) return c.json({ error: "Provider not found" }, 404)

      const modelsDevProviders = await ModelsDev.get()
      const modelsDevProvider = modelsDevProviders[providerID]

      const baseURL =
        (typeof provider.options["baseURL"] === "string" && provider.options["baseURL"]) ||
        (typeof provider.options["endpoint"] === "string" && provider.options["endpoint"]) ||
        modelsDevProvider?.api
      if (!baseURL) return c.json({ error: "Provider has no base URL" }, 400)

      const apiKey = (provider.options["apiKey"] as string) ?? provider.key
      if (!apiKey) return c.json({ error: "Provider has no API key" }, 400)

      let endpoint = baseURL.replace(/\/+$/, "")
      if (!endpoint.endsWith("/chat/completions"))
        endpoint += "/chat/completions"

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

      if (context && context.length > 0) {
        messages.push({
          role: "system",
          content:
            "Conversation context for reference (use this to correct technical terms):\n" +
            context.map((m) => `${m.role}: ${m.content}`).join("\n"),
        })
      }

      messages.push({
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: `data:audio/${audioFormat};base64,${audioBase64}`,
              format: audioFormat,
            },
          },
          {
            type: "text",
            text: "转录这段音频，去除语气词和口头禅，输出整理后的干净文本。",
          },
        ],
      })

      log.info("voice transcribe", { providerID, modelID, endpoint })

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelID,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          modalities: ["text"],
        }),
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "Unknown error")
        log.error("voice transcribe failed", { status: resp.status, error: errText })
        return c.json({ error: errText }, resp.status as any)
      }

      let text = ""
      const reader = resp.body?.getReader()
      if (!reader) return c.json({ error: "No response body" }, 500)

      const decoder = new TextDecoder()
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
          } catch (e) {
            log.debug("SSE chunk parse error", { error: String(e), payload })
          }
        }
      }

      return c.json({ text: text.trim() })
    },
  ),
)
