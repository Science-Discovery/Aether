import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Filesystem } from "@/util/filesystem"

export namespace NativeImage {
  export const Input = z.object({ sessionID: SessionID.zod, messageID: MessageID.zod, partID: PartID.zod })
  export const Info = z.object({ url: z.string(), name: z.string() }).meta({ ref: "NativeImage" })
  const limit = 16 * 1024 * 1024

  function mime(bytes: Buffer) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
    if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif"
    if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp"
    throw new Error("This Codex image is not a supported PNG, JPEG, GIF or WebP image.")
  }

  function image(bytes: Buffer, name: string) {
    if (!bytes.length || bytes.length > limit)
      throw new Error("Codex image preview requires a file smaller than 16 MiB.")
    return { url: `data:${mime(bytes)};base64,${bytes.toString("base64")}`, name }
  }

  /** Resolve a stored native image item, never a client-supplied filesystem path. */
  export async function read(input: z.infer<typeof Input>) {
    const session = await Session.get(input.sessionID)
    const directory = (value: string) => {
      const resolved = path.resolve(value)
      return process.platform === "win32" ? resolved.toLowerCase() : resolved
    }
    if (
      Instance.current.untrusted ||
      session.engine?.type !== "codex" ||
      session.projectID !== Instance.project.id ||
      directory(session.directory) !== directory(Instance.directory)
    )
      throw new Error("The Codex image is unavailable in this project.")
    const message = await MessageV2.get(input)
    const part = message.parts.find((part) => part.id === input.partID)
    if (
      message.info.role !== "assistant" ||
      part?.type !== "tool" ||
      part.state.status !== "completed" ||
      part.metadata?.native?.engine !== "codex" ||
      !["codex.imageView", "codex.imageGeneration"].includes(part.tool)
    )
      throw new Error("The completed Codex image item is unavailable.")
    const value = part.state.input
    if (part.tool === "codex.imageGeneration" && typeof value.result === "string" && value.result) {
      const encoded = value.result.replace(/^data:image\/[\w.+-]+;base64,/, "")
      if (encoded.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        throw new Error("The generated image data is invalid or too large to preview.")
      return image(Buffer.from(encoded, "base64"), "Codex image")
    }
    const location = part.tool === "codex.imageView" ? value.path : value.savedPath
    if (typeof location !== "string" || !location || location.includes("\0"))
      throw new Error("Codex did not provide a local image or inline image data.")
    const root = await fs.realpath(session.directory)
    const file = await fs.realpath(path.resolve(root, location)).catch(() => undefined)
    if (!file || !Filesystem.contains(root, file))
      throw new Error("The image must exist inside this project to preview it in Aether.")
    const handle = await fs.open(file, "r")
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > limit || !stat.size)
        throw new Error("Codex image preview requires a file smaller than 16 MiB.")
      // Read at most the limit even if the file grows after stat.
      const bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset !== stat.size) throw new Error("The image changed while it was being read. Try again.")
      return image(bytes.subarray(0, offset), path.basename(file))
    } finally {
      await handle.close()
    }
  }
}
