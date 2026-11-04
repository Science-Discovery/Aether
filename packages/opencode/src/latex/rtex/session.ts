import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import launch from "cross-spawn"
import { StringDecoder } from "node:string_decoder"
import { Global } from "@/global"
import { which } from "@/util/which"
import { LatexSchema } from "../schema"
import { LatexProject } from "../project"
import { LatexRtex } from "./setup"
import { RtexResources } from "./resources"

export type RtexEvent = { event: string; [key: string]: unknown }

type Server = { path: string; texdir?: string; source: "config" | "managed" | "path" }

function expand(value: string) {
  return value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value
}

async function file(value: string | undefined) {
  if (!value) return
  const target = path.resolve(expand(value))
  return (await fs.stat(target).catch(() => undefined))?.isFile() ? target : undefined
}

async function directory(value: string | undefined) {
  if (!value) return
  const target = path.resolve(expand(value))
  return (await fs.stat(target).catch(() => undefined))?.isDirectory() ? target : undefined
}

async function server(cfg: LatexSchema.Config): Promise<Server | undefined> {
  const configured = await file(cfg.rtex?.path)
  if (cfg.rtex?.path?.trim()) {
    if (!configured) throw new LatexSchema.Error(503, "The configured rtex executable was not found.")
    return {
      path: configured,
      texdir:
        (await directory(cfg.rtex.texdir)) ??
        (await directory(path.join(path.dirname(configured), "..", "share", "rtex", "tex"))),
      source: "config",
    }
  }
  const managed = await LatexRtex.executable()
  if (managed)
    return { path: managed.path, texdir: (await directory(cfg.rtex?.texdir)) ?? managed.texdir, source: "managed" }
  const found = which("rtex")
  if (!found) return
  return {
    path: found,
    texdir:
      (await directory(cfg.rtex?.texdir)) ??
      (await directory(path.join(path.dirname(found), "..", "share", "rtex", "tex"))),
    source: "path",
  }
}

export class RtexSession {
  readonly id = randomUUID()
  readonly root: LatexProject.Root
  readonly main: string
  readonly build: string
  readonly server: Server
  readonly env: NodeJS.ProcessEnv
  readonly events: RtexEvent[] = []
  private readonly listeners = new Set<(event: RtexEvent) => void>()
  private readonly stderr: string[] = []
  private buffer = ""
  private child: ReturnType<typeof launch> | undefined
  private closed = false

  constructor(input: { root: LatexProject.Root; main: string; server: Server; env: NodeJS.ProcessEnv; build: string }) {
    this.root = input.root
    this.main = input.main
    this.server = input.server
    this.env = input.env
    this.build = input.build
  }

  start() {
    const args = ["serve", "--project", this.root.path, "--main", this.main, "--build", this.build]
    const child = launch(this.server.path, args, {
      cwd: this.root.path,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    this.child = child
    const decoder = new StringDecoder("utf8")
    child.stdout?.on("data", (bytes: Buffer) => {
      this.buffer += decoder.write(bytes)
      while (true) {
        const at = this.buffer.indexOf("\n")
        if (at < 0) break
        const line = this.buffer.slice(0, at).trim()
        this.buffer = this.buffer.slice(at + 1)
        if (line) this.consume(line)
      }
      if (this.buffer.length > 16 * 1024 * 1024) this.buffer = ""
    })
    const err = new StringDecoder("utf8")
    child.stderr?.on("data", (bytes: Buffer) => {
      for (const line of err.write(bytes).split(/\r?\n/)) {
        if (!line) continue
        this.stderr.push(line)
        if (this.stderr.length > 80) this.stderr.shift()
      }
    })
    child.once("error", (cause: Error) => this.publish({ event: "SessionError", message: cause.message }))
    child.once("close", (code, signal) => {
      this.closed = true
      this.publish({ event: "SessionExit", code, signal, stderr: this.stderr.slice(-20) })
    })
  }

  private consume(line: string) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.stderr.push(`unparsable rtex output: ${line.slice(0, 200)}`)
      return
    }
    if (!value || typeof value !== "object" || typeof (value as { event?: unknown }).event !== "string") return
    this.publish(value as RtexEvent)
  }

  private publish(event: RtexEvent) {
    this.events.push(event)
    if (this.events.length > 400) this.events.shift()
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: (event: RtexEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get running() {
    return !!this.child && !this.closed
  }

  kill() {
    this.closed = true
    try {
      this.child?.kill("SIGKILL")
    } catch {
      /* already gone */
    }
    this.child = undefined
  }

  send(command: Record<string, unknown>) {
    if (!this.running) throw new LatexSchema.Error(409, "The realtime session is not running.")
    this.child?.stdin?.write(`${JSON.stringify(command)}\n`)
  }

  document(file: string, text: string) {
    this.send({ cmd: "set_document", path: file, text })
  }

  edit(file: string, start: number, end: number, text: string) {
    this.send({ cmd: "edit", path: file, start, end, text })
  }

  async stop() {
    const child = this.child
    this.child = undefined
    if (!child || this.closed) return
    this.closed = true
    this.child = undefined
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (process.platform === "win32") {
          launch("taskkill.exe", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true })
        } else if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch {
            child.kill("SIGKILL")
          }
        }
        resolve()
      }, 2_000)
      child.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    try {
      child.stdin?.write(`${JSON.stringify({ cmd: "quit" })}\n`)
      child.stdin?.end()
    } catch {
      child.kill()
    }
    await done
    await fs.rm(this.build, { recursive: true, force: true }).catch(() => undefined)
  }
}

const sessions = new Map<string, RtexSession>()

process.once("exit", () => {
  for (const session of sessions.values()) session.kill()
})

export namespace LatexRealtime {
  export async function status(cfg: LatexSchema.Config) {
    const setup = await LatexRtex.status()
    const found = await server(cfg).catch(() => undefined)
    return {
      installed: !!found,
      ...(found ? { path: found.path, version: setup.version } : {}),
      ...(!found ? { error: "rtex is not installed. Install it in LaTeX settings." } : {}),
      setup: setup.setup,
    }
  }

  export async function open(input: { root: string; main: string; cfg: LatexSchema.Config }) {
    const root = await LatexProject.root(input.root)
    const main = await LatexProject.main(root, input.main)
    const found = await server(input.cfg)
    if (!found) throw new LatexSchema.Error(503, "rtex is not installed. Install it in LaTeX settings.")
    const lualatex = which("lualatex")
    if (!lualatex)
      throw new LatexSchema.Error(503, "LuaLaTeX was not found on PATH. Realtime preview requires LuaLaTeX.")
    const id = randomUUID()
    const build = path.join(Global.Path.cache, "latex", "realtime", root.owner, root.key, id)
    await fs.mkdir(build, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${path.dirname(lualatex)}${path.delimiter}${process.env.PATH ?? ""}`,
      RTEX_TEXLIVE_BIN: path.dirname(lualatex),
      ...(found.texdir ? { RTEX_TEXDIR: found.texdir } : {}),
    }
    const session = new RtexSession({ root, main, server: found, env, build })
    sessions.set(session.id, session)
    session.start()
    return { id: session.id, root: root.root, main }
  }

  export function get(id: string) {
    const session = sessions.get(id)
    if (!session) throw new LatexSchema.Error(404, "The realtime session does not exist.")
    return session
  }

  export function document(id: string, file: string, text: string) {
    const session = get(id)
    session.document(file, text)
  }

  export function edit(id: string, file: string, start: number, end: number, text: string) {
    const session = get(id)
    session.edit(file, start, end, text)
  }

  export function command(id: string, command: "request_layout" | "export_pdf" | "status") {
    const session = get(id)
    session.send({ cmd: command })
  }

  export function font(id: string, filename?: string, name?: string) {
    const session = get(id)
    return RtexResources.font(session.id, session.env, filename, name)
  }

  export async function close(id: string) {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    RtexResources.dispose(id)
    await session.stop()
  }

  export async function closeAll(owner?: string) {
    const targets = [...sessions.values()].filter((session) => !owner || session.root.owner === owner)
    await Promise.all(targets.map((session) => close(session.id)))
  }

  export function pdf(session: RtexSession, version: number) {
    if (!Number.isInteger(version) || version < 1 || version > 1_000_000)
      throw new LatexSchema.Error(400, "Invalid rtex layout version.")
    return path.join(session.build, "bg", `layout-${version}.pdf`)
  }

  export function image(session: RtexSession, file: string) {
    const target = path.isAbsolute(file) ? path.resolve(file) : path.resolve(session.root.path, file)
    if (!LatexProject.contains(session.root.path, target))
      throw new LatexSchema.Error(403, "The realtime image escapes the project.")
    return target
  }

  export function kpsewhich(session: RtexSession, file: string) {
    return new Promise<string | undefined>((resolve) => {
      const child = launch("kpsewhich", [file], {
        env: session.env,
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
        const value = out.split(/\r?\n/).find(Boolean)
        resolve(value || undefined)
      })
      child.once("error", () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
  }
}
