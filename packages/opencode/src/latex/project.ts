import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { checksum } from "@opencode-ai/util/encode"
import { Instance } from "@/project/instance"
import { LatexSchema } from "./schema"

export namespace LatexProject {
  export const limit = 256 * 1024 * 1024
  export type Root = { path: string; root: string; workspace: string; owner: string; key: string }
  export type Manifest = { revision: string; files: { path: string; hash: string; size: number }[] }
  export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
  export const slash = (value: string) => value.replaceAll("\\", "/")
  const identity = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)

  export function contains(root: string, file: string) {
    const rel = path.relative(root, file)
    return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)
  }

  export async function root(input = "."): Promise<Root> {
    if (input.includes("\0")) throw new LatexSchema.Error(400, "Invalid LaTeX project path.")
    const workspace = await fs.realpath(Instance.directory)
    if (!Instance.containsPath(workspace)) throw new LatexSchema.Error(400, "The workspace is not trusted.")
    const target = path.resolve(workspace, input)
    if (!contains(workspace, target))
      throw new LatexSchema.Error(400, "The LaTeX project must be inside this workspace.")
    const resolved = await fs.realpath(target).catch(() => undefined)
    if (!resolved || !contains(workspace, resolved) || !(await fs.stat(resolved)).isDirectory())
      throw new LatexSchema.Error(400, "The LaTeX project must be an existing directory inside this workspace.")
    return {
      path: resolved,
      root: slash(path.relative(workspace, resolved)) || ".",
      workspace,
      owner: hash(`${Instance.project.id}\0${identity(workspace)}`),
      key: hash(identity(resolved)),
    }
  }

  export async function file(root: Root, input: string) {
    if (!input || input.includes("\0") || path.isAbsolute(input))
      throw new LatexSchema.Error(400, "Use a relative LaTeX file path.")
    const target = path.resolve(root.path, input)
    if (!contains(root.path, target)) throw new LatexSchema.Error(400, "The file escapes the LaTeX project.")
    const resolved = await fs.realpath(target).catch(() => undefined)
    if (!resolved || !contains(root.path, resolved) || !(await fs.stat(resolved)).isFile())
      throw new LatexSchema.Error(400, "The file must exist inside the LaTeX project.")
    return resolved
  }

  export async function main(root: Root, input: string) {
    const target = await file(root, input)
    if (path.extname(target).toLowerCase() !== ".tex")
      throw new LatexSchema.Error(400, "The main document must be a .tex file.")
    return slash(path.relative(root.path, target))
  }

  export async function head(file: string) {
    const handle = await fs.open(file, "r")
    try {
      const buffer = Buffer.alloc(16_384)
      const result = await handle.read(buffer, 0, buffer.length, 0)
      return buffer
        .subarray(0, result.bytesRead)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
    } finally {
      await handle.close()
    }
  }

  export function program(source: string) {
    const value = source
      .split(/\r?\n/)
      .slice(0, 32)
      .map((line) => line.match(/^\s*%+\s*!\s*(?:la)?tex\s+(?:ts-)?program\s*=\s*(.*?)\s*$/i)?.[1])
      .find((value) => value !== undefined)
    if (value === undefined) return
    const name = value.toLowerCase()
    if (name === "pdflatex" || name === "xelatex") return name
    throw new LatexSchema.Error(400, `Unsupported TeX program: ${value}. Choose pdfLaTeX or XeLaTeX explicitly.`)
  }

  export async function magic(root: Root, input: string) {
    const seen = new Set<string>()
    let current = await file(root, input)
    for (let count = 0; count < 8; count++) {
      if (seen.has(identity(current))) throw new LatexSchema.Error(400, "The TeX root comments form a cycle.")
      seen.add(identity(current))
      const value = (await head(current))
        .split(/\r?\n/)
        .slice(0, 32)
        .map((line) => line.match(/^\s*%+\s*!\s*(?:la)?tex\s+root\s*=\s*(.*?)\s*$/i)?.[1])
        .find((value) => value !== undefined)
      if (value === undefined) return seen.size > 1 ? slash(path.relative(root.path, current)) : undefined
      const rel = path.relative(root.path, path.resolve(path.dirname(current), value))
      current = await file(root, await main(root, rel))
    }
    throw new LatexSchema.Error(400, "Too many chained TeX root comments.")
  }

  async function entries(root: Root, signal?: AbortSignal) {
    const files: string[] = []
    let count = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      signal?.throwIfAborted()
      if (depth > 32) throw new LatexSchema.Error(413, "The LaTeX project has too many nested directories.")
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          [".git", ".hg", ".svn", ".aether", "node_modules", ".venv", "__pycache__", ".env"].includes(entry.name) ||
          entry.name.startsWith(".env.")
        )
          continue
        if (++count > 10_000)
          throw new LatexSchema.Error(
            413,
            "The LaTeX project exceeds 10,000 filesystem entries. Choose a smaller project directory.",
          )
        const target = path.join(dir, entry.name)
        if (entry.isSymbolicLink())
          throw new LatexSchema.Error(
            400,
            "LaTeX snapshots do not support symbolic links or junctions. Choose a directory containing the actual source files.",
          )
        if (entry.isDirectory()) {
          await walk(target, depth + 1)
          continue
        }
        if (!entry.isFile())
          throw new LatexSchema.Error(400, "The LaTeX project contains an unsupported filesystem entry.")
        files.push(slash(path.relative(root.path, target)))
        if (files.length > 10_000)
          throw new LatexSchema.Error(
            413,
            "The LaTeX project exceeds 10,000 files. Choose a smaller project directory.",
          )
      }
    }
    await walk(root.path, 0)
    return files.sort()
  }

  export async function candidates(root: Root, shallow = false) {
    const files = shallow
      ? (await fs.readdir(root.path, { withFileTypes: true }))
          .filter((item) => item.isFile() && item.name.toLowerCase().endsWith(".tex"))
          .map((item) => item.name)
          .sort()
      : (await entries(root)).filter((file) => file.toLowerCase().endsWith(".tex"))
    if (files.length > 500)
      throw new LatexSchema.Error(413, "Select a smaller LaTeX project directory or bind its main document explicitly.")
    const found: string[] = []
    for (const rel of files) {
      const source = (await head(await file(root, rel))).replace(/(^|[^\\])%[^\r\n]*/g, "$1")
      if (/\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(source)) found.push(rel)
    }
    return found
  }

  export async function scan(
    root: Root,
    opts: { destination?: string; editors?: string[]; signal?: AbortSignal } = {},
  ) {
    const paths = await entries(root, opts.signal)
    const files: Manifest["files"] = []
    const stamps = new Map<string, { size: number; mtimeMs: number; ctimeMs: number }>()
    const editors = new Map((opts.editors ?? []).map((file) => [slash(file), null as string | null]))
    let size = 0
    for (const rel of paths) {
      opts.signal?.throwIfAborted()
      const target = await file(root, rel)
      const before = await fs.stat(target)
      size += before.size
      if (size > limit)
        throw new LatexSchema.Error(413, "The LaTeX project exceeds 256 MiB. Choose a smaller project directory.")
      const handle = await fs.open(target, "r")
      const chunks: Buffer[] = []
      let length = 0
      try {
        while (true) {
          opts.signal?.throwIfAborted()
          const chunk = Buffer.alloc(Math.min(1024 * 1024, before.size - length + 1))
          const read = await handle.read(chunk, 0, chunk.length, null)
          if (!read.bytesRead) break
          length += read.bytesRead
          if (length > before.size)
            throw new LatexSchema.Error(409, "Source files changed while preparing the LaTeX snapshot. Try again.")
          chunks.push(chunk.subarray(0, read.bytesRead))
        }
      } finally {
        await handle.close()
      }
      const bytes = Buffer.concat(chunks, length)
      const after = await fs.stat(target)
      if (
        before.size !== bytes.length ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new LatexSchema.Error(409, "Source files changed while preparing the LaTeX snapshot. Try again.")
      files.push({ path: rel, hash: hash(bytes), size: bytes.length })
      stamps.set(target, { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs })
      const key = slash(path.relative(root.workspace, target))
      if (editors.has(key)) editors.set(key, checksum(bytes.toString("utf8")) ?? "")
      if (opts.destination) {
        const destination = path.join(opts.destination, rel)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, bytes, { flag: "wx" })
      }
    }
    if (JSON.stringify(paths) !== JSON.stringify(await entries(root, opts.signal)))
      throw new LatexSchema.Error(409, "The LaTeX project changed while preparing its snapshot. Try again.")
    for (const [file, before] of stamps) {
      opts.signal?.throwIfAborted()
      const after = await fs.stat(file)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new LatexSchema.Error(409, "The LaTeX project changed while preparing its snapshot. Try again.")
    }
    return {
      manifest: { revision: hash(JSON.stringify(files)), files },
      editors: [...editors].map(([path, checksum]) => ({ path, checksum })),
    }
  }
}
