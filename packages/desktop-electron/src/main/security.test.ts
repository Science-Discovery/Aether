import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { appCheck, assertDir, blob, external } from "./security"

describe("external link allowlist", () => {
  test("passes http and https through", () => {
    expect(external("https://aether.aiphys.cn/")).toBe("https://aether.aiphys.cn/")
    expect(external("http://localhost:4096/session")).toBe("http://localhost:4096/session")
    expect(external("HTTPS://EXAMPLE.COM/PATH")).toBe("https://example.com/PATH")
    expect(external("https://[::1]:9999/x")).toBeTruthy()
  })

  test("rejects dangerous schemes", () => {
    expect(external("javascript:alert(1)")).toBeNull()
    expect(external("vbscript:msgbox")).toBeNull()
    expect(external("file:///C:/Windows/System32/calc.exe")).toBeNull()
    expect(external("data:text/html,<script>alert(1)</script>")).toBeNull()
    expect(external("chrome://settings")).toBeNull()
    expect(external("ftp://example.com/file")).toBeNull()
    expect(external("mailto:user@example.com")).toBeNull()
  })

  test("rejects malformed and hostile inputs", () => {
    expect(external("")).toBeNull()
    expect(external("not a url")).toBeNull()
    expect(external("//example.com")).toBeNull()
    expect(external({} as unknown as string)).toBeNull()
    expect(external(undefined as unknown as string)).toBeNull()
    expect(external(42 as unknown as string)).toBeNull()
  })
})

describe("app url check", () => {
  const renderer = mkdtempSync(join(tmpdir(), "aether-security-"))
  const rendererDir = join(renderer, "renderer")

  test("dev mode allows only the dev server origin", () => {
    const check = appCheck("http://localhost:5173", rendererDir)
    expect(check("http://localhost:5173/")).toBe(true)
    expect(check("http://localhost:5173/deep/path?query=1#hash")).toBe(true)
    expect(check("http://localhost:5173")).toBe(true)
    expect(check("http://127.0.0.1:5173/")).toBe(false)
    expect(check("http://localhost:5174/")).toBe(false)
    expect(check("https://localhost:5173/")).toBe(false)
    expect(check("http://localhost:5173.evil.com/")).toBe(false)
    expect(check("http://evil.com/")).toBe(false)
    expect(check(pathToFileURL(join(rendererDir, "index.html")).href)).toBe(false)
    expect(check("javascript:alert(1)")).toBe(false)
    expect(check("")).toBe(false)
  })

  test("dev mode with malformed dev url allows nothing", () => {
    const check = appCheck("not-a-url", rendererDir)
    expect(check("http://localhost:5173/")).toBe(false)
    expect(check("file:///anything")).toBe(false)
  })

  test("prod mode allows only files under the renderer directory", () => {
    const check = appCheck(undefined, rendererDir)
    expect(check(pathToFileURL(rendererDir).href)).toBe(true)
    expect(check(pathToFileURL(join(rendererDir, "index.html")).href)).toBe(true)
    expect(check(pathToFileURL(join(rendererDir, "assets", "app.js")).href)).toBe(true)
    expect(check(pathToFileURL(join(rendererDir, "..", "index.html")).href)).toBe(false)
    expect(check(pathToFileURL(join(rendererDir, "..", "renderer-evil", "x.html")).href)).toBe(false)
    expect(check(pathToFileURL(join(tmpdir(), "elsewhere", "x.html")).href)).toBe(false)
    expect(check(`${pathToFileURL(rendererDir).href}/%2e%2e/evil.html`)).toBe(false)
    expect(check("https://example.com/")).toBe(false)
    expect(check("javascript:alert(1)")).toBe(false)
    expect(check("")).toBe(false)
    expect(check("file://not-a-valid-url")).toBe(false)
  })

  test("prod mode uses normalized url parsing, not raw string prefixes", () => {
    const check = appCheck(undefined, rendererDir)
    const siblingPrefix = pathToFileURL(`${rendererDir}-evil`).href
    expect(check(siblingPrefix)).toBe(false)
    const encodedChild = `${pathToFileURL(rendererDir).href}/%2e%2e/%2e%2e/secret`
    expect(check(encodedChild)).toBe(false)
  })
})

describe("blob url detection", () => {
  test("accepts blob urls only", () => {
    expect(blob("blob:http://localhost:5173/0c1a-4e1f")).toBe(true)
    expect(blob("blob:file:///d41d8cd9-8f00")).toBe(true)
    expect(blob("https://example.com/x")).toBe(false)
    expect(blob("file:///C:/x.pdf")).toBe(false)
    expect(blob("javascript:alert(1)")).toBe(false)
    expect(blob("")).toBe(false)
    expect(blob("no-scheme")).toBe(false)
  })
})

describe("open-path directory guard", () => {
  const root = mkdtempSync(join(tmpdir(), "aether-openpath-"))
  const dir = join(root, "workspace")
  const file = join(root, "notes.txt")

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, "hello")

  test("accepts an existing directory", async () => {
    await assertDir(dir)
    await assertDir(root)
  })

  test("rejects files that shell.openPath would execute", async () => {
    expect(assertDir(file)).rejects.toThrow("directories")
  })

  test("rejects missing paths", async () => {
    expect(assertDir(join(root, "missing-dir"))).rejects.toThrow()
  })

  test("rejects empty and non-string inputs", async () => {
    expect(assertDir("")).rejects.toThrow("directory path")
    expect(assertDir(null)).rejects.toThrow("directory path")
    expect(assertDir(undefined)).rejects.toThrow("directory path")
    expect(assertDir(42)).rejects.toThrow("directory path")
    expect(assertDir({})).rejects.toThrow("directory path")
  })
})
