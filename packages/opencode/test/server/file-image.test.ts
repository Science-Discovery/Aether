import { beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// Real 2 × 2 image files generated with Pillow; APNG contains two frames.
// These fixtures exercise transport and classification, not server-side decoding.
const jpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwClRRRX2x8of//Z"
const images = [
  {
    ext: "png",
    mime: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM0aHjAwMDAxAAGABI6AZQGIdGbAAAAAElFTkSuQmCC",
  },
  { ext: "jpg", mime: "image/jpeg", data: jpeg },
  { ext: "jpeg", mime: "image/jpeg", data: jpeg },
  { ext: "jpe", mime: "image/jpeg", data: jpeg },
  { ext: "JFIF", mime: "image/pjpeg", data: jpeg },
  { ext: "gif", mime: "image/gif", data: "R0lGODdhAgACAIEAADCA4AAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7" },
  {
    ext: "webp",
    mime: "image/webp",
    data: "UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+5Qr/+uA/OA/OA/ix/+fmXy374zAA",
  },
  {
    ext: "svg",
    mime: "image/svg+xml",
    data: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="#3080e0" d="M0 0h2v2H0z"/></svg>',
    ).toString("base64"),
  },
  {
    ext: "bmp",
    mime: "image/bmp",
    data: "Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAADEDgAAxA4AAAAAAAAAAAAA4IAw4IAwAADggDDggDAAAA==",
  },
  {
    ext: "ico",
    mime: "image/vnd.microsoft.icon",
    data: "AAABAAEAAgIAAAAAIABLAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAACAAAAAggCAAAA/dSacwAAABJJREFUeJxjNGh4wMDAwMQABgASOgGUBiHRmwAAAABJRU5ErkJggg==",
  },
  {
    ext: "avif",
    mime: "image/avif",
    data: "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAKQAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAgAAAAIAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAMW1kYXQSAAoIGAA2iAhoNCAyGxTHh4ZlAgggnlAAAABIWtlc1jxsxxXg//K7gA==",
  },
  {
    ext: "apng",
    mime: "image/apng",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEACgAA6FTcAAAAABJJREFUeJxjNGh4wMDAwMQABgASOgGUBiHRmwAAABpmY1RMAAAAAQAAAAIAAAACAAAAAAAAAAAAAQAKAABzJzbUAAAAFmZkQVQAAAACeJxjfNBgwMDAwMQABgATmgGUpuzIzQAAAABJRU5ErkJggg==",
  },
].map((image) => ({ ...image, file: `中文 空格 &%#/图像 ${image.ext}.${image.ext}` }))

type Reply = { status: number; headers: Record<string, string>; body: string }
const replies = new Map<string, Reply>()
const reply = (key: string) => {
  const value = replies.get(key)
  if (!value) throw new Error(`Missing image probe response: ${key}`)
  return value
}

beforeAll(async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Promise.all(
        images.map((image) => Bun.write(path.join(dir, "project", image.file), Buffer.from(image.data, "base64"))),
      )
      await Bun.write(path.join(dir, "project", "broken.png"), "this is not an image")
      await Bun.write(path.join(dir, "outside.png"), Buffer.from(images[0].data, "base64"))
      await Bun.write(
        path.join(dir, "files.json"),
        JSON.stringify([...images.map((image) => image.file), "broken.png"]),
      )
      await Bun.write(path.join(dir, "state", "cache", "aether", "version"), "21")
    },
  })
  const output = path.join(tmp.path, "results.json")
  const proc = Bun.spawn([process.execPath, "test/server/file-image.probe.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      AETHER_IMAGE_ROOT: tmp.path,
      AETHER_IMAGE_OUTPUT: output,
      OPENCODE_DB: ":memory:",
      OPENCODE_DISABLE_MOBILE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_TEST_HOME: path.join(tmp.path, "state", "home"),
      XDG_DATA_HOME: path.join(tmp.path, "state", "share"),
      XDG_CACHE_HOME: path.join(tmp.path, "state", "cache"),
      XDG_CONFIG_HOME: path.join(tmp.path, "state", "config"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
    },
    stdout: "ignore",
    stderr: "pipe",
    timeout: 25_000,
  })
  const stderr = await new Response(proc.stderr).text()
  expect(await proc.exited, stderr).toBe(0)
  const results: Record<string, Reply> = await Bun.file(output).json()
  Object.entries(results).forEach(([key, value]) => replies.set(key, value))
}, 30_000)

describe("authenticated image files", () => {
  test.each(images)("reads $ext bytes and metadata through encoded paths", (image) => {
    expect(reply(`unauthorized:${image.file}`).status).toBe(401)
    const raw = reply(`raw:${image.file}`)
    expect(raw.status).toBe(200)
    expect(raw.body).toBe(image.data)
    expect(raw.headers["content-type"]).toBe(image.mime)
    expect(raw.headers["access-control-allow-origin"]).toBe("null")
    expect(raw.headers["x-content-type-options"]).toBe("nosniff")
    expect(Number(raw.headers["content-length"])).toBe(Buffer.from(image.data, "base64").byteLength)
    const metadata = reply(`metadata:${image.file}`)
    expect(metadata.status).toBe(200)
    expect(JSON.parse(Buffer.from(metadata.body, "base64").toString())).toMatchObject({
      previewKind: "image",
      mimeType: image.mime,
      inline: false,
      range: true,
    })
  })

  test.each(images.filter((image) => /\.(jpe|jfif)$/i.test(image.file)))(
    "keeps $ext compatible with file.read",
    (image) => {
      const res = reply(`content:${image.file}`)
      expect(res.status).toBe(200)
      expect(JSON.parse(Buffer.from(res.body, "base64").toString())).toMatchObject({
        encoding: "base64",
        mimeType: "image/jpeg",
        content: image.data,
      })
    },
  )

  test("rejects invalid credentials and paths outside the project", () => {
    expect(reply("wrong-password").status).toBe(401)
    for (const key of ["traversal", "absolute"]) {
      const res = reply(key)
      expect(res.status).toBe(400)
      expect(JSON.parse(Buffer.from(res.body, "base64").toString())).toEqual({
        error: "Access denied: path escapes project directory",
      })
    }
    expect(reply("missing").status).toBe(404)
  })

  test("allows image fetch preflight and preserves SVG download isolation", () => {
    expect(reply("preflight").status).toBe(204)
    expect(reply("preflight").headers["access-control-allow-headers"]).toContain("Authorization")
    const image = images.find((image) => image.ext === "svg")!
    expect(reply(`raw:${image.file}`).headers["content-disposition"]).toContain("attachment")
  })

  test("allows blob image previews in proxied HTML without broadening other CSP directives", () => {
    const res = reply("web-policy")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("text/html")
    expect(Buffer.from(res.body, "base64").toString()).toContain("Image preview CSP probe")
    const policy = Object.fromEntries(
      res.headers["content-security-policy"].split(";").map((entry) => {
        const [name, ...values] = entry.trim().split(/\s+/)
        return [name, values]
      }),
    )
    expect(policy["img-src"]).toEqual(["'self'", "data:", "blob:", "https:"])
    expect(policy["default-src"]).toEqual(["'self'"])
    expect(policy["script-src"]).toEqual(["'self'", "'wasm-unsafe-eval'"])
    expect(policy["connect-src"]).toEqual(["'self'", "data:"])
    expect(policy["style-src"]).toEqual(["'self'", "'unsafe-inline'"])
    expect(policy["font-src"]).toEqual(["'self'", "data:"])
    expect(policy["media-src"]).toEqual(["'self'", "data:"])
  })

  test("returns corrupt image bytes unchanged for the client to reject", () => {
    const res = reply("raw:broken.png")
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("image/png")
    expect(Buffer.from(res.body, "base64").toString()).toBe("this is not an image")
  })
})
