import { mkdir, readFile, writeFile, rm } from "fs/promises"
import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import z from "zod"
import * as lark from "@larksuiteoapi/node-sdk"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Instance } from "@/project/instance"
import { Project } from "@/project/project"
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
const HIDDEN_DIRS_FILE = join(FEISHU_DATA_DIR, "hidden_projects.json")

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
  // Snapshot of the model active in the web UI at connect time (frozen).
  private _connectedModel: ModelRef | null = null
  // Per-chat overrides set via /model n. Cleared by /new.
  private _modelOverrides: Record<string, ModelRef> = {}
  // Cached flat model list, built once at connect time (and on demand).
  private _modelList: ModelEntry[] = []
  // ─────────────────────────────────────────────────────────────────────────

  // ── Project state ─────────────────────────────────────────────────────────
  // Per-chat current directory (set by /project n). Empty = use connect-time Instance.directory.
  private _chatDirs: Record<string, string> = {}
  // Hidden project directories: directory -> timestamp when hidden. Persisted to disk.
  private _hiddenDirs: Record<string, number> = {}
  // GlobalBus listener for detecting web UI activity on hidden projects.
  private _globalBusListener: ((event: { directory?: string; payload: any }) => void) | null = null
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

  // ── Project helpers (mirrors WeChat _get_projects / _project_dir / _project_name) ──

  private normDir(dir: string): string {
    const text = (dir || "").replace(/\\/g, "/")
    if (!text) return ""
    if (/^\/+$/.test(text)) return "/"
    if (/^[A-Za-z]:\/?$/.test(text)) return `${text[0].toLowerCase()}:/`
    return text.replace(/\/+$/, "")
  }

  private isRootDir(dir: string): boolean {
    const text = this.normDir(dir)
    if (text === "/") return true
    return /^[a-z]:\//.test(text) && text.length <= 3
  }

  private projectDir(item: Project.RecentInfo): string {
    return this.normDir(item.directory || item.worktree || "")
  }

  private projectName(item: Project.RecentInfo): string {
    const dir = this.projectDir(item)
    return item.name || dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) || dir
  }

  private clip(text: string, limit: number): string {
    if (text.length <= limit) return text
    return text.slice(0, limit - 3).trimEnd() + "..."
  }

  /** Same data source as WeChat: GET /project/recent → Project.recentList() */
  private getProjects(): Project.RecentInfo[] {
    return Project.recentList().filter((item) => {
      const dir = this.projectDir(item)
      return dir && !this.isRootDir(dir)
    })
  }

  /**
   * Check all hidden projects against current time.activity.
   * If a project has new activity (from any source: Feishu or web UI) since it was hidden,
   * automatically restore it. Mirrors WeChat's auto-unhide logic.
   * Called on every incoming message so web UI activity is also detected promptly.
   */
  private async autoUnhide(): Promise<void> {
    if (Object.keys(this._hiddenDirs).length === 0) return
    const allProjects = this.getProjects()
    let changed = false
    for (const [directory, hideTime] of Object.entries(this._hiddenDirs)) {
      const item = allProjects.find((p) => this.projectDir(p) === directory)
      const activity = item?.time?.activity ?? 0
      if (activity > hideTime) {
        delete this._hiddenDirs[directory]
        changed = true
        console.log("[feishu] auto-restored hidden project:", directory)
      }
    }
    if (changed) await this.saveHiddenDirs()
  }

  // ── Model helpers ─────────────────────────────────────────────────────────

  private async buildModelList(): Promise<ModelEntry[]> {
    try {
      const providers = await Provider.list()
      const entries: ModelEntry[] = []
      let index = 1
      for (const [providerID, info] of Object.entries(providers)) {
        for (const [modelID, model] of Object.entries(info.models)) {
          entries.push({ index, providerID, modelID, name: (model as any).name || modelID })
          index++
        }
      }
      return entries
    } catch (err) {
      console.error("[feishu] buildModelList error:", err)
      return []
    }
  }

  /** Three-level model resolution: per-chat override → connection snapshot → undefined */
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

    const cfg = config || (await this.loadConfig())
    if (!cfg?.appId || !cfg?.appSecret) {
      this._error = { code: "config_missing", message: "请提供飞书应用的 App ID 和 App Secret" }
      this.status = "error"
      Bus.publish(FeishuEvent.Error, this._error)
      return { success: false, code: "config_missing", message: "请提供飞书应用的 App ID 和 App Secret" }
    }

    this.status = "starting"
    this._error = null

    await this.saveConfig(cfg)
    this.sessionMap = await this.loadSessionMap()
    this._hiddenDirs = await this.loadHiddenDirs()

    void this._doStart(cfg, model ?? null)
    return { success: true }
  }

  private async _doStart(config: FeishuConfig, model: ModelRef | null): Promise<void> {
    try {
      this.statusMsg("starting", "正在连接飞书...")
      console.log("[feishu] _doStart called")

      const boundHandleMessage = Instance.bind((data: any) => {
        console.log("[feishu] >>> event received!")
        void this.handleMessage(data)
      })

      this.larkClient = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        disableTokenCache: false,
      })

      const eventDispatcher = new lark.EventDispatcher({})
      eventDispatcher.register({
        "im.message.receive_v1": boundHandleMessage,
      })

      this.wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.debug,
      })

      console.log("[feishu] calling wsClient.start()...")
      await this.wsClient.start({ eventDispatcher })
      console.log("[feishu] wsClient.start() resolved")

      this._connectedModel = model
      console.log("[feishu] connected model:", this._connectedModel)

      this._modelList = await this.buildModelList()

      // Listen to all Bus events across instances.
      // If any event comes from a hidden project directory, auto-unhide it.
      // This catches web UI activity on hidden projects without polling.
      this._globalBusListener = (event) => {
        const dir = event.directory ? this.normDir(event.directory) : null
        if (!dir || !(dir in this._hiddenDirs)) return
        delete this._hiddenDirs[dir]
        console.log("[feishu] auto-unhide via GlobalBus activity:", dir)
        void this.saveHiddenDirs()
      }
      GlobalBus.on("event", this._globalBusListener)

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

      // Check for hidden projects with new activity (web UI or prior Feishu messages)
      await this.autoUnhide()

      const chatId = message.chat_id
      const messageId = message.message_id
      const rootId = message.root_id || message.parent_id || messageId
      console.log("[feishu] message:", { chatId, messageId, type: message.message_type })

      if (message.message_type !== "text") {
        await this.replyText(messageId, "暂时只支持文本消息")
        return
      }

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

      // Effective directory for this chat (may differ from connect-time Instance.directory)
      const effectiveDir = this._chatDirs[chatId] ?? Instance.directory

      // Feishu message to a hidden project → unhide immediately
      if (effectiveDir in this._hiddenDirs) {
        delete this._hiddenDirs[effectiveDir]
        console.log("[feishu] auto-unhide via Feishu message:", effectiveDir)
        void this.saveHiddenDirs()
      }

      // Run session lookup and AI prompt in the effective directory's Instance context
      await Instance.provide({
        directory: effectiveDir,
        fn: async () => {
          const sessionKey = `${chatId}:${rootId}`
          let sessionId = this.sessionMap[sessionKey]

          if (!sessionId) {
            // Reuse most recent session in this directory, or create one
            const recent = [...Session.list({ directory: effectiveDir, roots: true, limit: 1 })]
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

          const model = this.resolveModel(chatId)
          console.log("[feishu] using model:", model ?? "(default)")

          console.log("[feishu] sending to aether, session:", sessionId)
          const msg = await SessionPrompt.prompt({
            sessionID: SessionID.make(sessionId),
            parts: [{ type: "text", text }],
            ...(model ? { model } : {}),
          })
          console.log("[feishu] aether responded, parts:", msg?.parts?.length)

          const responseText = this.extractResponseText(msg)
          if (responseText) {
            const projectName = effectiveDir.split("/").at(-1) ?? effectiveDir
            const sessionInfo = [...Session.list({ directory: effectiveDir, roots: true, limit: 100 })].find(
              (s) => s.id === sessionId,
            )
            const sessionTitle = sessionInfo?.title ?? sessionId.slice(0, 8)
            const header = `📁 ${projectName}\n💬 ${sessionTitle}\n${"─".repeat(20)}\n`

            console.log("[feishu] replying:", responseText.slice(0, 100))
            await this.replyText(messageId, header + responseText)
          } else {
            console.log("[feishu] no text in response")
          }
        },
      })
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
    const parts = text.trim().split(/\s+/)
    const command = parts[0].toLowerCase()
    const rest = parts.slice(1).join(" ")

    if (command === "/new") {
      await this.cmdNew(messageId, chatId)
    } else if (command === "/model") {
      await this.cmdModel(messageId, chatId, parts.slice(1))
    } else if (command === "/project") {
      await this.cmdProject(messageId, chatId, rest)
    } else if (command === "/help") {
      await this.replyText(
        messageId,
        "可用命令：\n/new - 开始新对话\n/model - 查看/切换模型\n/project - 查看/切换项目\n/help - 显示帮助\n\n直接发送消息即可与 Aether AI 对话。",
      )
    } else {
      await this.replyText(messageId, `未知命令: ${command}\n发送 /help 查看可用命令。`)
    }
  }

  /** /new — clear session and per-chat model override, keep connection snapshot */
  private async cmdNew(messageId: string, chatId: string): Promise<void> {
    for (const key of Object.keys(this.sessionMap)) {
      if (key.startsWith(`${chatId}:`)) delete this.sessionMap[key]
    }
    delete this._modelOverrides[chatId]

    const effectiveDir = this._chatDirs[chatId] ?? Instance.directory
    const session = await Instance.provide({
      directory: effectiveDir,
      fn: () => Session.create({ title: `飞书对话 ${chatId.slice(-6)}` }),
    })
    await this.saveSessionMap()
    await this.replyText(messageId, `✅ 已开启新对话\n💬 ${session.title}`)
  }

  /**
   * /model        — list all models with current selection
   * /model <n>    — set per-chat model override to entry n
   */
  private async cmdModel(messageId: string, chatId: string, args: string[]): Promise<void> {
    if (this._modelList.length === 0) {
      this._modelList = await this.buildModelList()
    }

    if (args.length === 0) {
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

  /**
   * /project            — list top-10 non-hidden projects (current marked ◀)
   * /project list       — list ALL projects including hidden ones
   * /project <n>        — switch to project n
   * /project hide <n>   — hide project n
   */
  private async cmdProject(messageId: string, chatId: string, arg: string): Promise<void> {
    const allProjects = this.getProjects()
    if (allProjects.length === 0) {
      await this.replyText(messageId, "❌ 无法获取项目列表，请检查 Aether 是否正常运行。")
      return
    }

    // autoUnhide already ran at message entry; run again here to catch
    // activity created by the current message batch before /project was typed
    await this.autoUnhide()

    const visibleProjects = allProjects.filter((p) => !(this.projectDir(p) in this._hiddenDirs))
    const currentDir = this._chatDirs[chatId] ?? Instance.directory

    // /project hide <n>
    if (arg.startsWith("hide ")) {
      const delArg = arg.slice(5).trim()
      const idx = parseInt(delArg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= allProjects.length) {
        await this.replyText(messageId, `❌ 用法：/project hide n（n 为 1~${allProjects.length}）`)
        return
      }
      const target = allProjects[idx]
      const directory = this.projectDir(target)
      this._hiddenDirs[directory] = Date.now()
      await this.saveHiddenDirs()
      const name = this.projectName(target)
      await this.replyText(messageId, `✅ 已隐藏：${name}\n（在桌面端或飞书端重新使用后自动恢复）`)
      return
    }

    // /project list — all projects including hidden
    if (arg === "list") {
      const currentItem = allProjects.find((p) => this.projectDir(p) === currentDir) ?? allProjects[0]
      const lines = [
        `📂 当前项目：${this.clip(this.projectName(currentItem), 24)}`,
        "",
        "📂 项目列表：",
        "",
      ]
      for (let i = 0; i < allProjects.length; i++) {
        const item = allProjects[i]
        const directory = this.projectDir(item)
        const tag = directory === currentDir ? " ◀" : ""
        const mark = directory in this._hiddenDirs ? " [已隐藏]" : ""
        lines.push(`${i + 1}. ${this.projectName(item)}${tag}${mark}`)
        lines.push(`   ${directory}`)
      }
      await this.replyText(messageId, lines.join("\n"))
      return
    }

    // /project <n> — switch to project n (1-indexed into allProjects)
    if (arg) {
      const idx = parseInt(arg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= allProjects.length) {
        await this.replyText(messageId, `❌ 请输入 1~${allProjects.length} 之间的编号。`)
        return
      }
      const chosen = allProjects[idx]
      const newDir = this.projectDir(chosen)

      // Clear session mapping for this chat so next message uses the new project
      for (const key of Object.keys(this.sessionMap)) {
        if (key.startsWith(`${chatId}:`)) delete this.sessionMap[key]
      }
      delete this._modelOverrides[chatId]
      this._chatDirs[chatId] = newDir

      // Auto-unhide if it was hidden
      if (newDir in this._hiddenDirs) {
        delete this._hiddenDirs[newDir]
        await this.saveHiddenDirs()
      }

      // Find or create a session in the new project
      const { sessionTitle, created } = await Instance.provide({
        directory: newDir,
        fn: async () => {
          const recent = [...Session.list({ directory: newDir, roots: true, limit: 1 })]
          if (recent.length > 0) {
            return { sessionTitle: recent[0].title ?? recent[0].id.slice(0, 8), created: false }
          } else {
            const session = await Session.create({ title: `飞书对话 ${chatId.slice(-6)}` })
            return { sessionTitle: session.title, created: true }
          }
        },
      })
      await this.saveSessionMap()

      const name = this.projectName(chosen)
      const note = created ? "已创建新会话" : `已进入该项目最新会话：${sessionTitle}`
      console.log("[feishu] /project switched:", chatId, "->", newDir)
      await this.replyText(messageId, `✅ 已切换到：${name}\n   ${newDir}\n（${note}）`)
      return
    }

    // /project — list top-10 non-hidden projects
    if (visibleProjects.length === 0) {
      const hint = Object.keys(this._hiddenDirs).length > 0 ? `（有 ${Object.keys(this._hiddenDirs).length} 个项目已隐藏）` : ""
      await this.replyText(messageId, `❌ 未找到任何项目。${hint}`)
      return
    }

    const currentItem2 = allProjects.find((p) => this.projectDir(p) === currentDir) ?? allProjects[0]
    const lines = [
      `📂 当前项目：${this.clip(this.projectName(currentItem2), 24)}`,
      "",
      "📂 项目列表：",
      "",
    ]
    let count = 0
    for (let i = 0; i < allProjects.length && count < 10; i++) {
      const item = allProjects[i]
      const directory = this.projectDir(item)
      if (directory in this._hiddenDirs) continue
      const tag = directory === currentDir ? " ◀" : ""
      lines.push(`${i + 1}. ${this.projectName(item)}${tag}`)
      lines.push(`   ${directory}`)
      count++
    }
    lines.push("")
    lines.push("💡 /project n 切换 | /project list 查看全部 | /project hide n 隐藏")
    if (Object.keys(this._hiddenDirs).length > 0) {
      lines.push(`ℹ️ 已隐藏 ${Object.keys(this._hiddenDirs).length} 个项目（重新使用后自动恢复）`)
    }
    await this.replyText(messageId, lines.join("\n"))
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
    if (this._globalBusListener) {
      GlobalBus.off("event", this._globalBusListener)
      this._globalBusListener = null
    }
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
    this._chatDirs = {}
    // _hiddenDirs intentionally kept (persisted, survives reconnect)
    this.status = "idle"
  }

  async clearSession(): Promise<void> {
    try {
      await rm(CONFIG_FILE, { force: true })
      await rm(SESSION_MAP_FILE, { force: true })
      await rm(HIDDEN_DIRS_FILE, { force: true })
      this._session = null
      this.sessionMap = {}
      this._hiddenDirs = {}
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

  private async loadHiddenDirs(): Promise<Record<string, number>> {
    try {
      if (existsSync(HIDDEN_DIRS_FILE)) {
        const data = await readFile(HIDDEN_DIRS_FILE, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return {}
  }

  private async saveHiddenDirs(): Promise<void> {
    await mkdir(FEISHU_DATA_DIR, { recursive: true })
    await writeFile(HIDDEN_DIRS_FILE, JSON.stringify(this._hiddenDirs, null, 2))
  }

  async loadSession(): Promise<FeishuSession | null> {
    const config = await this.loadConfig()
    if (config && this._session) return this._session
    return null
  }
}

export const FeishuManager = new FeishuManagerImpl()
