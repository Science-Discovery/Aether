import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { Global } from "../../src/global"
import { NativeInput } from "../../src/native/input"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"

const session = SessionID.descending()
const base = () => ({ sessionID: session, messageID: MessageID.ascending(), id: PartID.ascending() })
const signal = () => new AbortController().signal

describe("native input", () => {
  test("queued inputs require content and compare complete attachment and citation content", () => {
    const input = { sessionID: session, messageID: MessageID.ascending(), text: "summary" }
    const parts = NativeInput.parts({
      ...input,
      parts: [
        { type: "text", text: "Question", metadata: { citation: { page: 1 } } },
        { type: "file", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" },
      ],
    })
    expect(NativeInput.parts({ ...input, parts })).toEqual(parts)
    expect(parts.map((part) => part.id)).toEqual(parts.map((part) => part.id).sort())
    expect(NativeInput.key(parts)).not.toBe(
      NativeInput.key(
        parts.map((part) => (part.type === "text" ? { ...part, metadata: { citation: { page: 2 } } } : part)),
      ),
    )
    expect(NativeInput.key(parts)).toBe(
      NativeInput.key(
        parts.map((part) =>
          part.type === "text"
            ? { ...part, metadata: { ...part.metadata, nativeSteer: { status: "accepted" } } }
            : part,
        ),
      ),
    )
    expect(() => NativeInput.parts({ ...input, text: "" })).toThrow("needs text or an attachment")
    expect(() => NativeInput.parts({ ...input, parts: [parts[0], parts[0]] })).toThrow("duplicate part identifiers")
  })

  test("attachments owned by separate messages cannot overwrite each other through reused part IDs", async () => {
    const part = { ...base(), type: "file" as const, mime: "image/png", url: "data:image/png;base64,b25l" }
    const first = await NativeInput.build([part], session, signal())
    const second = await NativeInput.build(
      [{ ...part, messageID: MessageID.ascending(), url: "data:image/png;base64,dHdv" }],
      session,
      signal(),
    )
    if (first[0]?.type !== "localImage" || second[0]?.type !== "localImage") throw new Error("Missing images")
    expect(first[0].path).not.toBe(second[0].path)
    expect(await Bun.file(first[0].path).text()).toBe("one")
    expect(await Bun.file(second[0].path).text()).toBe("two")
  })

  test("queue validation bounds aggregate inline bytes without creating files", () => {
    const part = {
      ...base(),
      type: "file" as const,
      mime: "image/png",
      url: `data:image/png;base64,${Buffer.alloc(11 * 1024 * 1024).toString("base64")}`,
    }
    expect(() => NativeInput.check([part, { ...part, id: PartID.ascending() }])).toThrow("20 MiB")
  })
  test("preserves synthetic research context while excluding display-only text", async () => {
    const result = await NativeInput.build(
      [
        { ...base(), type: "text", text: "Question about page 3", synthetic: true },
        { ...base(), type: "text", text: "Display duplicate", ignored: true },
      ],
      session,
      signal(),
    )
    expect(result).toEqual([{ type: "text", text: "Question about page 3", text_elements: [] }])
  })

  test("delivers images as native multimodal input", async () => {
    const url = "data:image/png;base64,aW1hZ2U="
    const result = await NativeInput.build(
      [{ ...base(), type: "file", mime: "image/png", filename: "图.png", url }],
      session,
      signal(),
    )
    expect(result[0]?.type).toBe("localImage")
    if (result[0]?.type !== "localImage") throw new Error("Missing native image")
    expect(await Bun.file(result[0].path).text()).toBe("image")
  })

  test("large uploaded images do not exceed the JSONL transport envelope", async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7)
    const result = await NativeInput.build(
      [
        {
          ...base(),
          type: "file",
          mime: "image/png",
          filename: "figure.png",
          url: `data:image/png;base64,${bytes.toString("base64")}`,
        },
      ],
      session,
      signal(),
    )
    if (result[0]?.type !== "localImage") throw new Error("Missing native image")
    expect(JSON.stringify(result).length).toBeLessThan(1000)
    expect(Buffer.from(await Bun.file(result[0].path).arrayBuffer()).equals(bytes)).toBe(true)
  })

  test("defers file reads to native permissions and retains selected context", async () => {
    const file = path.resolve("paper.pdf")
    const result = await NativeInput.build(
      [
        {
          ...base(),
          type: "file",
          mime: "application/pdf",
          filename: "论文.pdf",
          url: pathToFileURL(file).href,
          source: { type: "file", path: file, text: { value: "Selected equation", start: 0, end: 17 } },
        },
      ],
      session,
      signal(),
    )
    expect(result[0]).toMatchObject({ type: "text", text: expect.stringContaining("Selected equation") })
    expect(result[1]).toMatchObject({ type: "text", text: expect.stringContaining(JSON.stringify(file)) })
  })

  test("extracts uploaded PDF text with page provenance and no image claim", async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage().drawText("Research evidence", { font })
    const bytes = await pdf.save()
    const result = await NativeInput.build(
      [
        {
          ...base(),
          type: "file",
          mime: "application/pdf",
          filename: "论文.pdf",
          url: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`,
        },
      ],
      session,
      signal(),
    )
    const text = result[0]?.type === "text" ? result[0].text : ""
    expect(text).toContain("[Page 1]")
    expect(text).toContain("Research evidence")
    expect(text).toContain("not page images")
  })

  test("rejects legacy agent delegation and unsupported remote file fetches", async () => {
    await expect(NativeInput.build([{ ...base(), type: "agent", name: "explore" }], session, signal())).rejects.toThrow(
      "not supported",
    )
    const parts: MessageV2.Part[] = [
      { ...base(), type: "file", mime: "application/pdf", url: "http://127.0.0.1/private" },
    ]
    await expect(NativeInput.build(parts, session, signal())).rejects.toThrow("Unsupported attachment URL")
  })

  test("aborts before processing attachments", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      NativeInput.build([{ ...base(), type: "text", text: "hello" }], session, controller.signal),
    ).rejects.toThrow()
  })

  test("opaque ids cannot escape the attachment directory", async () => {
    const id = SessionID.make("ses/../../outside")
    const result = await NativeInput.build(
      [
        {
          ...base(),
          id: PartID.make("prt/../../../outside"),
          type: "file",
          mime: "application/octet-stream",
          filename: "../../CON",
          url: "data:application/octet-stream;base64,Ynl0ZXM=",
        },
      ],
      id,
      signal(),
    )
    expect(path.relative(path.join(Global.Path.data, "native-attachments"), NativeInput.directory(id))).toMatch(
      /^[a-f0-9]{64}$/,
    )
    expect(result[0]?.type === "text" && result[0].text.includes("attachment.bin")).toBe(true)
  })
})
