import { spawn, ChildProcess } from "child_process"
import { createInterface } from "readline"
import { mkdir, readFile, writeFile, rm } from "fs/promises"
import { join, dirname } from "path"
import { existsSync, readFileSync, unlinkSync } from "fs"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Server } from "@/server/server"
import { Flag } from "@/flag/flag"
import { Config } from "@/config/config"
import { Database } from "@/storage/db"
import { MessageTable, PartTable } from "@/session/session.sql"
import { desc, inArray } from "drizzle-orm"
import { legacyPlatformDir, platformDir } from "@/persist/naming"
import { MobileManagerBase } from "./base"
import type { MobileAdapter, MobileStatus, ModelRef } from "./base"
import * as ilink from "./ilink"

export type WeChatStatus = "idle" | "starting" | "qrcode" | "connected" | "error"

export interface WeChatSession {
  connected: boolean
  user?: { id: string; name: string }
  expiresAt?: number
  createdAt: number
}

const UV_VERSION = "0.6.14"

const pythonBin = (env: string) =>
  process.platform === "win32" ? join(env, "Scripts", "python.exe") : join(env, "bin", "python")

function wcDir() {
  return platformDir("wechat")
}

function wcOldDir() {
  return legacyPlatformDir("wechat")
}

function wcFile(name: string) {
  return join(wcDir(), name)
}

function wcReadPath(name: "session.json" | "accounts.json") {
  const next = wcFile(name)
  const prev = join(wcOldDir(), name)
  return existsSync(next) || !existsSync(prev) ? next : prev
}

class WeChatAdapter implements MobileAdapter {
  platform: "wechat" = "wechat"
  private manager: WeChatManagerImpl

  constructor(manager: WeChatManagerImpl) {
    this.manager = manager
  }

  async replyText(targetId: string, text: string): Promise<void> {
    await this.manager.sendToWeChat(targetId, text)
  }

  async replyFile(targetId: string, filePath: string): Promise<void> {
    await this.manager.sendFileToWeChat(targetId, filePath)
  }

  async loadConfig(): Promise<any | null> {
    return null
  }

  async clearAuth(): Promise<void> {
    try {
      await rm(wcFile("session.json"), { force: true })
      await rm(wcFile("accounts.json"), { force: true })
    } catch {}
  }

  async loadSession(): Promise<WeChatSession | null> {
    try {
      const next = wcReadPath("session.json")
      if (existsSync(next)) {
        const data = await readFile(next, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return null
  }
}

class WeChatManagerImpl extends MobileManagerBase {
  private process: ChildProcess | null = null
  private _qrcode: string | null = null
  private _wcSession: WeChatSession | null = null
  private _stderr: string[] = []
  private _lockHolder: string | null = null
  private _ilinkToken: string = ""
  private _ilinkBaseUrl: string = ""
  private _ilinkCdnBaseUrl: string = "https://novac2c.cdn.weixin.qq.com/c2c"
  private _contextTokens: Record<string, string> = {}

  get lockHolder(): string | null {
    try {
      if (!existsSync(wcFile("lock.json"))) return null
      const raw = readFileSync(wcFile("lock.json"), "utf-8")
      const lock = JSON.parse(raw) as { clientId: string; pid: number; updatedAt?: number }
      try {
        process.kill(lock.pid, 0)
      } catch {
        try {
          unlinkSync(wcFile("lock.json"))
        } catch {}
        return null
      }
      if (lock.updatedAt && Date.now() - lock.updatedAt > 30_000) {
        try {
          unlinkSync(wcFile("lock.json"))
        } catch {}
        return null
      }
      return lock.clientId
    } catch {
      return null
    }
  }

  get qrcode() {
    return this._qrcode
  }

  get session() {
    return this._wcSession
  }

  override platformDir() {
    return "wechat"
  }

  override platformName() {
    return "微信"
  }

  protected override replyTarget(chatId: string, messageId: string): string {
    return chatId
  }

  constructor() {
    super(new WeChatAdapter({} as any))
    const adapter = new WeChatAdapter(this)
    this.adapter = adapter
  }

  async tryLock(clientId: string): Promise<boolean> {
    await mkdir(wcDir(), { recursive: true })
    const current = this.lockHolder
    if (!current || current === clientId) {
      await writeFile(wcFile("lock.json"), JSON.stringify({ clientId, pid: process.pid, updatedAt: Date.now() }))
      return true
    }
    return false
  }

  async forceLock(clientId: string): Promise<void> {
    await mkdir(wcDir(), { recursive: true })
    try {
      await rm(wcFile("lock.json"), { force: true })
    } catch {}
    await writeFile(wcFile("lock.json"), JSON.stringify({ clientId, pid: process.pid, updatedAt: Date.now() }))
  }

  async unlock(clientId: string): Promise<void> {
    if (this.lockHolder === clientId) {
      await rm(wcFile("lock.json"), { force: true })
    }
  }

  async ping(clientId: string): Promise<{ ok: boolean; stolen: boolean }> {
    const current = this.lockHolder
    if (current === clientId) {
      await writeFile(wcFile("lock.json"), JSON.stringify({ clientId, pid: process.pid, updatedAt: Date.now() }))
      return { ok: true, stolen: false }
    }
    return { ok: false, stolen: current !== null }
  }

  async start(
    model?: string,
    auto = false,
  ): Promise<{
    success: boolean
    message?: string
    code?: string
    status?: string
    user?: { id: string; name: string }
  }> {
    if (this.process) {
      return { success: false, message: "WeChat bridge is already running" }
    }

    const savedSession = await this.adapter.loadSession()
    if (savedSession?.connected && savedSession.user) {
      this._wcSession = savedSession
      this.status = "connected"
      Bus.publish(this.busEvents.Connected, { user: savedSession.user })
      return { success: true, status: "connected", user: savedSession.user }
    }

    const script =
      (await this.findBridgeFile("aether_wechat_transport.py")) || (await this.findBridgeFile("aether_wechat_agent.py"))
    if (!script) {
      this._error = { code: "script_not_found", message: "WeChat bridge script not found" }
      this.status = "error"
      Bus.publish(this.busEvents.Error, this._error)
      return { success: false, message: "WeChat bridge script not found" }
    }

    this.status = "starting"
    this._error = null
    this._stderr = []

    void this._doStart(script, auto, model)
    return { success: true }
  }

  private async _doStart(script: string, auto: boolean, model?: string): Promise<void> {
    const root = dirname(script)
    const env = join(root, ".venv")
    const py = pythonBin(env)

    if (!(await this.ready(py))) {
      if (!auto) {
        this._error = {
          code: "install_required",
          message: "需要安装 Python 3.11 运行时与依赖，需要联网，可能耗时。请确认后重试。",
        }
        this.status = "error"
        Bus.publish(this.busEvents.Error, this._error)
        return
      }
      const setup = await this.install(root, env)
      if (!setup.ok) {
        this._error = { code: setup.code, message: setup.message }
        this.status = "error"
        Bus.publish(this.busEvents.Error, this._error)
        return
      }
    }

    await mkdir(wcDir(), { recursive: true })

    try {
      const aetherUrl = Server.url?.toString() || "http://127.0.0.1:4096"
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

      this.process = spawn(py, [script], {
        env: {
          ...process.env,
          AETHER_WECHAT_QRCODE_FILE: wcFile("qrcode.txt"),
          AETHER_WECHAT_SESSION_FILE: wcFile("session.json"),
          PYTHONUNBUFFERED: "1",
          AETHER_URL: aetherUrl,
          AETHER_USERNAME: Flag.OPENCODE_SERVER_USERNAME || "",
          AETHER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD || "",
          ...(modelEnv ? { AETHER_MODEL: modelEnv } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      await writeFile(wcFile("pid.txt"), String(this.process.pid))

      const stdout = createInterface({ input: this.process.stdout! })
      const stderr = createInterface({ input: this.process.stderr! })

      stdout.on("line", (line) => this.handleOutput(line))
      stderr.on("line", (line) => {
        console.error("[wechat-bridge]", line)
        this._stderr.push(line)
        if (this._stderr.length > 50) this._stderr.shift()
      })

      this.process.on("exit", (code) => this.handleExit(code))
      this.process.on("error", (err) => {
        this._error = { code: "process_error", message: err.message }
        this.status = "error"
        Bus.publish(this.busEvents.Error, this._error)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._error = { code: "start_failed", message }
      this.status = "error"
      Bus.publish(this.busEvents.Error, this._error)
    }
  }

  private handleOutput(line: string) {
    if (line.startsWith("[TOKEN]")) {
      try {
        const payload = JSON.parse(line.slice(7).trim())
        this._ilinkToken = payload.token || ""
        this._ilinkBaseUrl = payload.base_url || ""
        if (payload.cdn_base_url) this._ilinkCdnBaseUrl = payload.cdn_base_url
        console.log("[wechat] iLink auth received, base_url:", this._ilinkBaseUrl)
      } catch (e) {
        console.error("[wechat] failed to parse [TOKEN]:", e)
      }
      return
    }
    if (line.startsWith("[CTX]")) {
      try {
        const payload = JSON.parse(line.slice(5).trim())
        const convId = payload.conv_id || payload.conversation_id || ""
        const ctx = payload.context_token || ""
        if (convId && ctx) {
          this._contextTokens[convId] = ctx
        }
      } catch (e) {
        console.error("[wechat] failed to parse [CTX]:", e)
      }
      return
    }
    if (line.includes("[QR]") || line.includes("qrcode")) {
      this.status = "qrcode"
      this._qrcode = this.extractQRCode(line)
      if (this._qrcode) {
        Bus.publish(this.busEvents.QRCode, { image: this._qrcode })
      }
    } else if (line.includes("[登录成功]") || line.includes("Login success") || line.includes("connected")) {
      this.status = "connected"
      const user = this.extractUser(line)
      this._wcSession = { connected: true, user, createdAt: Date.now() }
      Bus.publish(this.busEvents.Connected, { user })
      this.saveWcSession()
      this._modelList = []
      void this.buildModelList().then((list) => {
        this._modelList = list
      })
      this.subscribeBusEvents()
      const allProjects = this.getProjects()
      const visibleProjects = allProjects.filter((p) => !(this.projectDir(p) in this._hiddenDirs))
      this._initialDir = visibleProjects.length > 0 ? this.projectDir(visibleProjects[0]) : Instance.directory
    }
  }

  private extractQRCode(line: string): string | null {
    const match = line.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/)
    if (match) return match[0]
    if (existsSync(wcFile("qrcode.txt"))) {
      try {
        return readFileSync(wcFile("qrcode.txt"), "utf-8").trim()
      } catch {}
    }
    return null
  }

  private extractUser(line: string): { id: string; name: string } {
    const match = line.match(/user[::]\s*(\S+)\s*\((.+)\)/i)
    if (match) return { id: match[1], name: match[2] }
    return { id: "unknown", name: "WeChat User" }
  }

  private handleExit(code: number | null) {
    this.process = null
    if (code !== 0 && code !== null) {
      const detail = this._stderr.slice(-5).join("\n").trim()
      if (!this._error) {
        const message = detail ? `Process exited with code ${code}: ${detail}` : `Process exited with code ${code}`
        this._error = { code: "process_exit", message }
      }
      this.status = "error"
      Bus.publish(this.busEvents.Error, this._error)
    } else {
      this.status = "idle"
    }
    rm(wcFile("pid.txt"), { force: true }).catch(() => {})
  }

  private async saveWcSession() {
    if (this._wcSession) {
      await writeFile(wcFile("session.json"), JSON.stringify(this._wcSession, null, 2))
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      if (process.platform === "win32") {
        this.process.kill()
      } else {
        this.process.kill("SIGTERM")
      }
      this.process = null
      try {
        await rm(wcFile("pid.txt"), { force: true })
      } catch {}
    }
    this.unsubscribeBusEvents()
    this._wcSession = null
    this._qrcode = null
    this._ilinkToken = ""
    this._ilinkBaseUrl = ""
    this._contextTokens = {}
    this.status = "idle"
    try {
      await rm(wcFile("session.json"), { force: true })
    } catch {}
  }

  override async clearSession(): Promise<void> {
    try {
      await rm(wcFile("session.json"), { force: true })
      await rm(wcFile("accounts.json"), { force: true })
      this._wcSession = null
    } catch {}
    await this.adapter.clearAuth()
  }

  // ── Send messages back to WeChat via Python bridge stdout protocol ──────────

  public async sendToWeChat(convId: string, text: string): Promise<void> {
    if (!this._ilinkToken) {
      console.error("[wechat] cannot send: no iLink token")
      return
    }
    const ctx = this._contextTokens[convId]
    if (!ctx) {
      console.error("[wechat] cannot send: no context token for", convId)
      return
    }
    try {
      await ilink.sendText(this._ilinkBaseUrl, this._ilinkToken, convId, text, ctx)
      console.log("[wechat] sent text to", convId, text.slice(0, 50))
    } catch (err) {
      console.error("[wechat] sendText error:", err)
    }
  }

  public async sendFileToWeChat(convId: string, filePath: string): Promise<void> {
    if (!this._ilinkToken) {
      console.error("[wechat] cannot send file: no iLink token")
      return
    }
    const ctx = this._contextTokens[convId]
    if (!ctx) {
      console.error("[wechat] cannot send file: no context token for", convId)
      return
    }
    try {
      await ilink.sendFile(this._ilinkBaseUrl, this._ilinkCdnBaseUrl, this._ilinkToken, convId, filePath, ctx)
      console.log("[wechat] sent file to", convId, filePath)
    } catch (err) {
      console.error("[wechat] sendFile error:", err)
    }
  }

  // ── Python bridge lifecycle ──────────────────────────────────────────────────

  private async runCmd(cmd: string[], timeout: number): Promise<{ ok: boolean; detail: string }> {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(https?|all)_proxy$/i.test(key)) delete env[key]
    }
    const proc = Bun.spawn(cmd, { stderr: "pipe", stdout: "ignore", env })
    const timer = setTimeout(() => proc.kill(), timeout)
    const [exitCode, detail] = await Promise.all([
      proc.exited,
      new Response(proc.stderr as ReadableStream).text().catch(() => ""),
    ])
    clearTimeout(timer)
    return { ok: exitCode === 0, detail: detail.trim() }
  }

  private fmtErr(detail: string, msg: string) {
    if (!detail) return msg
    const lines = detail.split("\n").filter((l) => l.trim())
    const tail = lines.slice(-3).join(" | ")
    return `${msg}: ${tail}`
  }

  private async ready(py: string): Promise<boolean> {
    if (!existsSync(py)) return false
    const { ok } = await this.runCmd(
      [
        py,
        "-c",
        "import sys; import wechat_agent_sdk; import httpx; import socksio; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)",
      ],
      10000,
    )
    return ok
  }

  private async install(root: string, env: string): Promise<{ ok: boolean; code: string; message: string }> {
    const uv = await this.findUv()
    if (!uv) {
      return { ok: false, code: "uv_not_found", message: "未找到内置 uv。请重新安装应用后重试。" }
    }

    const prep = await this.prepUv(uv)
    if (!prep.ok) return prep

    const py = pythonBin(env)
    const req = join(root, "requirements.txt")

    this.statusMsg("starting", "正在创建虚拟环境...")
    const venvWithSystem = await this.runCmd(
      [uv, "venv", "--python", "3.11", "--python-preference", "system", env],
      120000,
    )

    if (!venvWithSystem.ok) {
      this.statusMsg("starting", "正在下载 Python 3.11（首次需要联网）...")
      const ver = await this.runCmd([uv, "python", "install", "3.11"], 600000)
      if (!ver.ok) {
        return { ok: false, code: "python_install_failed", message: this.fmtErr(ver.detail, "安装 Python 3.11 失败") }
      }
      this.statusMsg("starting", "正在创建虚拟环境...")
      const venv = await this.runCmd([uv, "venv", "--python", "3.11", env], 120000)
      if (!venv.ok) {
        return { ok: false, code: "venv_failed", message: this.fmtErr(venv.detail, "创建虚拟环境失败") }
      }
    }

    this.statusMsg("starting", "正在安装依赖...")
    let dep = await this.runCmd([uv, "pip", "install", "--python", py, "-r", req], 600000)
    if (!dep.ok) {
      this.statusMsg("starting", "正在安装依赖（切换国内镜像）...")
      dep = await this.runCmd(
        [uv, "pip", "install", "--python", py, "-r", req, "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple"],
        600000,
      )
    }
    if (!dep.ok) {
      return { ok: false, code: "deps_failed", message: this.fmtErr(dep.detail, "安装依赖失败") }
    }

    return { ok: true, code: "", message: "" }
  }

  private async prepUv(uv: string): Promise<{ ok: boolean; code: string; message: string }> {
    if (process.platform !== "win32") {
      const r = await this.runCmd(["chmod", "+x", uv], 10000)
      if (!r.ok)
        return { ok: false, code: "uv_not_executable", message: this.fmtErr(r.detail, "无法设置 uv 可执行权限") }
    }
    const r = await this.runCmd([uv, "--version"], 10000)
    if (!r.ok) return { ok: false, code: "uv_not_executable", message: this.fmtErr(r.detail, "uv 无法执行") }
    return { ok: true, code: "", message: "" }
  }

  private async findUv(): Promise<string | null> {
    const target =
      process.platform === "darwin"
        ? process.arch === "arm64"
          ? join("runtime", "uv", `uv-${UV_VERSION}-aarch64-apple-darwin`, "uv")
          : join("runtime", "uv", `uv-${UV_VERSION}-x86_64-apple-darwin`, "uv")
        : process.platform === "win32"
          ? join("runtime", "uv", `uv-${UV_VERSION}-x86_64-pc-windows-msvc`, "uv.exe")
          : process.platform === "linux"
            ? process.arch === "arm64"
              ? join("runtime", "uv", `uv-${UV_VERSION}-aarch64-unknown-linux-gnu`, "uv")
              : join("runtime", "uv", `uv-${UV_VERSION}-x86_64-unknown-linux-gnu`, "uv")
            : ""
    if (!target) return null
    return this.findBridgeFile(target)
  }

  private async findBridgeFile(target: string): Promise<string | null> {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const paths = [
      resources ? join(resources, "wechat-bridge", target) : "",
      join(dirname(process.execPath), "wechat-bridge", target),
      join(platformDir("wechat-bridge"), target),
      join(legacyPlatformDir("wechat-bridge"), target),
    ]
    let dir = process.cwd()
    while (true) {
      paths.push(join(dir, "Aether-wechat-bridge", target))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    for (const p of paths) {
      if (!p) continue
      if (existsSync(p)) return p
    }
    return null
  }
}

export const WeChatManager = new WeChatManagerImpl()
