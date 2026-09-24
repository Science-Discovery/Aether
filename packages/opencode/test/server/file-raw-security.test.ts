import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

const raw = (tmp: { path: string }, file: string, headers?: Record<string, string>) => {
  const app = Server.Default()
  return app.request(`/file/raw?path=${encodeURIComponent(file)}`, {
    headers: { "x-opencode-directory": tmp.path, ...headers },
  })
}

describe("file raw active-content isolation", () => {
  test("html serves as attachment", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "unsafe.html"), "<script>fetch('/path')</script>")
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const res = await raw(tmp, "unsafe.html")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/html")
    expect(res.headers.get("Content-Disposition")).toContain("attachment")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  test("svg serves as attachment", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const res = await raw(tmp, "pic.svg")

    expect(res.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(res.headers.get("Content-Disposition")).toContain("attachment")
  })

  test("xhtml and xml serve as attachment", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "doc.xhtml"), "<html xmlns='http://www.w3.org/1999/xhtml'/>")
        await Bun.write(path.join(dir, "data.xml"), "<root/>")
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })

    for (const file of ["doc.xhtml", "data.xml"]) {
      const res = await raw(tmp, file)
      expect(res.headers.get("Content-Disposition")).toContain("attachment")
    }
  })

  test("images and pdfs stay inline", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        await Bun.write(path.join(dir, "doc.pdf"), Buffer.from("%PDF-1.7"))
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })

    for (const file of ["img.png", "doc.pdf"]) {
      const res = await raw(tmp, file)
      expect(res.headers.get("Content-Disposition")).toBeNull()
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    }
  })

  test("range and HEAD responses keep isolation headers", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "unsafe.html"), "<h1>hi</h1>")
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })

    const ranged = await raw(tmp, "unsafe.html", { range: "bytes=0-2" })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("Content-Disposition")).toContain("attachment")

    const head = await raw(tmp, "unsafe.html", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(head.headers.get("Content-Disposition")).toContain("attachment")
  })

  test("attachment filename survives unicode", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "报告.html"), "<h1>hi</h1>")
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const res = await raw(tmp, "报告.html")

    expect(res.headers.get("Content-Disposition")).toContain(`filename*=UTF-8''%E6%8A%A5%E5%91%8A.html`)
  })

  test("invalid range still carries nosniff", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "unsafe.html"), "<h1>hi</h1>")
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const res = await raw(tmp, "unsafe.html", { range: "bytes=99-100" })

    expect(res.status).toBe(416)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })
})
