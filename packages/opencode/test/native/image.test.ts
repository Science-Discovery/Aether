import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { NativeImage } from "../../src/native/image"
import { NativeHistory } from "../../src/native/history"
import { NativeEvents } from "../../src/native/events"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

async function scenario(
  run: (context: {
    dir: string
    session: Session.Info
    save: (item: NativeHistory.Item) => Promise<{ message: MessageV2.Assistant; part: MessageV2.ToolPart }>
  }) => Promise<void>,
) {
  await using dir = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        const save = async (item: NativeHistory.Item) => {
          const view = NativeHistory.project(
            {
              complete: true,
              issues: [],
              thread: { id: "thread", createdAt: 1, updatedAt: 2, status: { type: "notLoaded" } },
              turns: [
                {
                  id: "turn",
                  status: "completed",
                  itemsView: "full",
                  items: [{ id: "user", type: "userMessage", content: [{ type: "text", text: "Show image" }] }, item],
                },
              ],
            },
            { sessionID: session.id, scope: session.id, cwd: dir.path },
          )
          expect(view.complete).toBe(true)
          for (const message of view.messages) {
            await Session.updateMessage(message.info)
            for (const part of message.parts) await Session.updatePart(part)
          }
          const message = view.messages.find((message) => message.info.role === "assistant")!
          return { message: message.info as MessageV2.Assistant, part: message.parts[0] as MessageV2.ToolPart }
        }
        await run({ dir: dir.path, session, save })
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
}

test("imageView history and live events preview the actual local image", async () => {
  await scenario(async ({ dir, session, save }) => {
    const file = path.join(dir, "image.png")
    await Bun.write(file, Buffer.from(png, "base64"))
    const row = await save({ id: "image", type: "imageView", path: file })
    const read = (part: MessageV2.ToolPart) =>
      NativeImage.read({ sessionID: session.id, messageID: part.messageID, partID: part.id })
    expect(await read(row.part)).toEqual({ url: `data:image/png;base64,${png}`, name: "image.png" })
    const events = NativeEvents.create(row.message)
    Object.assign(events.state, { thread: "thread", turn: "turn", active: true })
    await events.notification("item/completed", {
      threadId: "thread",
      turnId: "turn",
      item: { id: "live-image", type: "imageView", path: file },
    })
    const part = (await MessageV2.parts(row.message.id)).find(
      (part) => part.type === "tool" && part.callID === "live-image",
    ) as MessageV2.ToolPart
    expect(await read(part)).toEqual({ url: `data:image/png;base64,${png}`, name: "image.png" })
  })
})

test("generated images support inline data and saved project files", async () => {
  await scenario(async ({ dir, session, save }) => {
    const inline = await save({ id: "inline", type: "imageGeneration", status: "completed", result: png })
    expect(
      (await NativeImage.read({ sessionID: session.id, messageID: inline.message.id, partID: inline.part.id })).url,
    ).toBe(`data:image/png;base64,${png}`)
    await Bun.write(path.join(dir, "generated.webp"), Buffer.from(png, "base64"))
    const saved = await save({
      id: "saved",
      type: "imageGeneration",
      status: "completed",
      savedPath: path.join(dir, "generated.webp"),
    })
    expect(
      (await NativeImage.read({ sessionID: session.id, messageID: saved.message.id, partID: saved.part.id })).url,
    ).toBe(`data:image/png;base64,${png}`)
  })
})

test("image previews reject external paths, escaped symlinks, non-images and oversized files", async () => {
  await using outside = await tmpdir()
  await Bun.write(path.join(outside.path, "image.png"), Buffer.from(png, "base64"))
  await scenario(async ({ dir, session, save }) => {
    const reject = async (file: string, error: string) => {
      const row = await save({ id: `image-${path.basename(file)}`, type: "imageView", path: file })
      await expect(
        NativeImage.read({ sessionID: session.id, messageID: row.message.id, partID: row.part.id }),
      ).rejects.toThrow(error)
    }
    await reject(path.join(outside.path, "image.png"), "inside this project")
    await fs.symlink(outside.path, path.join(dir, "escape"), process.platform === "win32" ? "junction" : "dir")
    await reject(path.join(dir, "escape", "image.png"), "inside this project")
    await Bun.write(path.join(dir, "unsafe.png"), "<svg onload='alert(1)'></svg>")
    await reject(path.join(dir, "unsafe.png"), "not a supported")
    await Bun.write(path.join(dir, "large.png"), "")
    await fs.truncate(path.join(dir, "large.png"), 16 * 1024 * 1024 + 1)
    await reject(path.join(dir, "large.png"), "16 MiB")
  })
})

test("only completed assistant native image items in the matching session can be previewed", async () => {
  await scenario(async ({ dir, session, save }) => {
    await Bun.write(path.join(dir, "image.png"), Buffer.from(png, "base64"))
    const row = await save({ id: "image", type: "imageView", path: "image.png" })
    const other = await Session.create({ engine: { type: "codex" } })
    await expect(
      NativeImage.read({ sessionID: other.id, messageID: row.message.id, partID: row.part.id }),
    ).rejects.toThrow("NotFoundError")
    await Session.updatePart({
      ...row.part,
      state: { status: "running", input: { path: "image.png" }, time: { start: 1 } },
    })
    await expect(
      NativeImage.read({ sessionID: session.id, messageID: row.message.id, partID: row.part.id }),
    ).rejects.toThrow("completed Codex image")
  })
})
