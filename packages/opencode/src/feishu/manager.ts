import { mkdir, readFile, writeFile, rm } from "fs/promises"
import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import z from "zod"
import * as lark from "@larksuiteoapi/node-sdk"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { ModelID } from "@/provider/schema"

const FEISHU_DATA_DIR =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "opencode", "feishu")
    : process.platform === "win32"
      ? join(process.env.APPDATA || homedir(), "opencode", "feishu")
      : join(homedir(), ".local", "share", "opencode", "feishu")
const CONFIG_FILE = join(FEISHU_DATA_DIR, "config.json")
const SESSION_MAP_FILE = join(FEISHU_DATA_DIR, "sessions.json")

export type FeishuStatus = "idle" | "starting" | "connected" | "error"

export interface FeishuConfig {
  appId: string
  appSecret: string
}

export interface FeishuSession {
  connected: boolean
  appId: string
  createdAt: number
}

export const FeishuEvent = {
  StatusChanged: BusEvent.define(
    "feishu.status",
    z.object({
      status: z.enum(["idle", "starting", "connected", "error"]),
      message: z.string().optional(),
    }),
  ),
  Connected: BusEvent.define(
    "feishu.connected",
    z.object({
      appId: z.string(),
    }),
  ),
  Error: BusEvent.define(
    "feishu.error",
    z.object({
      code: z.string(),
      message: z.string(),
    }),
  ),
}

// Session mapping: feishu chat key -> aether session ID
type SessionMap = Record<string, string>

// Model reference: providerID + modelID
interface ModelRef {
  providerID: string
  modelID: string
}

// Flat model entry for listing
interface ModelEntry {
  index: number
  providerID: string
  modelID: string
  name: string
}

class FeishuManagerImpl {
  private wsClient: any = null
  private larkClient: any = null
  private _status: FeishuStatus = "idle"
  private _session: FeishuSession | null = null
  private _error: { code: string; message: string } | null = null
  private sessionMap: SessionMap = {}

  // ── Model state ──────────────────────────────────────────────────────────
  // Snapshot of the model active in the web UI at connect time.
  // Frozen after connection — web UI changes don't affect it.
  private _connectedModel: ModelRef | null = null

  // Per-chat overrides set via /model n. Cleared by /new, not by /stop.
  private _modelOverrides: Record<string, ModelRef> = {}

  // Cached flat model list, built once at connect time (and on demand).
  private _modelList: ModelEntry[] = []
  // ─────────────────────────────────────────────────────────────────────────

  get status() {
    return this._status
  }

  get session() {
    return this._session
  }

  get error() {
    return this._error
  }

  private set status(value: FeishuStatus) {
    this._status = value
    Bus.publish(FeishuEvent.StatusChanged, { status: value })
  }

  private statusMsg(value: FeishuStatus, message: string) {
    this._status = value
    Bus.publish(FeishuEvent.StatusChanged, { status: value, message })
  }

  // ── Model helpers ─────────────────────────────────────────────────────────

  /**
   * Build a flat numbered list of all available models.
   * Used by /model to display options and /model n to select.
   */
  private async buildModelList(): Promise<ModelEntry[]> {
    try {
      const providers = await Provider.list()
      const entries: ModelEntry[] = []
      let index = 1
      for (const [providerID, info] of Object.entries(providers)) {
        for (const [modelID, model] of Object.entries(info.models)) {
          entries.push({ index, providerID, modelID, name: model.name || modelID })
          index++
        }
      }
      return entries
    } catch (err) {
      console.error("[feishu] buildModelList error:", err)
      return []
    }
  }

  /**
   * Resolve the model to use for a given chat.
   * Priority: per-chat override > connection snapshot > undefined (SessionPrompt default)
   */
  private resolveModel(chatId: string): { providerID: ProviderID; modelID: ModelID } | undefined {
    const override = this._modelOverrides[chatId] ?? this._connectedModel
    if (!override) return undefined
    return {
      providerID: ProviderID.make(override.providerID),
      modelID: ModelID.make(override.modelID),
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  async start(
    config?: FeishuConfig,
    model?: ModelRef,
  ): Promise<{
    success: boolean
    message?: string
    code?: string
    status?: string
    appId?: string
  }> {
    if (this.wsClient || this._status === "starting" || this._status === "connected") {
      return { success: false, message: "Feishu bridge is already running" }
    }

    // If no config provided, try loading saved config
    const cfg = config || (await this.loadConfig())
    if (!cfg?.appId || !cfg?.appSecret) {
      this._error = { code: "config_missing", message: "请提供飞书应用的 App ID 和 App Secret" }
      this.status = "error"
      Bus.publish(FeishuEvent.Error, this._error)
      return { success: false, code: "config_missing", message: "请提供飞书应用的 App ID 和 App Secret" }
    }

    this.status = "starting"
    this._error = null

    // Save config for future use
    await this.saveConfig(cfg)

    // Load session map
    this.sessionMap = await this.loadSessionMap()

    void this._doStart(cfg, model ?? null)
    return { success: true }
  }

  private async _doStart(config: FeishuConfig, model: ModelRef | null): Promise<void> {
    try {
      this.statusMsg("starting", "正在连接飞书...")
      console.log("[feishu] _doStart called")

      // Capture Instance context so event callbacks can access Session/Instance APIs
      const boundHandleMessage = Instance.bind((data: any) => {
        console.log("[feishu] >>> event received!")
        void this.handleMessage(data)
      })

      // Create Feishu API client
      this.larkClient = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        disableTokenCache: false,
      })

      // Create event dispatcher
      const eventDispatcher = new lark.EventDispatcher({})
      eventDispatcher.register({
        "im.message.receive_v1": boundHandleMessage,
      })

      // Create WebSocket client with debug logging
      this.wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.debug,
      })

      // eventDispatcher is passed to start(), not constructor
      console.log("[feishu] calling wsClient.start()...")
      await this.wsClient.start({ eventDispatcher })
      console.log("[feishu] wsClient.start() resolved")

      // Use the model passed from the web UI at connect time (frozen until stop)
      this._connectedModel = model
      console.log("[feishu] connected model:", this._connectedModel)

      // Pre-build model list for /model command
      this._modelList = await this.buildModelList()

      this._session = {
        connected: true,
        appId: config.appId,
        createdAt: Date.now(),
      }
      this.status = "connected"
      Bus.publish(FeishuEvent.Connected, { appId: config.appId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._error = { code: "start_failed", message }
      this.status = "error"
      Bus.publish(FeishuEvent.Error, this._error)
    }
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      console.log("[feishu] received event:", JSON.stringify(data).slice(0, 500))
      const message = data?.message
      if (!message) {
        console.log("[feishu] no message in event data, keys:", Object.keys(data || {}))
        return
      }

      const chatId = message.chat_id
      const messageId = message.message_id
      const rootId = message.root_id || message.parent_id || messageId
      console.log("[feishu] message:", { chatId, messageId, type: message.message_type })

      // Only handle text messages for now
      if (message.message_type !== "text") {
        await this.replyText(messageId, "暂时只支持文本消息")
        return
      }

      // Parse message content
      let text: string
      try {
        const content = JSON.parse(message.content)
        text = content.text
      } catch {
        console.log("[feishu] failed to parse message content:", message.content)
        return
      }

      // Strip @mention tags (group chat)
      text = text.replace(/@_\w+\s*/g, "").trim()

      if (!text) return
      console.log("[feishu] text:", text)

      // Handle slash commands
      if (text.startsWith("/")) {
        await this.handleCommand(text, messageId, chatId)
        return
      }

      // Map to Aether session
      const sessionKey = `${chatId}:${rootId}`
      let sessionId = this.sessionMap[sessionKey]

      if (!sessionId) {
        // Reuse the most recent session if available, otherwise create one
        const recent = [...Session.list({ roots: true, limit: 1 })]
        if (recent.length > 0) {
          sessionId = recent[0].id
          console.log("[feishu] reusing existing session:", sessionId)
        } else {
          console.log("[feishu] creating new session...")
          const session = await Session.create({
            title: `飞书对话 ${chatId.slice(-6)}`,
          })
          sessionId = session.id
          console.log("[feishu] session created:", sessionId)
        }
        this.sessionMap[sessionKey] = sessionId
        await this.saveSessionMap()
      }

      // Resolve model: per-chat override > connection snapshot > undefined
      const model = this.resolveModel(chatId)
      console.log("[feishu] using model:", model ?? "(default)")

      // Send to Aether
      console.log("[feishu] sending to aether, session:", sessionId)
      const msg = await SessionPrompt.prompt({
        sessionID: SessionID.make(sessionId),
        parts: [{ type: "text", text }],
        ...(model ? { model } : {}),
      })
      console.log("[feishu] aether responded, parts:", msg?.parts?.length)

      // Extract text response
      const responseText = this.extractResponseText(msg)
      if (responseText) {
        // Build context header so user knows which project/session is active
        const projectName = Instance.directory.split("/").at(-1) ?? Instance.directory
        const sessionInfo = [...Session.list({ roots: true, limit: 100 })].find((s) => s.id === sessionId)
        const sessionTitle = sessionInfo?.title ?? sessionId.slice(0, 8)
        const header = `📁 ${projectName}\n💬 ${sessionTitle}\n${"─".repeat(20)}\n`

        console.log("[feishu] replying:", responseText.slice(0, 100))
        await this.replyText(messageId, header + responseText)
      } else {
        console.log("[feishu] no text in response")
      }
    } catch (err) {
      console.error("[feishu] handleMessage error:", err)
      const messageId = data?.message?.message_id
      if (messageId) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await this.replyText(messageId, `处理消息时出错: ${errMsg}`).catch(() => {})
      }
    }
  }

  private extractResponseText(msg: any): string | null {
    if (!msg?.parts) return null
    const textParts = msg.parts.filter((p: any) => p.type === "text")
    if (textParts.length === 0) return null
    return textParts.map((p: any) => p.text).join("\n")
  }

  // ── Command handlers ──────────────────────────────────────────────────────

  private async handleCommand(text: string, messageId: string, chatId: string): Promise<void> {
    const [cmd, ...args] = text.trim().split(/\s+/)
    const command = cmd.toLowerCase()

    if (command === "/new") {
      await this.cmdNew(messageId, chatId)
    } else if (command === "/model") {
      await this.cmdModel(messageId, chatId, args)
    } else if (command === "/help") {
      await this.replyText(
        messageId,
        "可用命令：\n/new - 开始新对话\n/model - 查看/切换模型\n/help - 显示帮助\n\n直接发送消息即可与 Aether AI 对话。",
      )
    } else {
      await this.replyText(messageId, `未知命令: ${command}\n发送 /help 查看可用命令。`)
    }
  }

  /** /new — clear session and per-chat model override, keep connection snapshot */
  private async cmdNew(messageId: string, chatId: string): Promise<void> {
    // Clear session mapping for this chat
    for (const key of Object.keys(this.sessionMap)) {
      if (key.startsWith(`${chatId}:`)) {
        delete this.sessionMap[key]
      }
    }
    // Clear per-chat model override (connection snapshot stays)
    delete this._modelOverrides[chatId]

    // Create new session immediately so it appears in the web UI right away
    const session = await Session.create({ title: `飞书对话 ${chatId.slice(-6)}` })
    await this.saveSessionMap()
    await this.replyText(messageId, `✅ 已开启新对话\n💬 ${session.title}`)
  }

  /**
   * /model        — list all models with current selection
   * /model <n>    — set per-chat model override to entry n
   */
  private async cmdModel(messageId: string, chatId: string, args: string[]): Promise<void> {
    // Ensure model list is loaded
    if (this._modelList.length === 0) {
      this._modelList = await this.buildModelList()
    }

    if (args.length === 0) {
      // List models
      await this.replyText(messageId, this.formatModelList(chatId))
      return
    }

    const n = parseInt(args[0], 10)
    if (isNaN(n) || n < 1 || n > this._modelList.length) {
      await this.replyText(messageId, `无效编号，请输入 1 到 ${this._modelList.length} 之间的数字。`)
      return
    }

    const entry = this._modelList[n - 1]
    this._modelOverrides[chatId] = { providerID: entry.providerID, modelID: entry.modelID }
    await this.replyText(messageId, `✅ 已切换模型：${entry.providerID}/${entry.modelID}\n（仅对当前对话生效，/new 后将重置）`)
  }

  private formatModelList(chatId: string): string {
    const current = this._modelOverrides[chatId] ?? this._connectedModel
    const currentStr = current ? `${current.providerID}/${current.modelID}` : "（全局默认）"

    const lines: string[] = []
    lines.push(`🤖 当前：${currentStr}`)
    lines.push("")
    lines.push("📦 可用模型：")

    // Group by provider
    const byProvider = new Map<string, ModelEntry[]>()
    for (const entry of this._modelList) {
      const group = byProvider.get(entry.providerID) ?? []
      group.push(entry)
      byProvider.set(entry.providerID, group)
    }

    for (const [providerID, entries] of byProvider) {
      lines.push("")
      lines.push(`【${providerID}】`)
      for (const entry of entries) {
        const active =
          current && current.providerID === entry.providerID && current.modelID === entry.modelID ? " ★" : ""
        lines.push(`  ${entry.index}. ${entry.providerID}/${entry.modelID}${active}`)
      }
    }

    if (this._modelList.length === 0) {
      lines.push("（暂无可用模型，请先在 Aether 中配置 provider）")
    }

    lines.push("")
    lines.push("💡 /model n 切换模型")
    return lines.join("\n")
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async replyText(messageId: string, text: string): Promise<void> {
    if (!this.larkClient) return
    try {
      await this.larkClient.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      })
    } catch (err) {
      console.error("[feishu] reply error:", err)
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      try {
        if (typeof this.wsClient.stop === "function") {
          this.wsClient.stop()
        }
      } catch {}
      this.wsClient = null
      this.larkClient = null
    }
    this._session = null
    this._connectedModel = null
    this._modelOverrides = {}
    this._modelList = []
    this.status = "idle"
  }

  async clearSession(): Promise<void> {
    try {
      await rm(CONFIG_FILE, { force: true })
      await rm(SESSION_MAP_FILE, { force: true })
      this._session = null
      this.sessionMap = {}
    } catch {}
  }

  async loadConfig(): Promise<FeishuConfig | null> {
    try {
      if (existsSync(CONFIG_FILE)) {
        const data = await readFile(CONFIG_FILE, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return null
  }

  private async saveConfig(config: FeishuConfig): Promise<void> {
    await mkdir(FEISHU_DATA_DIR, { recursive: true })
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
  }

  private async loadSessionMap(): Promise<SessionMap> {
    try {
      if (existsSync(SESSION_MAP_FILE)) {
        const data = await readFile(SESSION_MAP_FILE, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return {}
  }

  private async saveSessionMap(): Promise<void> {
    await mkdir(FEISHU_DATA_DIR, { recursive: true })
    await writeFile(SESSION_MAP_FILE, JSON.stringify(this.sessionMap, null, 2))
  }

  async loadSession(): Promise<FeishuSession | null> {
    // Check if there's a saved config (means user has configured before)
    const config = await this.loadConfig()
    if (config && this._session) return this._session
    return null
  }
}

export const FeishuManager = new FeishuManagerImpl()
