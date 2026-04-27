import { readFile, rm } from "fs/promises"
import { existsSync } from "fs"
import { basename } from "path"
import * as lark from "@larksuiteoapi/node-sdk"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { MobileManagerBase } from "./base"
import type { MobileAdapter, MobileStatus, ModelRef } from "./base"

export type FeishuStatus = "idle" | "starting" | "connected" | "reconnecting" | "error"

export interface FeishuConfig {
  appId: string
  appSecret: string
}

export interface FeishuSession {
  connected: boolean
  appId: string
  createdAt: number
}

class FeishuAdapter implements MobileAdapter {
  platform: "feishu" = "feishu"
  private manager: FeishuManagerImpl
  private larkClient: any = null
  private _appId: string = ""
  private _appSecret: string = ""

  constructor(manager: FeishuManagerImpl) {
    this.manager = manager
  }

  setClient(client: any) {
    this.larkClient = client
  }

  setCredentials(appId: string, appSecret: string) {
    this._appId = appId
    this._appSecret = appSecret
  }

  async replyText(messageId: string, text: string): Promise<void> {
    if (!this.larkClient) return
    try {
      await this.larkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text }) },
      })
    } catch (err) {
      console.error("[feishu] reply error:", err)
    }
  }

  async replyFile(messageId: string, filePath: string): Promise<void> {
    if (!this._appId) return
    try {
      const { stat, readFile } = await import("fs/promises")
      const info = await stat(filePath)
      if (info.size > 30 * 1024 * 1024) return
      const filename = basename(filePath)
      const fileBuffer = await readFile(filePath)
      const token = await this.getTenantAccessToken()

      const ext = (filename.split(".").pop() ?? "").toLowerCase()
      const typeMap: Record<string, string> = {
        pdf: "pdf",
        doc: "doc",
        docx: "doc",
        xls: "xls",
        xlsx: "xls",
        ppt: "ppt",
        pptx: "ppt",
      }
      const fileType = typeMap[ext] ?? "stream"

      const form = new FormData()
      form.append("file_type", fileType)
      form.append("file_name", filename)
      form.append("file", new Blob([new Uint8Array(fileBuffer)]), filename)

      const uploadResp = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const uploadData = (await uploadResp.json()) as any
      const fileKey = uploadData?.data?.file_key
      if (!fileKey) {
        console.error("[feishu] file upload failed:", JSON.stringify(uploadData))
        return
      }

      await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "file", content: JSON.stringify({ file_key: fileKey }) }),
      })
      console.log("[feishu] sent file:", filename)
    } catch (err) {
      console.error("[feishu] replyFile error:", filePath, err)
    }
  }

  async getTenantAccessToken(): Promise<string> {
    const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this._appId, app_secret: this._appSecret }),
    })
    const data = (await resp.json()) as any
    if (!data.tenant_access_token) throw new Error(`获取 token 失败: ${JSON.stringify(data)}`)
    return data.tenant_access_token
  }

  async loadConfig(): Promise<FeishuConfig | null> {
    try {
      const next = this.manager.file("config.json")
      const prev = this.manager.readPath("config.json")
      const configPath = existsSync(next) || !existsSync(prev) ? next : prev
      if (existsSync(configPath)) {
        const data = await readFile(configPath, "utf-8")
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

  async loadSession(): Promise<FeishuSession | null> {
    const config = await this.loadConfig()
    if (config && this.manager._feishuSession) return this.manager._feishuSession
    return null
  }
}

class FeishuManagerImpl extends MobileManagerBase {
  private wsClient: any = null
  public _feishuSession: FeishuSession | null = null
  private _heartbeat: ReturnType<typeof setInterval> | null = null
  private _heartbeatFails = 0
  private _reconnect: ReturnType<typeof setTimeout> | null = null
  private _reconnectCount = 0
  private _lastConfig: FeishuConfig | null = null
  private _lastWsEventTime: number = 0

  private static readonly HEARTBEAT_MS = 30_000
  private static readonly HEARTBEAT_FAILS = 3
  private static readonly RECONNECT_MAX_MS = 300_000

  private feishuAdapter: FeishuAdapter

  constructor() {
    super(new FeishuAdapter({} as any))
    this.feishuAdapter = new FeishuAdapter(this)
    this.adapter = this.feishuAdapter
  }

  override platformDir() {
    return "feishu"
  }

  override platformName() {
    return "飞书"
  }

  get session() {
    return this._feishuSession
  }

  async start(
    config?: FeishuConfig,
    model?: ModelRef,
  ): Promise<{ success: boolean; message?: string; code?: string; status?: string; appId?: string }> {
    if (this.wsClient || this._starting || ["starting", "connected", "reconnecting"].includes(this._status)) {
      return { success: false, message: "Feishu bridge is already running" }
    }

    const cfg = config || (await this.feishuAdapter.loadConfig())
    if (!cfg?.appId || !cfg?.appSecret) {
      this._error = { code: "config_missing", message: "请提供飞书应用的 App ID 和 App Secret" }
      this.status = "error"
      Bus.publish(this.busEvents.Error, this._error)
      return { success: false, code: "config_missing", message: "请提供飞书应用的 App ID 和 App Secret" }
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

  private async saveConfig(config: FeishuConfig): Promise<void> {
    const { mkdir, writeFile } = await import("fs/promises")
    await mkdir(this.dir(), { recursive: true })
    await writeFile(this.file("config.json"), JSON.stringify(config, null, 2))
  }

  private async _doStart(config: FeishuConfig, model: ModelRef | null): Promise<void> {
    this._starting = true
    this._initialized = false
    try {
      this.statusMsg("starting", "正在初始化...")
      console.log("[feishu] _doStart called")

      await this.initSessions()

      this.statusMsg("starting", "正在连接飞书...")

      const boundHandleMessage = (data: any) => {
        const gap = this._lastWsEventTime ? `gap=${Date.now() - this._lastWsEventTime}ms` : "first"
        this._lastWsEventTime = Date.now()
        console.log("[feishu] >>> event received!", gap, localISOString())

        const message = data?.message
        if (!message) return

        const chatId = message.chat_id
        const messageId = message.message_id
        const rootId = message.root_id || message.parent_id || messageId
        const chatType = message.chat_type

        if (chatType === "group") {
          const mentions = message.mentions
          if (!mentions || !Array.isArray(mentions) || mentions.length === 0) return
        }

        if (message.message_type !== "text") {
          void this.adapter.replyText(messageId, "暂时只支持文本消息")
          return
        }

        let text: string
        try {
          const content = JSON.parse(message.content)
          text = content.text
        } catch {
          return
        }

        text = text.replace(/@_\w+\s*/g, "").trim()
        if (!text) return

        if (!this.enqueueMessage(chatId, messageId)) return
        void this.handleMessage(chatId, messageId, text, rootId)
      }

      this.feishuAdapter.setCredentials(config.appId, config.appSecret)
      this.feishuAdapter.setClient(
        new lark.Client({
          appId: config.appId,
          appSecret: config.appSecret,
          disableTokenCache: false,
        }),
      )

      const eventDispatcher = new lark.EventDispatcher({})
      eventDispatcher.register({
        "im.message.receive_v1": Instance.bind(boundHandleMessage),
      })

      this.wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.debug,
      })
      this.bindLifecycle(this.wsClient)

      console.log("[feishu] calling wsClient.start()...")
      await this.wsClient.start({ eventDispatcher })
      console.log("[feishu] wsClient.start() resolved")

      this._connectedModel = model
      this._reconnectCount = 0

      this._modelList = await this.buildModelList()

      this.subscribeBusEvents()

      this._feishuSession = { connected: true, appId: config.appId, createdAt: Date.now() }
      this.startHeartbeat()
      this.status = "connected"
      Bus.publish(this.busEvents.Connected, { appId: config.appId })
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

  private bindLifecycle(client: any): void {
    const on = client?.on?.bind(client)
    if (typeof on === "function") {
      on("close", () => this.onDisconnect("ws_close"))
      on("error", (err: unknown) => this.onDisconnect(err instanceof Error ? err.message : "ws_error"))
    }

    const bind = () => {
      const ws = client?.ws
      if (!ws || ws.__aetherBound) return
      ws.__aetherBound = true
      const add = ws.addEventListener?.bind(ws) ?? ws.on?.bind(ws)
      if (typeof add === "function") {
        add("close", () => {
          console.log("[feishu] socket close", localISOString())
          this.onDisconnect("socket_close")
        })
        add("error", () => this.onDisconnect("socket_error"))
      }
    }

    bind()
    const connect = client?.connect?.bind(client)
    if (typeof connect !== "function") return
    client.connect = async (...args: any[]) => {
      const result = await connect(...args)
      bind()
      return result
    }
  }

  private onDisconnect(reason: string): void {
    if (this._manualStop) return
    if (this._status === "idle" || this._status === "error") return
    console.warn("[feishu] disconnect detected:", reason, localISOString())
    this.stopHeartbeat()
    this.scheduleReconnect(reason)
  }

  private scheduleReconnect(reason: string): void {
    if (this._manualStop || !this._lastConfig) return
    if (this._reconnect || this._status === "reconnecting") return
    const attempt = this._reconnectCount + 1
    const delay = Math.min(2_000 * 2 ** this._reconnectCount, FeishuManagerImpl.RECONNECT_MAX_MS)
    this._reconnectCount = attempt
    this.statusMsg("reconnecting", `飞书连接已断开，正在重连（第 ${attempt} 次）...`)
    Bus.publish(this.busEvents.Reconnecting, { attempt, delay })
    this._reconnect = setTimeout(() => {
      this._reconnect = null
      void this.restartAfterDisconnect(reason)
    }, delay)
  }

  private async restartAfterDisconnect(reason: string): Promise<void> {
    if (this._manualStop || !this._lastConfig) return
    console.log("[feishu] reconnecting after:", reason)
    await this.cleanupConnection(false)
    await this._doStart(this._lastConfig, this._connectedModel)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this._heartbeatFails = 0
    this._heartbeat = setInterval(() => void this.checkHeartbeat(), FeishuManagerImpl.HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (!this._heartbeat) return
    clearInterval(this._heartbeat)
    this._heartbeat = null
  }

  private async checkHeartbeat(): Promise<void> {
    if (this._manualStop || this._status !== "connected") return
    try {
      await this.feishuAdapter.getTenantAccessToken()
      this._heartbeatFails = 0
    } catch (err) {
      this._heartbeatFails += 1
      console.warn("[feishu] heartbeat failed:", this._heartbeatFails, err)
      if (this._heartbeatFails < FeishuManagerImpl.HEARTBEAT_FAILS) return
      this.onDisconnect("heartbeat_failed")
    }
  }

  private async cleanupConnection(reset = true): Promise<void> {
    this.stopHeartbeat()
    if (this._reconnect) {
      clearTimeout(this._reconnect)
      this._reconnect = null
    }
    this.unsubscribeBusEvents()
    if (this.wsClient) {
      const prev = this._manualStop
      this._manualStop = true
      try {
        if (typeof this.wsClient.close === "function") await this.wsClient.close()
      } catch {}
      this._manualStop = prev
      this.wsClient = null
    }
    this.feishuAdapter.setClient(null)
    this._feishuSession = null
    this._modelList = []
    this._pendingQuestions = {}
    this._questionProgress = {}
    this._pendingPermissions = {}
    this._pendingConfirmCreate = {}
    this._activePrompt.clear()
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
      this._feishuSession = null
      this.sessionMap = {}
      this._hiddenDirs = {}
    } catch {}
    await this.feishuAdapter.clearAuth()
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

export const FeishuManager = new FeishuManagerImpl()
