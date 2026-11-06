import path from "node:path"
import fs from "node:fs/promises"
import launch from "cross-spawn"
import { parseEncFile, parseMapFile, type MapEntry, type1Outlines } from "./type1"

export type FontResource =
  | { kind: "file"; path: string }
  | { kind: "type1"; upem: number; glyphs: Record<number, string>; slant?: number; extend?: number }
  | { kind: "missing"; reason: string }

class Loader {
  private kpse = new Map<string, Promise<string | undefined>>()
  private mapFile: Promise<Map<string, MapEntry>> | undefined
  private fonts = new Map<string, Promise<FontResource>>()

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  font(filename?: string, name?: string): Promise<FontResource> {
    const key = `${filename ?? ""}\0${name ?? ""}`
    let value = this.fonts.get(key)
    if (!value) {
      value = this.load(filename, name)
      this.fonts.set(key, value)
    }
    return value
  }

  private async load(filename?: string, name?: string): Promise<FontResource> {
    const file = filename ? await this.locate(filename) : undefined
    if (file) {
      if (/\.(?:otf|ttf)$/i.test(file)) return { kind: "file", path: file }
      if (/\.(?:pfb|pfa)$/i.test(file)) return this.type1(file, name ? (await this.map()).get(name) : undefined)
    }
    const entry = name ? (await this.map()).get(name) : undefined
    if (!entry?.fontFile) return { kind: "missing", reason: `no outline font for ${name ?? filename ?? "font"}` }
    const target = await this.locate(entry.fontFile)
    if (!target) return { kind: "missing", reason: `font file not found: ${entry.fontFile}` }
    if (/\.(?:otf|ttf)$/i.test(target)) return { kind: "file", path: target }
    return this.type1(target, entry)
  }

  private async type1(file: string, entry: MapEntry | undefined): Promise<FontResource> {
    let encoding: string[] | undefined
    if (entry?.encFile) {
      const enc = await this.locate(entry.encFile)
      if (enc) encoding = parseEncFile(await Bun.file(enc).text())
    }
    const { upem, glyphs } = type1Outlines(new Uint8Array(await Bun.file(file).bytes()), encoding)
    return { kind: "type1", upem, glyphs, slant: entry?.slant, extend: entry?.extend }
  }

  private map(): Promise<Map<string, MapEntry>> {
    this.mapFile ??= (async () => {
      const file = await this.kpsewhich("pdftex.map")
      if (!file) return new Map()
      return parseMapFile(await Bun.file(file).text())
    })()
    return this.mapFile
  }

  private async locate(file: string) {
    if (path.isAbsolute(file)) {
      if (
        await fs
          .stat(file)
          .then((stat) => stat.isFile())
          .catch(() => false)
      )
        return file
      return this.kpsewhich(path.basename(file))
    }
    return this.kpsewhich(file)
  }

  private kpsewhich(file: string) {
    let value = this.kpse.get(file)
    if (!value) {
      value = new Promise((resolve) => {
        const child = launch("kpsewhich", [file], {
          env: this.env,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        })
        let out = ""
        const timer = setTimeout(() => child.kill(), 10_000)
        child.stdout?.on("data", (chunk: Buffer) => {
          if (out.length < 16_384) out += chunk.toString("utf8")
        })
        child.once("close", () => {
          clearTimeout(timer)
          resolve(out.split(/\r?\n/).find(Boolean) || undefined)
        })
        child.once("error", () => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
      this.kpse.set(file, value)
    }
    return value
  }
}

const loaders = new Map<string, Loader>()

export namespace RtexResources {
  export function font(id: string, env: NodeJS.ProcessEnv, filename?: string, name?: string) {
    let loader = loaders.get(id)
    if (!loader) {
      loader = new Loader(env)
      loaders.set(id, loader)
    }
    return loader.font(filename, name)
  }

  export function dispose(id: string) {
    loaders.delete(id)
  }
}
