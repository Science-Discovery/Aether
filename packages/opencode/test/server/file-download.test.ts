import { describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

describe("file endpoints", () => {
  test("serves uploaded-style unicode filenames without 500", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "测试.txt"), "hello")
      },
    })

    const app = Server.Default()
    const res = await app.request(`/file/download?path=${encodeURIComponent("测试.txt")}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Disposition")).toContain("filename*=")
    expect(await res.text()).toBe("hello")
  })

  test("returns metadata for pdf previews", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "guide.pdf"), Buffer.from("%PDF-1.7"))
      },
    })

    const app = Server.Default()
    const res = await app.request(`/file/metadata?path=${encodeURIComponent("guide.pdf")}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      path: "guide.pdf",
      name: "guide.pdf",
      kind: "file",
      size: 8,
      mimeType: "application/pdf",
      previewKind: "pdf",
      inline: false,
      range: true,
    })
  })

  test("serves raw file ranges", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "range.txt"), "hello world")
      },
    })

    const app = Server.Default()
    const res = await app.request(`/file/raw?path=${encodeURIComponent("range.txt")}`, {
      headers: {
        "x-opencode-directory": tmp.path,
        range: "bytes=0-4",
      },
    })

    expect(res.status).toBe(206)
    expect(res.headers.get("Content-Range")).toBe("bytes 0-4/11")
    expect(res.headers.get("Accept-Ranges")).toBe("bytes")
    expect(await res.text()).toBe("hello")
  })

  test("rejects raw path traversal", async () => {
    await using tmp = await tmpdir()
    const app = Server.Default()
    const res = await app.request(`/file/raw?path=${encodeURIComponent("../../../etc/passwd")}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Access denied: path escapes project directory",
    })
  })
})
