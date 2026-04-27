import { readFile, rm } from "fs/promises"
import { existsSync } from "fs"
import { basename } from "path"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { MobileManagerBase } from "./base"
import type { MobileAdapter, MobileStatus, ModelRef } from "./base"

export type QQStatus = "idle" | "starting" | "connected" | "reconnecting" | "error"

export interface QQConfig {
  appId: string
  appSecret: string
}

export interface QQSession {
  connected: boolean
  appId: string
  createdAt: number
}

enum OpCode {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  Resume = 6,
  Reconnect = 7,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatACK = 11,
}

type ChatType = "c2c" | "group"

interface ChatInfo {
  type: ChatType
  openid: string
}

class QQAdapter implements MobileAdapter {
  platform: "qq" = "qq"
  private manager: QQManagerImpl
  private _appId: string = ""
  private _appSecret: string = ""
  private _accessToken: string = ""

  constructor(manager: QQManagerImpl) {
    this.manager = manager
  }

  setCredentials(appId: string, appSecret: string) {
    this._appId = appId
    this._appSecret = appSecret
  }

  async getAccessToken(): Promise<string> {
    const resp = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this._appId, clientSecret: this._appSecret }),
    })
    const data = (await resp.json()) as any
    if (!data.access_token) throw new Error(`QQ token 获取失败: ${JSON.stringify(data)}`)
    this._accessToken = data.access_token
    return data.access_token
  }

  get accessToken() {
    return this._accessToken
  }

  async replyText(messageId: string, text: string): Promise<void> {
    if (!this._accessToken || !this._appId) return
    const chatId = this.manager._currentChatId
    const info = chatId ? this.manager._chatInfos[chatId] : undefined
    if (!info) {
      console.error("[qq] replyText: no chat info", chatId)
      return
    }

    try {
      const token = await this.getAccessToken()
      const url =
        info.type === "c2c"
          ? `https://api.sgroup.qq.com/v2/users/${info.openid}/messages`
          : `https://api.sgroup.qq.com/v2/groups/${info.openid}/messages`
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          msg_type: 0,
          msg_id: messageId,
        }),
      })
      if (!resp.ok) {
        const body = await resp.text()
        console.error("[qq] replyText failed:", resp.status, body)
      }
    } catch (err) {
      console.error("[qq] reply error:", err)
    }
  }

  async replyFile(messageId: string, filePath: string): Promise<void> {
    if (!this._accessToken || !this._appId) return
    const chatId = this.manager._currentChatId
    const info = chatId ? this.manager._chatInfos[chatId] : undefined
    if (!info) return

    try {
      const { stat, readFile } = await import("fs/promises")
      const info2 = await stat(filePath)
      if (info2.size > 30 * 1024 * 1024) return
      const filename = basename(filePath)
      const fileBuffer = await readFile(filePath)
      const token = await this.getAccessToken()

      const form = new FormData()
      form.append("file", new Blob([new Uint8Array(fileBuffer)]), filename)

      const uploadUrl =
        info.type === "c2c"
          ? `https://api.sgroup.qq.com/v2/users/${info.openid}/files`
          : `https://api.sgroup.qq.com/v2/groups/${info.openid}/files`
      const uploadResp = await fetch(uploadUrl, {
        method: "POST",
        headers: { Authorization: `QQBot ${token}` },
        body: form,
      })
      const uploadData = (await uploadResp.json()) as any
      const fileUuid = uploadData?.file_uuid ?? uploadData?.uuid
      if (!fileUuid) {
        console.error("[qq] file upload failed:", JSON.stringify(uploadData))
        return
      }

      const msgUrl =
        info.type === "c2c"
          ? `https://api.sgroup.qq.com/v2/users/${info.openid}/messages`
          : `https://api.sgroup.qq.com/v2/groups/${info.openid}/messages`
      await fetch(msgUrl, {
        method: "POST",
        headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          msg_type: 7,
          msg_id: messageId,
          media: { file_info: fileUuid },
        }),
      })
      console.log("[qq] sent file:", filename)
    } catch (err) {
      console.error("[qq] replyFile error:", filePath, err)
    }
  }

  async loadConfig(): Promise<QQConfig | null> {
    try {
      const next = this.manager.file("config.json")
      const prev = this.manager.readPath("config.json")
      const path = existsSync(next) || !existsSync(prev) ? next : prev
      if (existsSync(path)) {
        const data = await readFile(path, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return null
  }

  async clearAuth(): Promise<void> {
    try {
      await rm(this.manager.file("config.json"), { force: true })
    } catch {}
  }

  async loadSession(): Promise<QQSession | null> {
    const config = await this.loadConfig()
    if (config && this.manager._qqSession) return this.manager._qqSession
    return null
  }
}

class QQManagerImpl extends MobileManagerBase {
  private ws: WebSocket | null = null
  public _qqSession: QQSession | null = null
  public _chatInfos: Record<string, ChatInfo> = {}
  public _currentChatId: string = ""
  private _heartbeat: ReturnType<typeof setInterval> | null = null
  private _heartbeatInterval: number = 30000
  private _sessionId: string = ""
  private _lastSeq: number | null = null
  private _reconnect: ReturnType<typeof setTimeout> | null = null
  private _reconnectCount = 0
  private _lastConfig: QQConfig | null = null
  private _identified = false

  private static readonly RECONNECT_MAX_MS = 300_000

  private qqAdapter: QQAdapter

  constructor() {
    super(new QQAdapter({} as any))
    this.qqAdapter = new QQAdapter(this)
    this.adapter = this.qqAdapter
  }

  override platformDir() {
    return "qq"
  }

  override platformName() {
    return "QQ"
  }

  get session() {
    return this._qqSession
  }

  async start(
    config?: QQConfig,
    model?: ModelRef,
  ): Promise<{ success: boolean; message?: string; code?: string; status?: string; appId?: string }> {
    if (this.ws || this._starting || ["starting", "connected", "reconnecting"].includes(this._status)) {
      return { success: false, message: "QQ bridge is already running" }
    }

    const cfg = config || (await this.qqAdapter.loadConfig())
    if (!cfg?.appId || !cfg?.appSecret) {
      this._error = { code: "config_missing", message: "请提供 QQ 机器人的 App ID 和 App Secret" }
      this.status = "error"
      Bus.publish(this.busEvents.Error, this._error)
      return { success: false, code: "config_missing", message: "请提供 QQ 机器人的 App ID 和 App Secret" }
    }

    this.status = "starting"
    this._error = null
    this._manualStop = false
    this._lastConfig = cfg

    await this.saveConfig(cfg)
    this.sessionMap = await this.loadSessionMap()
    this._hiddenDirs = await this.loadHiddenDirs()
    void this._doStart(cfg, model ?? null)
    return { success: true }
  }

  private async saveConfig(config: QQConfig): Promise<void> {
    const { mkdir, writeFile } = await import("fs/promises")
    await mkdir(this.dir(), { recursive: true })
    await writeFile(this.file("config.json"), JSON.stringify(config, null, 2))
  }

  private async _doStart(config: QQConfig, model: ModelRef | null): Promise<void> {
    this._starting = true
    try {
      this.statusMsg("starting", "正在连接QQ...")
      console.log("[qq] _doStart called")

      this.qqAdapter.setCredentials(config.appId, config.appSecret)
      const token = await this.qqAdapter.getAccessToken()
      console.log("[qq] access token obtained")

      const gatewayResp = await fetch("https://api.sgroup.qq.com/gateway", {
        headers: { Authorization: `QQBot ${token}` },
      })
      const gatewayData = (await gatewayResp.json()) as any
      const wssUrl = gatewayData?.url
      if (!wssUrl) throw new Error(`获取 WebSocket 网关失败: ${JSON.stringify(gatewayData)}`)
      console.log("[qq] gateway url:", wssUrl)

      this.ws = new WebSocket(wssUrl)
      this._identified = false
      this._lastSeq = null

      this.ws.addEventListener("open", () => {
        console.log("[qq] ws open", localISOString())
      })

      this.ws.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data as string)
          this.handleWsMessage(payload)
        } catch (err) {
          console.error("[qq] ws message parse error:", err)
        }
      })

      this.ws.addEventListener("close", (event) => {
        console.log("[qq] ws close:", event.code, event.reason, localISOString())
        if (this._identified) this.onDisconnect(`ws_close_${event.code}`)
      })

      this.ws.addEventListener("error", () => {
        console.log("[qq] ws error", localISOString())
        if (this._identified) this.onDisconnect("ws_error")
      })

      await this.waitForIdentify()

      this._connectedModel = model
      this._reconnectCount = 0

      this._modelList = await this.buildModelList()
      this.subscribeBusEvents()

      this._qqSession = { connected: true, appId: config.appId, createdAt: Date.now() }
      this.startWsHeartbeat()
      this.status = "connected"
      Bus.publish(this.busEvents.Connected, { appId: config.appId })

      const allProjects = this.getProjects()
      const visibleProjects = allProjects.filter((p) => !(this.projectDir(p) in this._hiddenDirs))
      this._initialDir = visibleProjects.length > 0 ? this.projectDir(visibleProjects[0]) : Instance.directory
      console.log("[qq] initial dir:", this._initialDir)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._error = { code: "start_failed", message }
      this.status = "error"
      Bus.publish(this.busEvents.Error, this._error)
      if (!this._manualStop) this.scheduleReconnect(message)
    } finally {
      this._starting = false
    }
  }

  private waitForIdentify(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("QQ WebSocket 连接超时"))
      }, 30_000)

      const handleMessage = (event: { data: string | Buffer | ArrayBuffer | Buffer[] }) => {
        try {
          const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
          const payload = JSON.parse(raw)
          if (payload.op === OpCode.Dispatch && payload.t === "READY") {
            clearTimeout(timeout)
            this.ws!.removeEventListener("message", handleMessage)
            this._sessionId = payload.d?.session_id ?? ""
            this._identified = true
            if (payload.s) this._lastSeq = payload.s
            resolve()
          } else if (payload.op === OpCode.Hello) {
            this._heartbeatInterval = payload.d?.heartbeat_interval ?? 30000
            const token = this.qqAdapter.accessToken
            this.ws!.send(
              JSON.stringify({
                op: OpCode.Identify,
                d: {
                  token: `QQBot ${token}`,
                  intents: 1 << 25,
                  shard: [0, 1],
                },
              }),
            )
          } else if (payload.op === OpCode.InvalidSession) {
            clearTimeout(timeout)
            this.ws!.removeEventListener("message", handleMessage)
            reject(new Error("QQ 鉴权失败 (Invalid Session)"))
          } else if (payload.op === OpCode.Reconnect) {
            clearTimeout(timeout)
            this.ws!.removeEventListener("message", handleMessage)
            reject(new Error("QQ 要求重连"))
          }
        } catch {}
      }

      this.ws!.addEventListener("message", handleMessage)
    })
  }

  private handleWsMessage(payload: any): void {
    if (payload.s) this._lastSeq = payload.s

    switch (payload.op) {
      case OpCode.Dispatch:
        this.handleDispatch(payload)
        break
      case OpCode.HeartbeatACK:
        console.log("[qq] heartbeat ack", localISOString())
        break
      case OpCode.Reconnect:
        console.log("[qq] reconnect requested", localISOString())
        this.onDisconnect("reconnect_requested")
        break
      case OpCode.InvalidSession:
        console.log("[qq] invalid session", localISOString())
        this.onDisconnect("invalid_session")
        break
      case OpCode.Hello:
        this._heartbeatInterval = payload.d?.heartbeat_interval ?? 30000
        break
    }
  }

  private handleDispatch(payload: any): void {
    const eventType = payload.t
    const data = payload.d

    if (eventType === "C2C_MESSAGE_CREATE") {
      this.handleC2CMessage(data)
    } else if (eventType === "GROUP_AT_MESSAGE_CREATE") {
      this.handleGroupMessage(data)
    }
  }

  private handleC2CMessage(data: any): void {
    const content = data?.content ?? ""
    const messageId = data?.id ?? ""
    const openId = data?.author?.user_openid ?? ""

    if (!messageId || !openId) return

    const text = content.trim()
    if (!text) return

    const chatId = `c2c_${openId}`
    this._chatInfos[chatId] = { type: "c2c", openid: openId }

    if (!this.enqueueMessage(chatId, messageId)) return

    this._currentChatId = chatId
    const rootId = messageId
    void this.handleMessage(chatId, messageId, text, rootId)
  }

  private handleGroupMessage(data: any): void {
    const content = data?.content ?? ""
    const messageId = data?.id ?? ""
    const groupOpenId = data?.group_openid ?? ""

    if (!messageId || !groupOpenId) return

    let text = content.trim()
    text = text.replace(/@\S+\s*/g, "").trim()
    if (!text) return

    const chatId = `group_${groupOpenId}`
    this._chatInfos[chatId] = { type: "group", openid: groupOpenId }

    if (!this.enqueueMessage(chatId, messageId)) return

    this._currentChatId = chatId
    const rootId = messageId
    void this.handleMessage(chatId, messageId, text, rootId)
  }

  private startWsHeartbeat(): void {
    this.stopWsHeartbeat()
    this._heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: OpCode.Heartbeat, d: this._lastSeq }))
      }
    }, this._heartbeatInterval)
  }

  private stopWsHeartbeat(): void {
    if (!this._heartbeat) return
    clearInterval(this._heartbeat)
    this._heartbeat = null
  }

  private onDisconnect(reason: string): void {
    if (this._manualStop) return
    if (this._status === "idle" || this._status === "error") return
    console.warn("[qq] disconnect detected:", reason, localISOString())
    this.stopWsHeartbeat()
    this.scheduleReconnect(reason)
  }

  private scheduleReconnect(reason: string): void {
    if (this._manualStop || !this._lastConfig) return
    if (this._reconnect || this._status === "reconnecting") return
    const attempt = this._reconnectCount + 1
    const delay = Math.min(2_000 * 2 ** this._reconnectCount, QQManagerImpl.RECONNECT_MAX_MS)
    this._reconnectCount = attempt
    this.statusMsg("reconnecting", `QQ连接已断开，正在重连（第 ${attempt} 次）...`)
    Bus.publish(this.busEvents.Reconnecting, { attempt, delay })
    this._reconnect = setTimeout(() => {
      this._reconnect = null
      void this.restartAfterDisconnect(reason)
    }, delay)
  }

  private async restartAfterDisconnect(reason: string): Promise<void> {
    if (this._manualStop || !this._lastConfig) return
    console.log("[qq] reconnecting after:", reason)
    await this.cleanupConnection(false)
    await this._doStart(this._lastConfig, this._connectedModel)
  }

  private async cleanupConnection(reset = true): Promise<void> {
    this.stopWsHeartbeat()
    if (this._reconnect) {
      clearTimeout(this._reconnect)
      this._reconnect = null
    }
    this.unsubscribeBusEvents()
    if (this.ws) {
      const prev = this._manualStop
      this._manualStop = true
      try {
        this.ws.close()
      } catch {}
      this._manualStop = prev
      this.ws = null
    }
    this._qqSession = null
    this._modelList = []
    this._pendingQuestions = {}
    this._questionProgress = {}
    this._pendingPermissions = {}
    this._pendingConfirmCreate = {}
    this._activePrompt.clear()
    this._chatInfos = {}
    if (!reset) return
    this._connectedModel = null
    this._chatDirs = {}
    this._chatSessions = {}
    this._initialDir = ""
    this.status = "idle"
  }

  async stop(): Promise<void> {
    this._manualStop = true
    this._reconnectCount = 0
    await this.cleanupConnection()
  }

  override async clearSession(): Promise<void> {
    try {
      const { rm } = await import("fs/promises")
      await rm(this.file("config.json"), { force: true })
      await rm(this.file("sessions.json"), { force: true })
      await rm(this.file("hidden_projects.json"), { force: true })
      this._qqSession = null
      this.sessionMap = {}
      this._hiddenDirs = {}
    } catch {}
    await this.qqAdapter.clearAuth()
  }
}

function localISOString(d = new Date()): string {
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0")
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds()) +
    sign +
    pad(offset / 60) +
    ":" +
    pad(offset % 60)
  )
}

export const QQManager = new QQManagerImpl()
