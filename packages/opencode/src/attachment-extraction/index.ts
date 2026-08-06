import z from "zod"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Log } from "@/util/log"

export namespace AttachmentExtraction {
  const log = Log.create({ service: "attachment-extraction" })

  export const Range = z.object({
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
  })

  export const File = z.object({
    id: z.string(),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
  })

  export const Input = z.object({
    sessionID: SessionID.zod,
    model: z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    }),
    files: File.array(),
    ranges: z.record(z.string(), Range).optional(),
  })

  export const Meta = z.object({
    filename: z.string(),
    mime: z.string(),
    engine: z.literal("mineru"),
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
    characters: z.number().int().nonnegative(),
    completedAt: z.number().int(),
  })

  export const Result = z.object({
    partID: z.string(),
    text: z.string(),
    metadata: z.object({
      opencodeAttachmentExtraction: Meta,
    }),
  })

  export const Output = z.object({
    enabled: z.boolean(),
    results: Result.array(),
  })

  const cfg = async () => (await Config.get()).experimental?.attachment_text_extraction

  function base(input: string) {
    const url = new URL(input.trim().replace(/\/+$/, ""))
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("MinerU URL must use http or https")
    }
    return url.toString().replace(/\/+$/, "")
  }

  function bytes(url: string) {
    const idx = url.indexOf(",")
    if (idx === -1 || !url.startsWith("data:")) throw new Error("Attachment must be a data URL")
    const head = url.slice(0, idx)
    const body = url.slice(idx + 1)
    if (head.includes(";base64")) return Buffer.from(body, "base64")
    return Buffer.from(decodeURIComponent(body))
  }

  async function json(res: Response) {
    const body = await res.text()
    if (!res.ok) throw new Error(body || `MinerU request failed with HTTP ${res.status}`)
    if (!body) return {}
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new Error("MinerU returned an invalid JSON response")
    }
  }

  function field(input: unknown, key: string): unknown {
    if (!input || typeof input !== "object") return
    return (input as Record<string, unknown>)[key]
  }

  function status(input: unknown) {
    const value = field(input, "status") ?? field(input, "state")
    return typeof value === "string" ? value.toLowerCase() : ""
  }

  function task(input: unknown) {
    const value = field(input, "task_id") ?? field(input, "taskId") ?? field(input, "id")
    if (typeof value !== "string" || !value) throw new Error("MinerU did not return a task ID")
    return value
  }

  function endpoint(input: unknown, key: string, fallback: string) {
    const value = field(input, key)
    if (typeof value !== "string" || !value) return fallback
    return new URL(value, fallback).toString()
  }

  function markdown(input: unknown): string[] {
    if (!input || typeof input !== "object") return []
    if (Array.isArray(input)) return input.flatMap(markdown)
    return Object.entries(input).flatMap(([key, value]) => {
      const name = key.toLowerCase()
      if (["md", "markdown", "md_content", "markdown_content"].includes(name) && typeof value === "string") {
        return value.trim() ? [value] : []
      }
      return markdown(value)
    })
  }

  function select(input: { image: boolean; pdf: boolean }, files: z.infer<typeof File>[]) {
    return files.filter((file) => {
      if (file.mime === "application/pdf") return !input.pdf
      if (file.mime.startsWith("image/")) return !input.image
      return false
    })
  }

  function wait(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Attachment extraction cancelled"))
        return
      }
      const id = setTimeout(resolve, ms)
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(id)
          reject(signal.reason ?? new Error("Attachment extraction cancelled"))
        },
        { once: true },
      )
    })
  }

  export async function health(url?: string, signal?: AbortSignal) {
    const current = url ? undefined : await cfg()
    const root = base(url || current?.mineru?.base_url || "http://127.0.0.1:8000")
    const res = await fetch(`${root}/health`, { signal })
    const response = await json(res)
    if (status(response) !== "healthy") throw new Error("MinerU API is not healthy")
    return {
      base_url: root,
      response,
    }
  }

  async function convert(input: {
    root: string
    file: z.infer<typeof File>
    range?: z.infer<typeof Range>
    signal?: AbortSignal
  }) {
    const form = new FormData()
    const name = input.file.filename || (input.file.mime === "application/pdf" ? "document.pdf" : "image")
    form.append("files", new globalThis.File([bytes(input.file.url)], name, { type: input.file.mime }))
    form.append("backend", "pipeline")
    form.append("parse_method", "auto")
    form.append("return_md", "true")
    form.append("return_images", "false")
    form.append("return_middle_json", "false")
    form.append("return_model_output", "false")
    form.append("return_content_list", "false")
    form.append("response_format_zip", "false")
    form.append("formula_enable", "true")
    form.append("table_enable", "true")
    if (input.range) {
      form.append("start_page_id", String(input.range.startPage - 1))
      form.append("end_page_id", String(input.range.endPage - 1))
    }

    const submitted = await fetch(`${input.root}/tasks`, {
      method: "POST",
      body: form,
      signal: input.signal,
    }).then(json)
    const id = task(submitted)
    const stateURL = endpoint(submitted, "status_url", `${input.root}/tasks/${encodeURIComponent(id)}`)
    const resultURL = endpoint(submitted, "result_url", `${input.root}/tasks/${encodeURIComponent(id)}/result`)
    const started = Date.now()

    while (true) {
      if (Date.now() - started > 30 * 60 * 1000) throw new Error("MinerU task timed out after 30 minutes")
      const state = await fetch(stateURL, { signal: input.signal }).then(json)
      const value = status(state)
      if (["completed", "complete", "done", "success", "succeeded"].includes(value)) break
      if (["error", "failed", "failure", "cancelled", "canceled"].includes(value)) {
        const message = field(state, "message") ?? field(state, "error")
        throw new Error(typeof message === "string" ? message : `MinerU task ${value}`)
      }
      await wait(1000, input.signal)
    }

    const result = await fetch(resultURL, {
      signal: input.signal,
    }).then(json)
    const text = [...new Set(markdown(result))].join("\n\n").trim()
    if (!text) throw new Error("MinerU completed without returning Markdown")
    return text
  }

  export const Test = {
    base,
    bytes,
    markdown,
    select,
    convert,
  }

  export async function extract(input: z.infer<typeof Input>, signal?: AbortSignal) {
    const current = await cfg()
    if (!current?.enabled) return { enabled: false, results: [] } satisfies z.infer<typeof Output>

    const model = await Provider.getModel(input.model.providerID, input.model.modelID)
    const files = select(model.capabilities.input, input.files)
    if (files.length === 0) return { enabled: true, results: [] } satisfies z.infer<typeof Output>

    const root = base(current.mineru?.base_url || "http://127.0.0.1:8000")
    await health(root, signal)
    const results: z.infer<typeof Result>[] = []

    for (const [idx, file] of files.entries()) {
      await SessionStatus.set(input.sessionID, {
        type: "busy",
        phase: "attachment",
        label: file.filename || "attachment",
        progress: { current: idx + 1, total: files.length, unit: "file" },
      })
      const range = input.ranges?.[file.id]
      if (range && range.startPage > range.endPage) throw new Error("Invalid PDF page range")
      log.info("extracting attachment", { filename: file.filename, mime: file.mime, range })
      const text = await convert({ root, file, range, signal })
      results.push({
        partID: file.id,
        text,
        metadata: {
          opencodeAttachmentExtraction: {
            filename: file.filename || "attachment",
            mime: file.mime,
            engine: "mineru",
            startPage: range?.startPage,
            endPage: range?.endPage,
            characters: text.length,
            completedAt: Date.now(),
          },
        },
      })
    }

    return { enabled: true, results } satisfies z.infer<typeof Output>
  }
}
