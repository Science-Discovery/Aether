import { spawn, ChildProcess } from "child_process"
import { createInterface } from "readline"
import { mkdir, readFile, writeFile, rm } from "fs/promises"
import { join, dirname } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Server } from "@/server/server"
import { Flag } from "@/flag/flag"
import { Database } from "@/storage/db"
import { MessageTable, PartTable } from "@/session/session.sql"
import { desc, inArray } from "drizzle-orm"
import { Config } from "@/config/config"

const WECHAT_DATA_DIR = join(homedir(), ".local", "share", "opencode", "wechat")
const QRCODE_FILE = join(WECHAT_DATA_DIR, "qrcode.txt")
const SESSION_FILE = join(WECHAT_DATA_DIR, "session.json")
const PID_FILE = join(WECHAT_DATA_DIR, "pid.txt")

export type WeChatStatus = "idle" | "starting" | "qrcode" | "connected" | "error"

export interface WeChatSession {
  connected: boolean
  user?: {
    id: string
    name: string
  }
  expiresAt?: number
  createdAt: number
}

export const WeChatEvent = {
  StatusChanged: BusEvent.define(
    "wechat.status",
    z.object({
      status: z.enum(["idle", "starting", "qrcode", "connected", "error"]),
      message: z.string().optional(),
    }),
  ),
  QRCode: BusEvent.define(
    "wechat.qrcode",
    z.object({
      image: z.string(),
    }),
  ),
  Connected: BusEvent.define(
    "wechat.connected",
    z.object({
      user: z.object({
        id: z.string(),
        name: z.string(),
      }),
    }),
  ),
  Error: BusEvent.define(
    "wechat.error",
    z.object({
      code: z.string(),
      message: z.string(),
    }),
  ),
}

class WeChatManagerImpl {
  private process: ChildProcess | null = null
  private _status: WeChatStatus = "idle"
  private _qrcode: string | null = null
  private _session: WeChatSession | null = null
  private _error: { code: string; message: string } | null = null
  private _stderr: string[] = []

  get status() {
    return this._status
  }

  get qrcode() {
    return this._qrcode
  }

  get session() {
    return this._session
  }

  get error() {
    return this._error
  }

  private set status(value: WeChatStatus) {
    this._status = value
    Bus.publish(WeChatEvent.StatusChanged, { status: value })
  }

  async start(model?: string): Promise<{ success: boolean; message?: string; status?: string; user?: { id: string; name: string } }> {
    if (this.process) {
      return { success: false, message: "WeChat bridge is already running" }
    }

    // 先检查是否有已保存的会话
    const savedSession = await this.loadSession()
    if (savedSession?.connected && savedSession.user) {
      this._session = savedSession
      this.status = "connected"
      Bus.publish(WeChatEvent.Connected, { user: savedSession.user })
      return { success: true, status: "connected", user: savedSession.user }
    }

    const pythonCheck = await this.checkPython()
    if (!pythonCheck.available) {
      this._error = { code: "python_not_found", message: pythonCheck.message || "Python 3.11+ not found" }
      this.status = "error"
      Bus.publish(WeChatEvent.Error, this._error)
      return { success: false, message: pythonCheck.message }
    }

    const scriptPath = await this.findBridgeScript()
    if (!scriptPath) {
      this._error = { code: "script_not_found", message: "WeChat bridge script not found" }
      this.status = "error"
      Bus.publish(WeChatEvent.Error, this._error)
      return { success: false, message: "WeChat bridge script not found" }
    }

    await mkdir(WECHAT_DATA_DIR, { recursive: true })

    this.status = "starting"
    this._error = null
    this._stderr = []

    // Auto-install Python dependencies if missing
    const deps = await this.ensureDeps(pythonCheck.path!, scriptPath)
    if (!deps.ok) {
      this._error = { code: "deps_install_failed", message: deps.message }
      this.status = "error"
      Bus.publish(WeChatEvent.Error, this._error)
      return { success: false, message: deps.message }
    }

    try {
      const aetherUrl = Server.url?.toString() || "http://127.0.0.1:4096"
      console.log(`[wechat] Starting bridge with AETHER_URL=${aetherUrl}`)

      // Use model passed from UI, or fall back to detecting from successful sessions
      let modelEnv = model ?? ""
      if (!modelEnv) {
        try {
          const cfg = await Config.get().catch(() => null)
          const disabled = new Set(cfg?.disabled_providers ?? [])
          const validProviders = cfg?.provider
            ? new Set(Object.keys(cfg.provider).filter((id) => !disabled.has(id)))
            : null

          const sessionsWithParts = Database.use((db) =>
            db.selectDistinct({ session_id: PartTable.session_id }).from(PartTable).all(),
          ).map((r) => r.session_id)

          if (sessionsWithParts.length > 0) {
            const rows = Database.use((db) =>
              db
                .select()
                .from(MessageTable)
                .where(inArray(MessageTable.session_id, sessionsWithParts))
                .orderBy(desc(MessageTable.time_created))
                .limit(100)
                .all(),
            )
            for (const row of rows) {
              const data = row.data as any
              if (data?.role === "user" && data?.model?.providerID && data?.model?.modelID) {
                const pid = data.model.providerID as string
                if (!validProviders || validProviders.has(pid)) {
                  modelEnv = `${pid}/${data.model.modelID}`
                  break
                }
              }
            }
          }
        } catch (e) {
          console.log(`[wechat] failed to detect model: ${e}`)
        }
      }
      console.log(`[wechat] Using model: ${modelEnv || "(none, server will decide)"}`)

      this.process = spawn(pythonCheck.path!, [scriptPath], {
        env: {
          ...process.env,
          AETHER_WECHAT_QRCODE_FILE: QRCODE_FILE,
          AETHER_WECHAT_SESSION_FILE: SESSION_FILE,
          PYTHONUNBUFFERED: "1",
          AETHER_URL: aetherUrl,
          AETHER_USERNAME: Flag.OPENCODE_SERVER_USERNAME || "",
          AETHER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD || "",
          ...(modelEnv ? { AETHER_MODEL: modelEnv } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      await writeFile(PID_FILE, String(this.process.pid))

      const stdout = createInterface({ input: this.process.stdout! })
      const stderr = createInterface({ input: this.process.stderr! })

      stdout.on("line", (line) => {
        this.handleOutput(line)
      })

      stderr.on("line", (line) => {
        console.error("[wechat-bridge]", line)
        this._stderr.push(line)
        if (this._stderr.length > 50) this._stderr.shift()
      })

      this.process.on("exit", (code, signal) => {
        this.handleExit(code, signal)
      })

      this.process.on("error", (err) => {
        this._error = { code: "process_error", message: err.message }
        this.status = "error"
        Bus.publish(WeChatEvent.Error, this._error)
      })

      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._error = { code: "start_failed", message }
      this.status = "error"
      Bus.publish(WeChatEvent.Error, this._error)
      return { success: false, message }
    }
  }

  async stop(): Promise<void> {
    if (!this.process) {
      // 即使没有进程，也要清除会话状态
      this._session = null
      this._qrcode = null
      this.status = "idle"
      await this.clearSession()
      return
    }

    this.process.kill("SIGTERM")
    this.process = null
    this._session = null
    this._qrcode = null
    this.status = "idle"

    try {
      await rm(PID_FILE, { force: true })
    } catch {}

    await this.clearSession()
  }

  async checkPython(): Promise<{ available: boolean; path?: string; message?: string }> {
    const pythonCommands = ["python3", "python"]

    for (const cmd of pythonCommands) {
      try {
        const result = Bun.spawnSync([cmd, "--version"], { timeout: 5000 })
        if (result.exitCode === 0) {
          const version = result.stdout.toString().trim()
          const match = version.match(/Python (\d+)\.(\d+)/)
          if (match) {
            const major = parseInt(match[1])
            const minor = parseInt(match[2])
            if (major > 3 || (major === 3 && minor >= 11)) {
              return { available: true, path: cmd }
            }
          }
        }
      } catch {}
    }

    return {
      available: false,
      message: "Python 3.11+ is required. Please install Python 3.11 or later.",
    }
  }

  private async ensureDeps(python: string, script: string): Promise<{ ok: boolean; message: string }> {
    const check = Bun.spawnSync([python, "-c", "import wechat_agent_sdk; import httpx"], { timeout: 10000 })
    if (check.exitCode === 0) return { ok: true, message: "" }

    console.log("[wechat] Dependencies missing, installing...")
    const req = join(dirname(script), "requirements.txt")
    if (!existsSync(req)) return { ok: false, message: "requirements.txt not found" }

    const install = Bun.spawnSync([python, "-m", "pip", "install", "--quiet", "-r", req], { timeout: 120000 })
    if (install.exitCode === 0) return { ok: true, message: "" }

    const err = install.stderr.toString().trim()
    console.error("[wechat] pip install failed:", err)
    return {
      ok: false,
      message: `Failed to install dependencies: ${err || "pip exited with code " + install.exitCode}`,
    }
  }

  private async findBridgeScript(): Promise<string | null> {
    const target = "aether_wechat_agent.py"
    const paths = [
      // Production: next to binary
      join(dirname(process.execPath), "wechat-bridge", target),
      // User installation
      join(homedir(), ".local", "share", "opencode", "wechat-bridge", target),
    ]

    // Development: search upward from cwd for Aether-wechat-bridge/
    let dir = process.cwd()
    while (true) {
      paths.push(join(dir, "Aether-wechat-bridge", target))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }

    for (const p of paths) {
      if (existsSync(p)) return p
    }

    return null
  }

  private handleOutput(line: string) {
    if (line.includes("[QR]") || line.includes("qrcode")) {
      this.status = "qrcode"
      this._qrcode = this.extractQRCode(line)
      if (this._qrcode) {
        Bus.publish(WeChatEvent.QRCode, { image: this._qrcode })
      }
    } else if (line.includes("[登录成功]") || line.includes("Login success") || line.includes("connected")) {
      this.status = "connected"
      const user = this.extractUser(line)
      this._session = {
        connected: true,
        user,
        createdAt: Date.now(),
      }
      Bus.publish(WeChatEvent.Connected, { user })
      this.saveSession()
    }
  }

  private extractQRCode(line: string): string | null {
    const match = line.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/)
    if (match) return match[0]

    if (existsSync(QRCODE_FILE)) {
      try {
        return readFile(QRCODE_FILE, "utf-8").then((d) => d.trim()) as unknown as string
      } catch {}
    }

    return null
  }

  private extractUser(line: string): { id: string; name: string } {
    const match = line.match(/user[::]\s*(\S+)\s*\((.+)\)/i)
    if (match) {
      return { id: match[1], name: match[2] }
    }
    return { id: "unknown", name: "WeChat User" }
  }

  private handleExit(code: number | null, signal: string | null) {
    this.process = null
    if (code !== 0 && code !== null) {
      const detail = this._stderr.slice(-5).join("\n").trim()
      const message = detail ? `Process exited with code ${code}: ${detail}` : `Process exited with code ${code}`
      this._error = { code: "process_exit", message }
      this.status = "error"
      Bus.publish(WeChatEvent.Error, this._error)
    } else {
      this.status = "idle"
    }
    rm(PID_FILE, { force: true }).catch(() => {})
  }

  private async saveSession() {
    if (this._session) {
      await writeFile(SESSION_FILE, JSON.stringify(this._session, null, 2))
    }
  }

  async loadSession(): Promise<WeChatSession | null> {
    try {
      if (existsSync(SESSION_FILE)) {
        const data = await readFile(SESSION_FILE, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return null
  }

  async clearSession(): Promise<void> {
    try {
      await rm(SESSION_FILE, { force: true })
      this._session = null
    } catch {}
  }
}

export const WeChatManager = new WeChatManagerImpl()
