import { describe, expect, test } from "bun:test"
import { join, dirname, resolve } from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(dir, "../..")
const appPublic = resolve(root, "../app/public")

const html = async (name: string) => Bun.file(join(dir, name)).text()
const publicAsset = async (name: string) => Bun.file(join(appPublic, name)).text()

/**
 * Electron loads renderer HTML via `win.loadFile()` which uses the `file://`
 * protocol. Absolute paths like `src="/foo.js"` resolve to the filesystem root
 * (e.g. `file:///C:/foo.js` on Windows) instead of relative to the app bundle.
 *
 * All local resource references must use relative paths (`./`).
 */
describe("electron renderer html", () => {
  for (const name of ["index.html", "loading.html"]) {
    describe(name, () => {
      test("script src attributes use relative paths", async () => {
        const content = await html(name)
        const srcs = [...content.matchAll(/\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
        for (const src of srcs) {
          expect(src).not.toMatch(/^\/[^/]/)
        }
      })

      test("link href attributes use relative paths", async () => {
        const content = await html(name)
        const hrefs = [...content.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1])
        for (const href of hrefs) {
          expect(href).not.toMatch(/^\/[^/]/)
        }
      })

      test("no web manifest link (not applicable in Electron)", async () => {
        const content = await html(name)
        expect(content).not.toContain('rel="manifest"')
      })
    })
  }
})

/**
 * Vite resolves `publicDir` relative to `root`, not the config file.
 * This test reads the actual values from electron.vite.config.ts to catch
 * regressions where the publicDir path no longer resolves correctly
 * after the renderer root is accounted for.
 */
describe("electron vite publicDir", () => {
  test("configured publicDir resolves to a directory with oc-theme-preload.js", async () => {
    const config = await Bun.file(join(root, "electron.vite.config.ts")).text()
    const pub = config.match(/publicDir:\s*["']([^"']+)["']/)
    const rendererRoot = config.match(/root:\s*["']([^"']+)["']/)
    expect(pub).not.toBeNull()
    expect(rendererRoot).not.toBeNull()
    const resolved = resolve(root, rendererRoot![1], pub![1])
    expect(existsSync(resolved)).toBe(true)
    expect(existsSync(join(resolved, "oc-theme-preload.js"))).toBe(true)
  })
})

describe("pdf viewer public assets", () => {
  test("pdf-viewer.html uses relative local resource paths", async () => {
    const content = await publicAsset("pdf-viewer.html")
    const srcs = [...content.matchAll(/\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
    const hrefs = [...content.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1])

    for (const src of srcs) {
      expect(src).not.toMatch(/^\/[^/]/)
    }
    for (const href of hrefs) {
      expect(href).not.toMatch(/^\/[^/]/)
    }
  })

  test("pdf-viewer-aether.js does not use root-relative pdfjs paths", async () => {
    const content = await publicAsset("pdf-viewer-aether.js")
    expect(content).not.toContain('"/pdfjs-ref/')
    expect(content).not.toContain("'/pdfjs-ref/")
  })

  test("pdf-viewer-aether.css does not use root-relative asset paths", async () => {
    const content = await publicAsset("pdf-viewer-aether.css")
    expect(content).not.toContain('url("/pdfjs-ref/')
    expect(content).not.toContain("url('/pdfjs-ref/")
  })
})
