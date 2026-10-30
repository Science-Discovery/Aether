import path from "node:path"
import fs from "node:fs/promises"
import launch from "cross-spawn"
import { StringDecoder } from "node:string_decoder"
import { Global } from "@/global"
import { which } from "@/util/which"
import { LatexSchema } from "./schema"
import { LatexProject } from "./project"
import { LatexSetup } from "./setup"

export namespace LatexCompiler {
  export class StopError extends Error {}
  export type Config = { tectonic?: { path?: string }; latexmk?: { path?: string } }
  export type Tool = { driver: "tectonic" | "latexmk"; path: string; program: "pdflatex" | "xelatex" }

  async function executable(name: "tectonic" | "latexmk", cfg: Config) {
    const value = cfg[name]?.path?.trim()
    const target = value
      ? path.resolve(value)
      : ((name === "tectonic" ? await LatexSetup.executable() : undefined) ?? which(name))
    if (!target) return
    return (await fs.stat(target).catch(() => undefined))?.isFile() ? target : undefined
  }

  export async function run(
    file: string,
    args: string[],
    opts: {
      cwd?: string
      signal?: AbortSignal
      timeout?: number
      env?: NodeJS.ProcessEnv
      update?: (log: string, truncated: boolean) => void
      stop?: (pid: number) => Promise<void>
    } = {},
  ) {
    opts.signal?.throwIfAborted()
    const child = launch(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    const done = Promise.withResolvers<number>()
    const state = {
      log: "",
      bytes: 0,
      truncated: false,
      closed: false,
      error: "",
      stopping: undefined as Promise<void> | undefined,
      deadline: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    const stop = (message: string) => {
      state.error ||= message
      if (state.stopping || state.closed || !child.pid) return
      const pid = child.pid
      state.deadline = setTimeout(
        () =>
          done.reject(
            new StopError(
              "The LaTeX process has not closed after termination. This project remains locked; stop the compiler processes before restarting Aether.",
            ),
          ),
        6_000,
      )
      state.stopping = (async () => {
        if (opts.stop) return opts.stop(pid)
        if (process.platform === "win32") {
          const killer = launch(
            path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/pid", String(pid), "/f", "/t"],
            { stdio: "ignore", windowsHide: true },
          )
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              killer.kill()
              reject(
                new StopError(
                  "The LaTeX process tree could not be confirmed stopped. This project remains locked; stop the compiler processes before restarting Aether.",
                ),
              )
            }, 5_000)
            killer.once("error", () => {
              clearTimeout(timeout)
              reject(
                new StopError(
                  "Unable to stop the LaTeX process tree. This project remains locked; stop the compiler processes before restarting Aether.",
                ),
              )
            })
            killer.once("close", (code) => {
              clearTimeout(timeout)
              if (code === 0) return resolve()
              reject(
                new StopError(
                  "Stopping the LaTeX process tree failed. This project remains locked; stop the compiler processes before restarting Aether.",
                ),
              )
            })
          })
        } else {
          const kill = (signal: NodeJS.Signals) => {
            try {
              process.kill(-pid, signal)
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return
              throw new StopError(
                "Unable to stop the LaTeX process group. This project remains locked; stop the compiler processes before restarting Aether.",
              )
            }
          }
          kill("SIGTERM")
          await Bun.sleep(200)
          kill("SIGKILL")
        }
      })()
      void state.stopping.catch((error) =>
        done.reject(
          error instanceof StopError
            ? error
            : new StopError(
                "Unable to stop the LaTeX process tree. This project remains locked; stop the compiler processes before restarting Aether.",
              ),
        ),
      )
    }
    const abort = () => stop("LaTeX compilation cancelled.")
    const timer = setTimeout(() => stop("LaTeX compilation exceeded its time limit."), opts.timeout ?? 120_000)
    const guard = setTimeout(
      () => {
        stop("LaTeX compilation did not stop in time.")
        done.reject(
          new StopError(
            "The LaTeX process has not closed after termination. This project remains locked; stop the compiler processes before restarting Aether.",
          ),
        )
      },
      (opts.timeout ?? 120_000) + 10_000,
    )
    const consume = (stream: NodeJS.ReadableStream | null) => {
      const decoder = new StringDecoder("utf8")
      stream?.on("data", (bytes: Buffer) => {
        state.bytes += bytes.length
        state.log += decoder.write(bytes)
        if (state.log.length > 256_000) {
          state.log = state.log.slice(-256_000)
          state.truncated = true
        }
        opts.update?.(state.log, state.truncated)
        if (state.bytes > 8 * 1024 * 1024) stop("LaTeX produced more than 8 MiB of console output.")
      })
    }
    consume(child.stdout)
    consume(child.stderr)
    child.once("error", () => {
      state.error = "Unable to start the configured LaTeX executable."
    })
    child.once("close", (code) => {
      state.closed = true
      done.resolve(code ?? -1)
    })
    opts.signal?.addEventListener("abort", abort, { once: true })
    if (opts.signal?.aborted) abort()
    try {
      const code = await done.promise
      await state.stopping
      return { code, log: state.log, truncated: state.truncated, error: state.error || undefined }
    } finally {
      clearTimeout(timer)
      clearTimeout(guard)
      clearTimeout(state.deadline)
      opts.signal?.removeEventListener("abort", abort)
    }
  }

  export async function status(cfg: Config) {
    const tools = await Promise.all(
      (["tectonic", "latexmk"] as const).map(async (driver) => {
        const file = await executable(driver, cfg)
        if (!file)
          return {
            driver,
            installed: false,
            ...(cfg[driver]?.path?.trim() ? { error: "The configured executable was not found." } : {}),
          }
        const result = await run(file, [driver === "tectonic" ? "--version" : "-v"], { timeout: 5_000 }).catch(
          () => undefined,
        )
        return {
          driver,
          installed: !!result && result.code === 0 && !result.error,
          path: file,
          ...(result?.code === 0 && !result.error
            ? { version: result.log.trim().split(/\r?\n/).find(Boolean)?.slice(0, 200) }
            : { error: result?.error ?? "The executable version check failed." }),
        }
      }),
    )
    return LatexSchema.Status.parse({ tools })
  }

  export async function select(binding: LatexSchema.Binding, source: string, cfg: Config): Promise<Tool> {
    const requested = binding.program === "auto" ? LatexProject.program(source) : binding.program
    const tectonic = await executable("tectonic", cfg)
    const latexmk = await executable("latexmk", cfg)
    const program = requested ?? "pdflatex"
    const engine =
      latexmk && which(program, { PATH: `${path.dirname(latexmk)}${path.delimiter}${process.env.PATH ?? ""}` })
    if (binding.driver === "latexmk" || (binding.driver === "auto" && latexmk && engine)) {
      if (!latexmk || !engine) throw new LatexSchema.Error(503, `latexmk and ${program} must both be installed.`)
      return { driver: "latexmk", path: latexmk, program }
    }
    if (requested === "pdflatex")
      throw new LatexSchema.Error(
        503,
        "This document requests pdfLaTeX. Tectonic uses XeTeX; install latexmk/pdfLaTeX or explicitly choose XeLaTeX.",
      )
    if (!tectonic)
      throw new LatexSchema.Error(
        503,
        "No compatible LaTeX compiler was found. Configure Tectonic or latexmk in settings.",
      )
    return { driver: "tectonic", path: tectonic, program: "xelatex" }
  }

  export function diagnostics(log: string, root: LatexProject.Root, source: string, main: string, files: string[]) {
    const result: LatexSchema.Diagnostic[] = []
    const seen = new Set<string>()
    const identity = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
    const known = new Map(files.map((file) => [identity(path.resolve(source, file)), file]))
    const lines = log.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^(?:error:|warning:)?\s*(.+?):(\d+):\s*(.*)$/i)
      const location = match ? path.resolve(path.dirname(path.join(source, main)), match[1]) : undefined
      const rel = location
        ? [location, ...(!path.extname(location) ? [`${location}.tex`] : [])]
            .filter((file) => LatexProject.contains(source, file))
            .map((file) => known.get(identity(file)))
            .find((file) => file !== undefined)
        : undefined
      const warning =
        /warning:|LaTeX Warning|Package .+ Warning|Missing character:|undefined references|undefined citations|Citation .+ undefined|Overfull \\[hv]box/i.test(
          line,
        )
      const error =
        /^!|^error:|LaTeX Error|Emergency stop|Fatal error/i.test(line) ||
        (!!match && !warning && (rel !== undefined || /\.(?:tex|bib|sty|cls)$/i.test(match[1])))
      if (!error && !warning) continue
      const next = lines
        .slice(index + 1, index + 5)
        .map((line) => line.match(/^l\.(\d+)\s/))
        .find(Boolean)
      const entry: LatexSchema.Diagnostic = {
        severity: error ? "error" : "warning",
        message: line.trim().slice(0, 2000),
        ...(rel ? { path: LatexProject.slash(path.relative(root.workspace, path.join(root.path, rel))) } : {}),
        ...(Number(match?.[2] ?? next?.[1]) > 0 ? { line: Number(match?.[2] ?? next?.[1]) } : {}),
      }
      const key = JSON.stringify(entry)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(entry)
      if (result.length >= 200) break
    }
    return result
  }

  export async function compile(input: {
    root: LatexProject.Root
    binding: LatexSchema.Binding
    tool: Tool
    source: string
    files: string[]
    output: string
    downloads: boolean
    signal: AbortSignal
    update: (log: string, truncated: boolean) => void
  }) {
    const file = path.join(input.source, input.binding.main)
    const name = `./${path.basename(file)}`
    const cache = path.join(Global.Path.cache, "latex", "tectonic")
    await fs.mkdir(cache, { recursive: true })
    const args =
      input.tool.driver === "tectonic"
        ? [
            "-X",
            "compile",
            "--untrusted",
            "--keep-logs",
            "--keep-intermediates",
            "--synctex",
            "--outdir",
            input.output,
            ...(!input.downloads ? ["--only-cached"] : []),
            name,
          ]
        : [
            "-norc",
            input.tool.program === "pdflatex" ? "-pdf" : "-xelatex",
            "-interaction=nonstopmode",
            "-no-shell-escape",
            "-file-line-error",
            "-synctex=1",
            `-output-directory=${input.output}`,
            name,
          ]
    const result = await run(input.tool.path, args, {
      cwd: path.dirname(file),
      signal: input.signal,
      timeout: input.downloads ? 600_000 : 120_000,
      env: {
        ...process.env,
        PATH: `${path.dirname(input.tool.path)}${path.delimiter}${process.env.PATH ?? ""}`,
        TECTONIC_UNTRUSTED_MODE: "1",
        TECTONIC_CACHE_DIR: cache,
      },
      update: input.update,
    })
    const log = path.join(input.output, `${path.parse(file).name}.log`)
    const stat = await fs.lstat(log).catch(() => undefined)
    if (stat && (stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024))
      result.error = "The compiler log is not a regular file within the 8 MiB limit."
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024) {
      const text = await fs.readFile(log, "utf8")
      const combined = `${result.log}\n${text}`
      const found = diagnostics(combined, input.root, input.source, input.binding.main, input.files)
      return {
        ...result,
        log: combined.slice(-256_000),
        truncated: result.truncated || combined.length > 256_000,
        diagnostics: found,
        pdf: path.join(input.output, `${path.parse(file).name}.pdf`),
      }
    }
    return {
      ...result,
      diagnostics: diagnostics(result.log, input.root, input.source, input.binding.main, input.files),
      pdf: path.join(input.output, `${path.parse(file).name}.pdf`),
    }
  }
}
