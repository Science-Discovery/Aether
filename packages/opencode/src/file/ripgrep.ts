// Ripgrep utility functions
import path from "path"
import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { lazy } from "../util/lazy"

import { Filesystem } from "../util/filesystem"
import { Process } from "../util/process"
import { which } from "../util/which"
import { text } from "node:stream/consumers"

import { ZipReader, BlobReader, BlobWriter } from "@zip.js/zip.js"
import { Log } from "@/util/log"

export namespace Ripgrep {
  const log = Log.create({ service: "ripgrep" })
  const Stats = z.object({
    elapsed: z.object({
      secs: z.number(),
      nanos: z.number(),
      human: z.string(),
    }),
    searches: z.number(),
    searches_with_match: z.number(),
    bytes_searched: z.number(),
    bytes_printed: z.number(),
    matched_lines: z.number(),
    matches: z.number(),
  })

  const Begin = z.object({
    type: z.literal("begin"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
    }),
  })

  export const Match = z.object({
    type: z.literal("match"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
      lines: z.object({
        text: z.string(),
      }),
      line_number: z.number(),
      absolute_offset: z.number(),
      submatches: z.array(
        z.object({
          match: z.object({
            text: z.string(),
          }),
          start: z.number(),
          end: z.number(),
        }),
      ),
    }),
  })

  const BinaryMatch = z.object({
    type: z.literal("match"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
      lines: z.object({
        bytes: z.string(),
      }),
      line_number: z.number(),
      absolute_offset: z.number(),
      submatches: z.array(
        z.object({
          match: z.object({
            text: z.string(),
          }),
          start: z.number(),
          end: z.number(),
        }),
      ),
    }),
  })

  const End = z.object({
    type: z.literal("end"),
    data: z.object({
      path: z.object({
        text: z.string(),
      }),
      binary_offset: z.number().nullable(),
      stats: Stats,
    }),
  })

  const Summary = z.object({
    type: z.literal("summary"),
    data: z.object({
      elapsed_total: z.object({
        human: z.string(),
        nanos: z.number(),
        secs: z.number(),
      }),
      stats: Stats,
    }),
  })

  const Result = z.union([Begin, Match, BinaryMatch, End, Summary])

  export type Result = z.infer<typeof Result>
  export type Match = z.infer<typeof Match>
  export type MatchData = z.infer<typeof Match>["data"]
  export type Begin = z.infer<typeof Begin>
  export type End = z.infer<typeof End>
  export type Summary = z.infer<typeof Summary>
  export const Hit = Match.shape.data.omit({ path: true })
  export const Group = z.object({
    path: Match.shape.data.shape.path,
    items: Hit.array(),
  })
  export type Hit = z.infer<typeof Hit>
  export type Group = z.infer<typeof Group>

  function isTextMatch(item: Result): item is Match {
    return item.type === "match" && "text" in item.data.lines
  }

  function hit(item: MatchData): Hit {
    return {
      lines: item.lines,
      line_number: item.line_number,
      absolute_offset: item.absolute_offset,
      submatches: item.submatches,
    }
  }

  function args(input: {
    pattern: string
    include?: string[]
    exclude?: string[]
    limit?: number
    follow?: boolean
    case?: boolean
    word?: boolean
    regex?: boolean
  }, file: string) {
    const args = [file, "--json", "--hidden", "--glob=!.git/*"]
    if (input.follow) args.push("--follow")
    if (!input.case) args.push("--ignore-case")
    if (!input.regex) args.push("--fixed-strings")
    if (input.word) args.push("--word-regexp")
    for (const glob of input.include ?? []) args.push(`--glob=${glob}`)
    for (const glob of input.exclude ?? []) args.push(`--glob=!${glob.startsWith("!") ? glob.slice(1) : glob}`)
    if (input.limit) args.push(`--max-count=${input.limit}`)
    args.push("--", input.pattern)
    return args
  }

  function parse(line: string) {
    if (!line) return
    return Result.parse(JSON.parse(line))
  }

  function match(line: string) {
    const item = parse(line)
    if (!item || !isTextMatch(item)) return
    return item.data
  }

  const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": {
      platform: "aarch64-unknown-linux-gnu",
      extension: "tar.gz",
    },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  export const ExtractionFailedError = NamedError.create(
    "RipgrepExtractionFailedError",
    z.object({
      filepath: z.string(),
      stderr: z.string(),
    }),
  )

  export const UnsupportedPlatformError = NamedError.create(
    "RipgrepUnsupportedPlatformError",
    z.object({
      platform: z.string(),
    }),
  )

  export const DownloadFailedError = NamedError.create(
    "RipgrepDownloadFailedError",
    z.object({
      url: z.string(),
      status: z.number(),
    }),
  )

  export const InvalidPathError = NamedError.create(
    "RipgrepInvalidPathError",
    z.object({
      filepath: z.string(),
      reason: z.string(),
    }),
  )

  export const FailedError = NamedError.create(
    "RipgrepFailedError",
    z.object({
      filepath: z.string(),
      cwd: z.string(),
      code: z.number(),
      stderr: z.string(),
      args: z.array(z.string()),
    }),
  )

  async function verify(filepath: string) {
    const out = await Process.run([filepath, "--version"], { nothrow: true })
    if (out.code === 0) return
    throw new InvalidPathError({
      filepath,
      reason: out.stderr.toString().trim() || out.stdout.toString().trim() || `Command exited with code ${out.code}`,
    })
  }

  const state = lazy(async () => {
    const env = process.env.OPENCODE_RIPGREP_PATH
    if (env) {
      const stat = await fs.stat(env).catch(() => undefined)
      if (!stat?.isFile()) {
        throw new InvalidPathError({
          filepath: env,
          reason: "Configured ripgrep path is not a file",
        })
      }
      await verify(env)
      return { filepath: env }
    }

    const system = which("rg")
    if (system) {
      const stat = await fs.stat(system).catch(() => undefined)
      if (stat?.isFile()) {
        try {
          await verify(system)
          return { filepath: system }
        } catch (error) {
          log.warn("system rg failed validation", {
            filepath: system,
            error,
          })
        }
      } else {
        log.warn("which returned invalid rg path", { filepath: system })
      }
    }
    const filepath = path.join(Global.Path.bin, "rg" + (process.platform === "win32" ? ".exe" : ""))

    if (!(await Filesystem.exists(filepath))) {
      const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
      const config = PLATFORM[platformKey]
      if (!config) throw new UnsupportedPlatformError({ platform: platformKey })

      const version = "14.1.1"
      const filename = `ripgrep-${version}-${config.platform}.${config.extension}`
      const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${filename}`

      const response = await fetch(url)
      if (!response.ok) throw new DownloadFailedError({ url, status: response.status })

      const arrayBuffer = await response.arrayBuffer()
      const archivePath = path.join(Global.Path.bin, filename)
      await Filesystem.write(archivePath, Buffer.from(arrayBuffer))
      if (config.extension === "tar.gz") {
        const args = ["tar", "-xzf", archivePath, "--strip-components=1"]

        if (platformKey.endsWith("-darwin")) args.push("--include=*/rg")
        if (platformKey.endsWith("-linux")) args.push("--wildcards", "*/rg")

        const proc = Process.spawn(args, {
          cwd: Global.Path.bin,
          stderr: "pipe",
          stdout: "pipe",
        })
        const exit = await proc.exited
        if (exit !== 0) {
          const stderr = proc.stderr ? await text(proc.stderr) : ""
          throw new ExtractionFailedError({
            filepath,
            stderr,
          })
        }
      }
      if (config.extension === "zip") {
        const zipFileReader = new ZipReader(new BlobReader(new Blob([arrayBuffer])))
        const entries = await zipFileReader.getEntries()
        let rgEntry: any
        for (const entry of entries) {
          if (entry.filename.endsWith("rg.exe")) {
            rgEntry = entry
            break
          }
        }

        if (!rgEntry) {
          throw new ExtractionFailedError({
            filepath: archivePath,
            stderr: "rg.exe not found in zip archive",
          })
        }

        const rgBlob = await rgEntry.getData(new BlobWriter())
        if (!rgBlob) {
          throw new ExtractionFailedError({
            filepath: archivePath,
            stderr: "Failed to extract rg.exe from zip archive",
          })
        }
        await Filesystem.write(filepath, Buffer.from(await rgBlob.arrayBuffer()))
        await zipFileReader.close()
      }
      await fs.unlink(archivePath)
      if (!platformKey.endsWith("-win32")) await fs.chmod(filepath, 0o755)
    }

    await verify(filepath)

    return {
      filepath,
    }
  })

  export async function filepath() {
    const { filepath } = await state()
    return filepath
  }

  export async function* files(input: {
    cwd: string
    glob?: string[]
    hidden?: boolean
    follow?: boolean
    maxDepth?: number
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()

    const args = [await filepath(), "--files", "--glob=!.git/*"]
    if (input.follow) args.push("--follow")
    if (input.hidden !== false) args.push("--hidden")
    if (input.maxDepth !== undefined) args.push(`--max-depth=${input.maxDepth}`)
    if (input.glob) {
      for (const g of input.glob) {
        args.push(`--glob=${g}`)
      }
    }

    // Guard against invalid cwd to provide a consistent ENOENT error.
    if (!(await fs.stat(input.cwd).catch(() => undefined))?.isDirectory()) {
      throw Object.assign(new Error(`No such file or directory: '${input.cwd}'`), {
        code: "ENOENT",
        errno: -2,
        path: input.cwd,
      })
    }

    const proc = Process.spawn(args, {
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "pipe",
      abort: input.signal,
    })

    if (!proc.stdout || !proc.stderr) {
      throw new Error("Process output not available")
    }

    let buffer = ""
    const stream = proc.stdout as AsyncIterable<Buffer | string>
    for await (const chunk of stream) {
      input.signal?.throwIfAborted()

      buffer += typeof chunk === "string" ? chunk : chunk.toString()
      // Handle both Unix (\n) and Windows (\r\n) line endings
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (line) yield line
      }
    }

    if (buffer) yield buffer
    let code = 0
    let stderr = ""
    try {
      ;[code, stderr] = await Promise.all([proc.exited, text(proc.stderr)])
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error)
      code = 1
    }

    if (code !== 0) {
      throw new FailedError({
        filepath: args[0],
        cwd: input.cwd,
        code,
        stderr,
        args: args.slice(1),
      })
    }

    input.signal?.throwIfAborted()
  }

  export async function tree(input: { cwd: string; limit?: number; signal?: AbortSignal }) {
    log.info("tree", input)
    const files = await Array.fromAsync(Ripgrep.files({ cwd: input.cwd, signal: input.signal }))
    interface Node {
      name: string
      children: Map<string, Node>
    }

    function dir(node: Node, name: string) {
      const existing = node.children.get(name)
      if (existing) return existing
      const next = { name, children: new Map() }
      node.children.set(name, next)
      return next
    }

    const root: Node = { name: "", children: new Map() }
    for (const file of files) {
      if (file.includes(".opencode") || file.includes(".aether")) continue
      const parts = file.split(path.sep)
      if (parts.length < 2) continue
      let node = root
      for (const part of parts.slice(0, -1)) {
        node = dir(node, part)
      }
    }

    function count(node: Node): number {
      let total = 0
      for (const child of node.children.values()) {
        total += 1 + count(child)
      }
      return total
    }

    const total = count(root)
    const limit = input.limit ?? total
    const lines: string[] = []
    const queue: { node: Node; path: string }[] = []
    for (const child of Array.from(root.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
      queue.push({ node: child, path: child.name })
    }

    let used = 0
    for (let i = 0; i < queue.length && used < limit; i++) {
      const { node, path } = queue[i]
      lines.push(path)
      used++
      for (const child of Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
        queue.push({ node: child, path: `${path}/${child.name}` })
      }
    }

    if (total > used) lines.push(`[${total - used} truncated]`)

    return lines.join("\n")
  }

  export async function search(input: {
    cwd: string
    pattern: string
    include?: string[]
    exclude?: string[]
    limit?: number
    follow?: boolean
    case?: boolean
    word?: boolean
    regex?: boolean
    signal?: AbortSignal
  }): Promise<Group[]> {
    const out: Group[] = []
    for await (const batch of stream(input)) out.push(...batch)
    return out
  }

  export async function* stream(input: {
    cwd: string
    pattern: string
    include?: string[]
    exclude?: string[]
    limit?: number
    follow?: boolean
    case?: boolean
    word?: boolean
    regex?: boolean
    signal?: AbortSignal
    batch?: number
  }): AsyncGenerator<Group[]> {
    input.signal?.throwIfAborted()
    const file = await filepath()
    const argv = args(input, file)
    const proc = Process.spawn(argv, {
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "pipe",
      abort: input.signal,
    })
    if (!proc.stdout || !proc.stderr) throw new Error("ripgrep output not available")

    const err = text(proc.stderr).catch((error) => (error instanceof Error ? error.message : String(error)))
    let buf = ""
    let out: Group[] = []
    let grp: Group | undefined
    const size = input.batch ?? 20
    let read: unknown

    const push = () => {
      if (!grp || grp.items.length === 0) return
      out.push(grp)
      grp = undefined
    }

    try {
      for await (const chunk of proc.stdout) {
        buf += chunk.toString()
        buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""

        for (const line of lines) {
          const item = parse(line)
          if (!item) continue
          if (item.type === "begin") {
            push()
            grp = {
              path: item.data.path,
              items: [],
            }
            continue
          }
          if (item.type === "end") {
            push()
            if (out.length < size) continue
            yield out
            out = []
            continue
          }
          if (!isTextMatch(item)) continue
          grp ??= {
            path: item.data.path,
            items: [],
          }
          grp.items.push(hit(item.data))
          if (out.length < size) continue
          yield out
          out = []
        }
      }
    } catch (error) {
      read = error
    }

    if (buf.trim()) {
      const item = match(buf.trim())
      if (item) {
        grp ??= {
          path: item.path,
          items: [],
        }
        grp.items.push(hit(item))
      }
    }
    push()

    const [code, stderr] = await Promise.all([proc.exited, err])
    if (read) {
      input.signal?.throwIfAborted()
      throw read
    }

    if (code === 1) {
      if (out.length) yield out
      return
    }

    if (code === 2 && stderr.includes("No files were searched")) {
      if (out.length) yield out
      return
    }

    if (code !== 0) {
      input.signal?.throwIfAborted()
      throw new FailedError({
        filepath: argv[0],
        cwd: input.cwd,
        code,
        stderr: stderr.trim(),
        args: argv.slice(1),
      })
    }
    if (out.length) yield out
  }
}
