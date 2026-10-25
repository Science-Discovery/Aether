import path from "node:path"
import { mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Global } from "@/global"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"

export namespace NativeInput {
  export type Item =
    | { type: "text"; text: string; text_elements: [] }
    | { type: "image"; url: string }
    | { type: "localImage"; path: string }

  const limit = 20 * 1024 * 1024
  const chars = 200_000

  export function directory(session: SessionID) {
    return path.join(Global.Path.data, "native-attachments", createHash("sha256").update(session).digest("hex"))
  }

  function text(value: string): Item {
    return { type: "text", text: value, text_elements: [] }
  }

  function bounded(value: string) {
    return value.length <= chars ? value : `${value.slice(0, chars)}\n[Content truncated after ${chars} characters.]`
  }

  async function pdf(bytes: Uint8Array, signal: AbortSignal) {
    const { getDocumentProxy, extractText } = await import("unpdf")
    signal.throwIfAborted()
    const doc = await getDocumentProxy(bytes, {
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    })
    const abort = () => {
      void doc.destroy().catch(() => undefined)
    }
    const timeout = setTimeout(abort, 15_000)
    signal.addEventListener("abort", abort, { once: true })
    try {
      signal.throwIfAborted()
      const result = await extractText(doc, { mergePages: false })
      signal.throwIfAborted()
      return bounded(result.text.map((page, index) => `[Page ${index + 1}]\n${page}`).join("\n\n"))
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      await doc.destroy().catch(() => undefined)
    }
  }

  export async function build(parts: MessageV2.Part[], session: SessionID, signal: AbortSignal): Promise<Item[]> {
    const result: Item[] = []
    let size = 0
    for (const part of parts) {
      signal.throwIfAborted()
      if (part.type === "text") {
        if (!part.ignored && part.text) result.push(text(part.text))
        continue
      }
      if (part.type === "agent" || part.type === "subtask") {
        throw new Error("Aether agent mentions and subtasks are not supported in a Codex native session.")
      }
      if (part.type !== "file") continue
      const name = part.filename ?? "attachment"
      const label = `Attached file ${JSON.stringify(name)}`
      if (part.source?.text.value) {
        result.push(text(`Selected context from ${JSON.stringify(name)}:\n${bounded(part.source.text.value)}`))
      }
      if (part.url.startsWith("file:")) {
        const target = fileURLToPath(part.url)
        result.push(
          part.mime.startsWith("image/")
            ? { type: "localImage", path: target }
            : text(
                `${label}: ${JSON.stringify(target)}. Use your native tools to inspect this file when needed. PDF files may require text extraction or page rendering.`,
              ),
        )
        continue
      }
      if (/^https?:\/\//i.test(part.url) && part.mime.startsWith("image/")) {
        result.push({ type: "image", url: part.url })
        continue
      }
      const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(part.url)
      if (!match)
        throw new Error(`Unsupported attachment URL for ${JSON.stringify(name)}. Attach a local file instead.`)
      if (part.url.length > limit * 1.4) throw new Error("Native attachments exceed the 20 MiB limit.")
      const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8")
      size += bytes.length
      if (size > limit) throw new Error("Native attachments exceed the 20 MiB limit.")
      if (part.mime.startsWith("text/") || ["application/json", "application/xml"].includes(part.mime)) {
        result.push(text(`${label}:\n${bounded(bytes.toString("utf8"))}`))
        continue
      }
      const dir = path.join(directory(session), createHash("sha256").update(part.id).digest("hex"))
      const extension = path.extname(name)
      const target = path.join(
        dir,
        `attachment${/^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : part.mime === "application/pdf" ? ".pdf" : ".bin"}`,
      )
      await mkdir(dir, { recursive: true })
      await Bun.write(target, bytes)
      signal.throwIfAborted()
      if (part.mime.startsWith("image/")) {
        result.push({ type: "localImage", path: target })
        continue
      }
      if (part.mime !== "application/pdf") {
        result.push(
          text(
            `${label} is saved at ${JSON.stringify(target)}. Its binary contents have not been converted to text; inspect it with your native tools if supported.`,
          ),
        )
        continue
      }
      const extracted = await pdf(new Uint8Array(bytes), signal).catch((err: unknown) => {
        signal.throwIfAborted()
        return `[PDF text extraction failed: ${err instanceof Error ? err.message : "unknown error"}. No page images were supplied.]`
      })
      result.push(
        text(
          `${label} is saved at ${JSON.stringify(target)}. The following is extracted PDF text, not page images; diagrams and scanned text may be absent.\n${extracted || "[No extractable text. Inspect or render the PDF with your native tools.]"}`,
        ),
      )
    }
    return result
  }
}
