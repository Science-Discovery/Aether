import { mkdir, readFile, writeFile, rm } from "fs/promises"
import { join } from "path"
import { existsSync } from "fs"
import QRCode from "qrcode"
import { Instance } from "@/project/instance"
import { legacyPlatformDir, platformDir } from "@/persist/naming"
import { MobileManagerBase } from "./base"
import type { MobileAdapter } from "./base"
import * as ilink from "./ilink"
import type { LoginStatusResult, MediaAttachment } from "./ilink"

export type WeChatStatus = "idle" | "starting" | "qrcode" | "connected" | "reconnecting" | "error"

export interface WeChatSession {
  connected: boolean
  user?: { id: string; name: string }
  createdAt: number
}

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"

function wcDir() {
  return platformDir("wechat")
}

function wcOldDir() {
  return legacyPlatformDir("wechat")
}

function wcFile(name: string) {
  return join(wcDir(), name)
}

function wcReadPath(name: "session.json" | "accounts.json" | "ilink_state.json") {
  const next = wcFile(name)
  const prev = join(wcOldDir(), name)
  return existsSync(next) || !existsSync(prev) ? next : prev
}

interface ILinkState {
  token: string
  cursor: string
  baseUrl: string
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
      await rm(wcFile("ilink_state.json"), { force: true })
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
  private _qrcode: string | null = null
  private _wcSession: WeChatSession | null = null
  private _ilinkToken: string = ""
  private _ilinkBaseUrl: string = ILINK_BASE_URL
  private _ilinkCdnBaseUrl: string = ILINK_CDN_BASE_URL
  private _contextTokens: Record<string, string> = {}
  private _cursor: string = ""
  private _pollRunning: boolean = false
  private _pollGen = 0
  private _seenIds: Set<string> = new Set()
  private _loginAbort: AbortController | null = null
  private _tokenKnownExpired: boolean = false
  private resumeDelay = 60 * 60 * 1000

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

  // ── Start: pure TS login + poll ────────────────────────────────────────────

  override async hasCredentials(): Promise<boolean> {
    return !!(await this.loadILinkState())
  }

  async start(rescan = false): Promise<{
    success: boolean
    message?: string
    status?: string
    user?: { id: string; name: string }
  }> {
    if (this._pollRunning) {
      return { success: true, status: this._status, user: this._wcSession?.user }
    }

    if (this._status !== "idle" && this._status !== "error") {
      return { success: true, status: this._status }
    }

    if (this._starting) {
      return { success: true, status: this._status }
    }

    this._starting = true
    try {
      this._error = null

      this.sessionMap = await this.loadSessionMap()
      this._hiddenDirs = await this.loadHiddenDirs()
      this._showHeader = await this.loadHeaderState()

      if (!rescan) {
        try {
          if (await this.resumeFromSaved()) {
            return { success: true, status: "connected", user: this._wcSession?.user }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error("[wechat] resume failed:", err)
          this._error = { code: "resume_failed", message }
          this.status = "error"
          this.emit(this.busEvents.Error, this._error)
          return { success: false, message }
        }
      }

      this.status = "starting"
      void this.loginAndPoll()
      return { success: true }
    } finally {
      this._starting = false
    }
  }

  async retry(): Promise<{ success: boolean; message?: string; status?: string; user?: { id: string; name: string } }> {
    this._loginAbort?.abort()
    this._loginAbort = null
    this._pollRunning = false
    this.unsubscribeBusEvents()
    this._error = null

    if (this._tokenKnownExpired) {
      this._ilinkToken = ""
      this._tokenKnownExpired = false
      try {
        await rm(wcFile("ilink_state.json"), { force: true })
      } catch {}
      this.status = "starting"
      void this.loginAndPoll()
      return { success: true }
    }

    this.status = "idle"
    return this.start()
  }

  private async reconnect(gen: number): Promise<void> {
    if (this._pollGen !== gen) return
    this.status = "reconnecting"
    this.emit(this.busEvents.Reconnecting, { attempt: 1, delay: 0 })

    try {
      if (await this.resumeFromSaved()) return
    } catch (err) {
      if (this._pollGen !== gen) return
      const message = err instanceof Error ? err.message : String(err)
      console.error("[wechat] resume failed:", err)
      this._error = { code: "resume_failed", message }
      this.status = "error"
      this.emit(this.busEvents.Error, this._error)
      return
    }

    if (this._pollGen !== gen) return
    this._ilinkToken = ""
    void this.loginAndPoll()
  }

  private async finishConnect(user: { id: string; name: string }, gen: number): Promise<void> {
    if (this._pollGen !== gen) return
    this._wcSession = { connected: true, user, createdAt: Date.now() }
    await this.saveWcSession()
    await this.saveILinkState()
    this._initialized = false
    await this.initSessions()
    if (this._pollGen !== gen) return
    this.status = "connected"
    this.emit(this.busEvents.Connected, { user })
    this._pollRunning = true
    this._pollGen = gen + 1
    void this.pollLoop(gen + 1)
    this.subscribeBusEvents()
    this._modelList = []
    void this.buildModelList().then((list) => {
      this._modelList = list
    })
  }

  private async resumeFromSaved(): Promise<boolean> {
    const gen = this._pollGen
    const state = await this.loadILinkState()
    if (!state?.token) return false
    if (this._pollGen !== gen) return false
    this._ilinkToken = state.token
    this._ilinkBaseUrl = state.baseUrl || ILINK_BASE_URL
    this._cursor = state.cursor || ""
    const session = await this.adapter.loadSession()
    const user = session?.user || this._wcSession?.user || { id: "wechat-user", name: "微信用户" }
    await this.finishConnect(user, gen)
    return true
  }

  private async loginAndPoll(): Promise<void> {
    const gen = this._pollGen
    const abort = new AbortController()
    this._loginAbort = abort
    let token: string
    try {
      await mkdir(wcDir(), { recursive: true })

      this.status = "qrcode"
      console.log("[wechat] requesting QR code from", this._ilinkBaseUrl)
      const qrInfo = await ilink.requestQRCode(this._ilinkBaseUrl)

      const qrDataUrl = await QRCode.toDataURL(qrInfo.qr_url, { width: 256, margin: 2, errorCorrectionLevel: "M" })
      this._qrcode = qrDataUrl
      this.emit(this.busEvents.QRCode, { image: qrDataUrl })

      token = await this.waitForLogin(qrInfo.uuid, abort.signal)
      if (abort.signal.aborted) return
      this._ilinkToken = token
      this._loginAbort = null
      this._tokenKnownExpired = false
    } catch (err) {
      if (abort.signal.aborted) {
        console.log("[wechat] login aborted")
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      console.error("[wechat] loginAndPoll failed:", err)
      this._loginAbort = null
      this._error = { code: "login_failed", message }
      this.status = "error"
      this.emit(this.busEvents.Error, this._error)
      try {
        await rm(wcFile("ilink_state.json"), { force: true })
      } catch {}
      return
    }

    try {
      await this.finishConnect({ id: "wechat-user", name: "微信用户" }, gen)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[wechat] connect after login failed:", err)
      this._error = { code: "resume_failed", message }
      this.status = "error"
      this.emit(this.busEvents.Error, this._error)
    }
  }

  private async waitForLogin(uuid: string, signal: AbortSignal): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < 120_000) {
      if (signal.aborted) throw new Error("Login cancelled")
      await new Promise((r) => setTimeout(r, 2000))
      const result: LoginStatusResult = await ilink.checkLoginStatus(this._ilinkBaseUrl, uuid)
      if (result.status === "confirmed" && result.token) {
        if (result.base_url) this._ilinkBaseUrl = result.base_url
        return result.token
      }
      if (result.status === "expired") throw new Error("QR code expired")
      if (result.status === "error") throw new Error(`Login failed: ${result.message || "unknown"}`)
    }
    throw new Error("Login timeout")
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────

  private async expire(reason: string): Promise<void> {
    const gen = this._pollGen
    console.warn(`[wechat] session invalidated (${reason}), silent resume in ${this.resumeDelay / 60000} min`)
    this._pollRunning = false
    this._tokenKnownExpired = true
    this._cursor = ""
    try {
      if (this._ilinkToken) await this.saveILinkState()
      else await rm(wcFile("ilink_state.json"), { force: true })
    } catch {}
    this.status = "reconnecting"
    this.emit(this.busEvents.Reconnecting, { attempt: 1, delay: this.resumeDelay })
    const timer = setTimeout(() => {
      if (this._pollGen !== gen || !this._ilinkToken) return
      void this.reconnect(gen)
    }, this.resumeDelay)
    timer.unref?.()
  }

  private async pollLoop(gen: number): Promise<void> {
    let failures = 0
    while (this._pollRunning && this._pollGen === gen) {
      try {
        const result = await ilink.getUpdates(this._ilinkBaseUrl, this._ilinkToken, this._cursor)
        if (this._pollGen !== gen) return
        if (result.expired) {
          await this.expire("errcode -14")
          return
        }

        if (result.cursor && result.cursor !== this._cursor) {
          this._cursor = result.cursor
        }

        failures = 0

        for (const raw of result.messages) {
          const parsed = ilink.parseMessage(raw)
          if (!parsed) continue
          const msgId = parsed.message_id
          if (msgId && this._seenIds.has(msgId)) continue
          if (msgId) {
            this._seenIds.add(msgId)
            if (this._seenIds.size > 1000) {
              const arr = [...this._seenIds]
              this._seenIds = new Set(arr.slice(-500))
            }
          }

          if (parsed.context_token) {
            this._contextTokens[parsed.conversation_id] = parsed.context_token
          }

          if (this._pollGen !== gen) return
          await this.saveILinkState()

          console.log("[wechat] received:", parsed.conversation_id, parsed.text.slice(0, 50))
          void this.handleMessage(
            parsed.conversation_id,
            parsed.message_id,
            parsed.text,
            parsed.message_id,
            parsed.mediaAttachments,
          ).catch((err) => {
            console.error("[wechat] handleMessage error:", err)
          })
        }

        if (this._pollGen !== gen) return
        if (this._cursor) await this.saveILinkState()
      } catch (err) {
        if (!this._pollRunning || this._pollGen !== gen) return
        const message = err instanceof Error ? err.message : String(err)
        if (message.startsWith("ilink 401") || message.startsWith("ilink 403")) {
          await this.expire(message)
          return
        }
        failures++
        console.error(`[wechat] poll error (${failures}/3):`, message)
        if (failures >= 3) {
          failures = 0
          await new Promise((r) => setTimeout(r, 30000))
        } else {
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
  }

  // ── iLink state persistence ────────────────────────────────────────────────

  private async loadILinkState(): Promise<ILinkState | null> {
    try {
      const path = wcReadPath("ilink_state.json")
      if (existsSync(path)) {
        const data = await readFile(path, "utf-8")
        const state = JSON.parse(data) as ILinkState
        if (state.token) return state
        try {
          await rm(path, { force: true })
        } catch {}
      }
    } catch {}
    try {
      const path = wcReadPath("accounts.json")
      if (existsSync(path)) {
        const data = await readFile(path, "utf-8")
        const accounts = JSON.parse(data) as Record<string, any>
        const acct = accounts["aether"] || accounts["default"] || Object.values(accounts)[0]
        if (acct?.token) {
          const state: ILinkState = {
            token: acct.token,
            cursor: acct.cursor || "",
            baseUrl: acct.meta?.base_url || ILINK_BASE_URL,
          }
          await mkdir(wcDir(), { recursive: true })
          await writeFile(wcFile("ilink_state.json"), JSON.stringify(state))
          return state
        }
      }
    } catch {}
    return null
  }

  private async saveILinkState(): Promise<void> {
    await mkdir(wcDir(), { recursive: true })
    await writeFile(
      wcFile("ilink_state.json"),
      JSON.stringify({ token: this._ilinkToken, cursor: this._cursor, baseUrl: this._ilinkBaseUrl }),
    )
  }

  private async saveWcSession() {
    if (this._wcSession) {
      await mkdir(wcDir(), { recursive: true })
      await writeFile(wcFile("session.json"), JSON.stringify(this._wcSession, null, 2))
    }
  }

  // ── Stop ───────────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this._loginAbort?.abort()
    this._loginAbort = null
    this._pollRunning = false
    this._pollGen++
    this.unsubscribeBusEvents()
    if (this._cursor && this._ilinkToken) await this.saveILinkState()
    this._qrcode = null
    this._contextTokens = {}
    this._seenIds.clear()
    this.deactivateAllScopes()
    this.status = "idle"
  }

  override async clearSession(): Promise<void> {
    this._ilinkToken = ""
    this._cursor = ""
    this._tokenKnownExpired = false
    try {
      await rm(wcFile("session.json"), { force: true })
      await rm(wcFile("accounts.json"), { force: true })
      await rm(wcFile("ilink_state.json"), { force: true })
      this._wcSession = null
    } catch {}
    await super.clearSession()
    await this.adapter.clearAuth()
  }

  // ── Send messages back to WeChat ───────────────────────────────────────────

  public async sendToWeChat(convId: string, text: string): Promise<void> {
    if (!this._ilinkToken) {
      console.error("[wechat] cannot send: no iLink token")
      return
    }
    const ctx = this._contextTokens[convId] || ""
    try {
      await ilink.sendText(this._ilinkBaseUrl, this._ilinkToken, convId, text, ctx)
      console.log("[wechat] sent text to", convId, "text:", text.slice(0, 80))
    } catch (err) {
      console.error("[wechat] sendText error:", err, "convId:", convId)
    }
  }

  public async sendFileToWeChat(convId: string, filePath: string): Promise<void> {
    if (!this._ilinkToken) {
      console.error("[wechat] cannot send file: no iLink token")
      return
    }
    const ctx = this._contextTokens[convId] || ""
    try {
      await ilink.sendFile(this._ilinkBaseUrl, this._ilinkCdnBaseUrl, this._ilinkToken, convId, filePath, ctx)
      console.log("[wechat] sent file to", convId, filePath)
    } catch (err) {
      console.error("[wechat] sendFile error:", err, "convId:", convId, "filePath:", filePath)
    }
  }

  protected override async downloadMediaAttachment(
    attachment: MediaAttachment,
  ): Promise<{ data: Buffer; fileName: string }> {
    return ilink.downloadMedia(attachment, this._ilinkCdnBaseUrl)
  }
}

export const WeChatManager = new WeChatManagerImpl()
