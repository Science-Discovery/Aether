import { mkdir, readFile, writeFile, rm, stat } from "fs/promises"
import { join, basename } from "path"
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
import { SessionCompaction } from "@/session/compaction"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { ModelID } from "@/provider/schema"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"

const FEISHU_DATA_DIR =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "opencode", "feishu")
    : process.platform === "win32"
      ? join(process.env.APPDATA || homedir(), "opencode", "feishu")
      : join(homedir(), ".local", "share", "opencode", "feishu")
const CONFIG_FILE = join(FEISHU_DATA_DIR, "config.json")
const SESSION_MAP_FILE = join(FEISHU_DATA_DIR, "sessions.json")
const HIDDEN_DIRS_FILE = join(FEISHU_DATA_DIR, "hidden_projects.json")
const DEFAULT_PROJECT_FILE = join(FEISHU_DATA_DIR, "default_project.json")

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
  providerName: string
  modelID: string
  name: string
  isDefault: boolean
}

class FeishuManagerImpl {
  private wsClient: any = null
  private larkClient: any = null
  private _appId: string = ""
  private _appSecret: string = ""
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
  // Per-chat current directory (set by /project n). Empty = use default or connect-time Instance.directory.
  private _chatDirs: Record<string, string> = {}
  // Per-chat pinned session (set by /session n or /new). Overrides thread-based sessionMap.
  private _chatSessions: Record<string, string> = {}
  // Hidden project directories: directory -> timestamp when hidden. Persisted to disk.
  private _hiddenDirs: Record<string, number> = {}
  // Default project directory applied to all chats on connect. Persisted to disk.
  private _defaultDir: string | null = null
  // GlobalBus listener for detecting web UI activity on hidden projects.
  private _globalBusListener: ((event: { directory?: string; payload: any }) => void) | null = null
  // ─────────────────────────────────────────────────────────────────────────

  // ── Agent & approval state ────────────────────────────────────────────────
  // Per-chat agent overrides set via /agent <name>. Cleared by /new.
  private _agentOverrides: Record<string, string> = {}
  // Per-chat approval mode set via /approval <auto|ask>. Defaults to "ask". Cleared by /new.
  private _approvalOverrides: Record<string, string> = {}
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
        const modelValues = Object.entries(info.models)
        const sortedIds = modelValues.map(([id]) => id)
        const defaultModelId = sortedIds[0]
        for (const [modelID, model] of modelValues) {
          entries.push({
            index,
            providerID,
            providerName: info.name || providerID,
            modelID,
            name: (model as any).name || modelID,
            isDefault: modelID === defaultModelId,
          })
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
    this._defaultDir = await this.loadDefaultDir()

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

      this._appId = config.appId
      this._appSecret = config.appSecret
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
      const chatType = message.chat_type // "p2p" or "group"
      console.log("[feishu] message:", { chatId, messageId, type: message.message_type, chatType })

      // In group chats, only respond when the bot is @mentioned
      if (chatType === "group") {
        const mentions = message.mentions
        if (!mentions || !Array.isArray(mentions) || mentions.length === 0) {
          console.log("[feishu] group message without @mention, ignoring")
          return
        }
      }

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
      const effectiveDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory

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
          // Pinned session (/session n) takes priority over thread-based mapping
          let sessionId = this._chatSessions[chatId] ?? this.sessionMap[sessionKey]

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
            this._chatSessions[chatId] = sessionId
            this.sessionMap[sessionKey] = sessionId
            await this.saveSessionMap()
          }

          const model = this.resolveModel(chatId)
          console.log("[feishu] using model:", model ?? "(default)")

          // Detect summarization intent and inject chat history into prompt
          let promptText = text
          if (this.detectFileSendIntent(text)) {
            promptText += `\n\n[系统提示：用户需要通过飞书接收文件附件，请在回复中包含该文件的完整绝对路径（格式如 /home/user/file.md），系统将自动将其作为附件发送给用户]`
          }
          const intent = this.detectSummaryIntent(text)
          if (intent.isSummary) {
            console.log("[feishu] summary intent detected, fetching chat history...")
            const history = await this.fetchChatHistory(chatId, { today: intent.today, count: intent.count })
            if (history) {
              promptText = `${text}\n\n以下是群聊记录，请据此进行总结：\n\n${history}`
            } else {
              await this.replyText(
                messageId,
                "⚠️ 未能获取群聊记录（可能需要在飞书开放平台开启 im:message.group_msg 权限）",
              )
              return
            }
          }

          const agent = this._agentOverrides[chatId]
          if (this._approvalOverrides[chatId] === "auto") {
            const session = await Session.get(SessionID.make(sessionId))
            if (!session.permission?.some((r) => r.permission === "*" && r.action === "allow")) {
              await Session.setPermission({
                sessionID: SessionID.make(sessionId),
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
            }
          }
          console.log("[feishu] sending to aether, session:", sessionId)
          const msg = await SessionPrompt.prompt({
            sessionID: SessionID.make(sessionId),
            parts: [{ type: "text", text: promptText }],
            ...(model ? { model } : {}),
            ...(agent ? { agent } : {}),
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

          // If user explicitly asked for a file, send files that were read this turn
          // or extract file paths mentioned in the AI response text
          if (this.detectFileSendIntent(text)) {
            let filesToSend = this.extractReadFiles(msg)
            if (filesToSend.length === 0 && responseText) {
              filesToSend = this.extractFilePathsFromText(responseText)
            }
            if (filesToSend.length > 0) {
              console.log("[feishu] sending", filesToSend.length, "requested file(s)")
              for (const filePath of filesToSend.slice(0, 5)) {
                await this.replyFile(messageId, filePath)
              }
            }
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

  /** Detect if the user is asking for a chat summary and extract time range. */
  private detectSummaryIntent(text: string): { isSummary: boolean; today: boolean; count: number } {
    const summaryWords = ["总结", "汇总", "归纳", "概括", "summary"]
    const contextWords = ["群", "聊天", "消息", "今天", "最近", "记录", "内容", "讨论"]
    const lower = text.toLowerCase()
    const hasSummary = summaryWords.some((w) => lower.includes(w))
    const hasContext = contextWords.some((w) => lower.includes(w))
    if (!hasSummary || !hasContext) return { isSummary: false, today: false, count: 50 }
    const today = lower.includes("今天") || lower.includes("today")
    const match = text.match(/(\d+)\s*条/)
    const count = match ? Math.min(parseInt(match[1], 10), 100) : 50
    return { isSummary: true, today, count }
  }

  /** Fetch recent messages from a chat and format as transcript. */
  private async fetchChatHistory(chatId: string, opts: { today: boolean; count: number }): Promise<string | null> {
    if (!this.larkClient) return null
    try {
      const params: Record<string, any> = {
        container_id_type: "chat",
        container_id: chatId,
        page_size: Math.min(opts.count, 50),
        sort_type: "ByCreateTimeDesc",
      }
      if (opts.today) {
        const midnight = new Date()
        midnight.setHours(0, 0, 0, 0)
        params.start_time = String(Math.floor(midnight.getTime() / 1000))
      }

      const items: any[] = []
      let pageToken: string | undefined
      let remaining = opts.count
      do {
        const result = await this.larkClient.im.message.list({
          params: { ...params, page_size: Math.min(remaining, 50), ...(pageToken ? { page_token: pageToken } : {}) },
        })
        const batch: any[] = result?.data?.items ?? []
        items.push(...batch)
        pageToken = result?.data?.has_more ? result.data.page_token : undefined
        remaining -= batch.length
      } while (pageToken && remaining > 0)

      items.reverse()

      const lines: string[] = []
      for (const item of items) {
        if (item.deleted || item.msg_type !== "text") continue
        let content: string
        try {
          content = JSON.parse(item.body?.content || "{}").text ?? ""
        } catch {
          continue
        }
        if (!content.trim()) continue
        const senderId = (item.sender?.sender_id?.open_id ?? "unknown").slice(-8)
        const ts = parseInt(item.create_time ?? "0")
        const time = new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        lines.push(`[${time}] ${senderId}: ${content}`)
      }

      if (lines.length === 0) return null
      return lines.join("\n")
    } catch (err) {
      console.error("[feishu] fetchChatHistory error:", err)
      return null
    }
  }

  private extractResponseText(msg: any): string | null {
    if (!msg?.parts) return null
    const textParts = msg.parts.filter((p: any) => p.type === "text")
    if (textParts.length === 0) return null
    return textParts.map((p: any) => p.text).join("\n")
  }

  /** Extract file paths that were read by the AI during this turn (from ToolParts). */
  private extractReadFiles(msg: any): string[] {
    if (!msg?.parts) return []
    const files: string[] = []
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      if (part.tool === "read" && part.state?.input?.filePath) {
        files.push(part.state.input.filePath)
      }
    }
    return [...new Set(files)]
  }

  /** Detect if the user is explicitly asking to receive a file. */
  private detectFileSendIntent(text: string): boolean {
    const lower = text.toLowerCase()
    return ["发给我", "发来", "源文件", "原文件", "发过来", "原始文件", "send me", "send file"].some((w) =>
      lower.includes(w),
    )
  }

  /** Extract existing absolute file paths mentioned in text (e.g. in AI response). */
  private extractFilePathsFromText(text: string): string[] {
    const matches = text.match(/`?(\/[^\s`'"(){}<>]+\.[a-zA-Z0-9]+)`?/g) ?? []
    return [...new Set(matches.map((m) => m.replace(/^`|`$/g, "").trim()).filter((p) => existsSync(p)))]
  }

  /** Map file extension to Feishu file_type. */
  private feishuFileType(filename: string): string {
    const ext = (filename.split(".").pop() ?? "").toLowerCase()
    const map: Record<string, string> = {
      pdf: "pdf",
      doc: "doc",
      docx: "doc",
      xls: "xls",
      xlsx: "xls",
      ppt: "ppt",
      pptx: "ppt",
    }
    return map[ext] ?? "stream"
  }

  /** Get a fresh tenant access token via native fetch (bypasses axios). */
  private async getTenantAccessToken(): Promise<string> {
    const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this._appId, app_secret: this._appSecret }),
    })
    const data = (await resp.json()) as any
    if (!data.tenant_access_token) throw new Error(`获取 token 失败: ${JSON.stringify(data)}`)
    return data.tenant_access_token
  }

  /** Upload a local file to Feishu and reply with it. Uses native fetch to bypass axios/Bun issues. */
  private async replyFile(messageId: string, filePath: string): Promise<void> {
    if (!this._appId) return
    try {
      const info = await stat(filePath)
      if (info.size > 30 * 1024 * 1024) {
        console.log("[feishu] file too large, skipping:", filePath)
        return
      }
      const filename = basename(filePath)
      const fileBuffer = await readFile(filePath)
      const token = await this.getTenantAccessToken()

      const form = new FormData()
      form.append("file_type", this.feishuFileType(filename))
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

  // ── Command handlers ──────────────────────────────────────────────────────

  private async handleCommand(text: string, messageId: string, chatId: string): Promise<void> {
    const parts = text.trim().split(/\s+/)
    const command = parts[0].toLowerCase()
    const rest = parts.slice(1).join(" ")

    if (command === "/new") {
      await this.cmdNew(messageId, chatId)
    } else if (command === "/stop") {
      await this.cmdStop(messageId, chatId)
    } else if (command === "/compact") {
      await this.cmdCompact(messageId, chatId)
    } else if (command === "/model") {
      await this.cmdModel(messageId, chatId, parts.slice(1))
    } else if (command === "/agent") {
      await this.cmdAgent(messageId, chatId, rest)
    } else if (command === "/approval") {
      await this.cmdApproval(messageId, chatId, rest)
    } else if (command === "/project") {
      await this.cmdProject(messageId, chatId, rest)
    } else if (command === "/session") {
      await this.cmdSession(messageId, chatId, rest)
    } else if (command === "/help") {
      await this.replyText(
        messageId,
        "📋 可用命令：\n\n/new             开启全新对话（无当前会话上下文）\n/stop            停止当前会话中的执行\n/compact         压缩当前会话上下文\n/model           查看可用 LLM 模型（每个 provider 最多显示前 5 个）\n/model list      查看所有可用 LLM 模型\n/model n         切换到编号 n 的模型（按全量模型编号）\n/agent           查看当前会话模式\n/agent <name>    切换到指定模式（如 build、plan、docs）\n/approval        查看当前审批模式\n/approval <name> 切换审批模式（如 auto、ask）\n/project         查看最近项目\n/project list    查看全部项目\n/project n       切换到编号 n 的项目\n/project hide n  隐藏项目（在桌面端或飞书端重新使用后自动恢复）\n/project default n  设置编号 n 的项目为默认（重连后自动进入）\n/session         查看当前项目下的最近会话\n/session list    查看当前项目下全部会话\n/session n       切换到当前项目下编号 n 的会话\n/help            显示此帮助信息",
      )
    } else {
      await this.replyText(messageId, `未知命令: ${command}\n发送 /help 查看可用命令。`)
    }
  }

  /** /new — clear session and per-chat model/agent/approval override, keep connection snapshot */
  private async cmdNew(messageId: string, chatId: string): Promise<void> {
    for (const key of Object.keys(this.sessionMap)) {
      if (key.startsWith(`${chatId}:`)) delete this.sessionMap[key]
    }
    delete this._modelOverrides[chatId]
    delete this._agentOverrides[chatId]
    delete this._approvalOverrides[chatId]
    delete this._chatSessions[chatId]

    const effectiveDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory
    const session = await Instance.provide({
      directory: effectiveDir,
      fn: () => Session.create({ title: `飞书对话 ${chatId.slice(-6)}` }),
    })
    this._chatSessions[chatId] = session.id
    await this.saveSessionMap()
    await this.replyText(messageId, `✅ 已开启新对话\n💬 ${session.title}`)
  }

  /**
   * /model        — list models with current selection (top 5 per provider)
   * /model list   — list ALL models
   * /model <n>    — set per-chat model override to entry n
   * /model <provider/model> — set per-chat model override by name
   */
  private async cmdModel(messageId: string, chatId: string, args: string[]): Promise<void> {
    if (this._modelList.length === 0) {
      this._modelList = await this.buildModelList()
    }

    if (args.length === 0) {
      await this.replyText(messageId, this.formatModelList(chatId, false))
      return
    }

    if (args[0] === "list") {
      await this.replyText(messageId, this.formatModelList(chatId, true))
      return
    }

    const n = parseInt(args[0], 10)
    if (!isNaN(n) && n >= 1 && n <= this._modelList.length) {
      const entry = this._modelList[n - 1]
      this._modelOverrides[chatId] = { providerID: entry.providerID, modelID: entry.modelID }
      await this.replyText(
        messageId,
        `✅ 已切换模型：${entry.providerID}/${entry.modelID}\n（仅对当前对话生效，/new 后将重置）`,
      )
      return
    }

    const arg = args[0]
    if (arg.includes("/")) {
      const [providerID, modelID] = arg.split("/", 2)
      const found = this._modelList.find((e) => e.providerID === providerID && e.modelID === modelID)
      if (!found) {
        await this.replyText(messageId, `❌ 未找到模型：${arg}\n请先发送 /model 查看可用模型。`)
        return
      }
      this._modelOverrides[chatId] = { providerID, modelID }
      await this.replyText(messageId, `✅ 已切换模型：${arg}\n（仅对当前对话生效，/new 后将重置）`)
      return
    }

    await this.replyText(messageId, `无效参数，请输入编号、list 或 provider/model 格式。`)
  }

  private formatModelList(chatId: string, full: boolean): string {
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
      lines.push(`【${entries[0].providerName}】`)
      const visible = full ? entries : entries.slice(0, 5)
      for (const entry of visible) {
        const def = entry.isDefault ? " ★" : ""
        lines.push(`  ${entry.index}. ${entry.providerID}/${entry.modelID}${def}`)
      }
      if (!full && entries.length > visible.length) {
        lines.push(`  ... 还有 ${entries.length - visible.length} 个，发送 /model list 查看全部`)
      }
    }

    if (this._modelList.length === 0) {
      lines.push("（暂无可用模型，请先在 Aether 中配置 provider）")
    }

    lines.push("")
    lines.push("💡 /model n 切换模型 | /model list 查看全部")
    return lines.join("\n")
  }

  /** /stop — abort the active prompt in the current session */
  private async cmdStop(messageId: string, chatId: string): Promise<void> {
    const sessionId = this._chatSessions[chatId]
    if (!sessionId) {
      await this.replyText(messageId, "当前没有可停止的会话。")
      return
    }
    const effectiveDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory
    const busy = await Instance.provide({
      directory: effectiveDir,
      fn: () => SessionStatus.get(SessionID.make(sessionId)),
    })
    if (busy.type !== "busy") {
      await this.replyText(messageId, "当前没有正在执行的任务。")
      return
    }
    await Instance.provide({
      directory: effectiveDir,
      fn: async () => {
        SessionPrompt.cancel(SessionID.make(sessionId))
      },
    })
    await this.replyText(messageId, "✅ 已停止当前执行。")
  }

  /** /compact — compress the current session context */
  private async cmdCompact(messageId: string, chatId: string): Promise<void> {
    const effectiveDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory
    let sessionId = this._chatSessions[chatId]
    if (!sessionId) {
      const session = await Instance.provide({
        directory: effectiveDir,
        fn: () => Session.create({ title: `飞书对话 ${chatId.slice(-6)}` }),
      })
      sessionId = session.id
      this._chatSessions[chatId] = sessionId
    }
    const model = this.resolveModel(chatId)
    if (!model) {
      await this.replyText(messageId, "❌ 压缩当前会话前，请先使用 /model 选择模型。")
      return
    }
    await Instance.provide({
      directory: effectiveDir,
      fn: async () => {
        const msgs = await Session.messages({ sessionID: SessionID.make(sessionId) })
        let currentAgent = await Agent.defaultAgent()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "user") {
            currentAgent = info.agent || (await Agent.defaultAgent())
            break
          }
        }
        await SessionCompaction.create({
          sessionID: SessionID.make(sessionId),
          agent: this._agentOverrides[chatId] ?? currentAgent,
          model,
          auto: false,
        })
        await SessionPrompt.loop({ sessionID: SessionID.make(sessionId) })
      },
    })
    await this.replyText(messageId, "✅ 已开始压缩当前会话上下文，请稍后查看结果。")
  }

  /**
   * /agent        — show current agent mode
   * /agent <name> — switch to named agent (e.g. build, plan, docs)
   */
  private async cmdAgent(messageId: string, chatId: string, arg: string): Promise<void> {
    let agents: { name: string; hidden?: boolean }[] = []
    try {
      agents = await Agent.list()
    } catch {
      await this.replyText(messageId, "❌ 无法获取模式列表，请检查 Aether 服务是否正常。")
      return
    }
    const visible = agents.filter((a) => !a.hidden)
    const names = visible.map((a) => a.name)
    const current = this._agentOverrides[chatId] || (await Agent.defaultAgent())
    if (!arg) {
      const sample = names.slice(0, 10).join("、") || "（暂无可用模式）"
      await this.replyText(messageId, `🧠 当前模式：${current}\n可用模式：${sample}`)
      return
    }
    if (!names.includes(arg)) {
      const sample = names.slice(0, 10).join("、") || "（暂无可用模式）"
      await this.replyText(messageId, `❌ 未找到模式：${arg}\n可用模式：${sample}`)
      return
    }
    this._agentOverrides[chatId] = arg
    await this.replyText(messageId, `✅ 已切换模式：${arg}\n（仅对当前对话生效，/new 后将重置）`)
  }

  /**
   * /approval        — show current approval mode
   * /approval <name> — switch approval mode (auto, ask)
   */
  private async cmdApproval(messageId: string, chatId: string, arg: string): Promise<void> {
    const current = this._approvalOverrides[chatId] || "ask"
    if (!arg) {
      await this.replyText(messageId, `🔐 当前审批模式：${current}\n可用模式：auto、ask`)
      return
    }
    if (arg !== "auto" && arg !== "ask") {
      await this.replyText(messageId, "❌ 仅支持 /approval auto 或 /approval ask")
      return
    }
    this._approvalOverrides[chatId] = arg
    const sessionId = this._chatSessions[chatId]
    if (arg === "auto") {
      const effectiveDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory
      await Instance.provide({
        directory: effectiveDir,
        fn: async () => {
          const permissions = await Permission.list()
          for (const p of permissions) {
            if (sessionId && p.sessionID === sessionId) {
              await Permission.reply({ requestID: p.id, reply: "always" })
            }
          }
          if (sessionId) {
            await Session.setPermission({
              sessionID: SessionID.make(sessionId),
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            })
          }
        },
      })
      await this.replyText(messageId, "✅ 已开启自动接受权限\n（后续权限请求将自动批准）")
    } else {
      const effectiveDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory
      await Instance.provide({
        directory: effectiveDir,
        fn: async () => {
          if (sessionId) {
            await Session.setPermission({
              sessionID: SessionID.make(sessionId),
              permission: [],
            })
          }
        },
      })
      await this.replyText(messageId, "✅ 已停止自动接受权限\n（后续权限请求将需要你确认）")
    }
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
    const currentDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory

    // /project default <n>
    if (arg.startsWith("default ")) {
      const idxArg = arg.slice(8).trim()
      const idx = parseInt(idxArg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= allProjects.length) {
        await this.replyText(messageId, `❌ 用法：/project default n（n 为 1~${allProjects.length}）`)
        return
      }
      const target = allProjects[idx]
      this._defaultDir = this.projectDir(target)
      await this.saveDefaultDir(this._defaultDir)
      await this.replyText(
        messageId,
        `✅ 已设置默认项目：${this.projectName(target)}\n   ${this._defaultDir}\n（断开重连后自动进入此项目）`,
      )
      return
    }

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
      const lines = [`📂 当前项目：${this.clip(this.projectName(currentItem), 24)}`, "", "📂 项目列表：", ""]
      for (let i = 0; i < allProjects.length; i++) {
        const item = allProjects[i]
        const directory = this.projectDir(item)
        const tag = directory === currentDir ? " ◀" : ""
        const mark = directory in this._hiddenDirs ? " [已隐藏]" : ""
        const def = directory === this._defaultDir ? " [默认]" : ""
        lines.push(`${i + 1}. ${this.projectName(item)}${tag}${def}${mark}`)
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
      delete this._agentOverrides[chatId]
      delete this._approvalOverrides[chatId]
      this._chatDirs[chatId] = newDir

      // Auto-unhide if it was hidden
      if (newDir in this._hiddenDirs) {
        delete this._hiddenDirs[newDir]
        await this.saveHiddenDirs()
      }

      // Find or create a session in the new project
      const {
        sessionId: newSessionId,
        sessionTitle,
        created,
      } = await Instance.provide({
        directory: newDir,
        fn: async () => {
          const recent = [...Session.list({ directory: newDir, roots: true, limit: 1 })]
          if (recent.length > 0) {
            return {
              sessionId: recent[0].id,
              sessionTitle: recent[0].title ?? recent[0].id.slice(0, 8),
              created: false,
            }
          } else {
            const session = await Session.create({ title: `飞书对话 ${chatId.slice(-6)}` })
            return { sessionId: session.id, sessionTitle: session.title, created: true }
          }
        },
      })
      this._chatSessions[chatId] = newSessionId
      await this.saveSessionMap()

      const name = this.projectName(chosen)
      const note = created ? "已创建新会话" : `已进入该项目最新会话：${sessionTitle}`
      console.log("[feishu] /project switched:", chatId, "->", newDir)
      await this.replyText(messageId, `✅ 已切换到：${name}\n   ${newDir}\n（${note}）`)
      return
    }

    // /project — list top-10 non-hidden projects
    if (visibleProjects.length === 0) {
      const hint =
        Object.keys(this._hiddenDirs).length > 0 ? `（有 ${Object.keys(this._hiddenDirs).length} 个项目已隐藏）` : ""
      await this.replyText(messageId, `❌ 未找到任何项目。${hint}`)
      return
    }

    const currentItem2 = allProjects.find((p) => this.projectDir(p) === currentDir) ?? allProjects[0]
    const lines = [`📂 当前项目：${this.clip(this.projectName(currentItem2), 24)}`, "", "📂 项目列表：", ""]
    let count = 0
    for (let i = 0; i < allProjects.length && count < 10; i++) {
      const item = allProjects[i]
      const directory = this.projectDir(item)
      if (directory in this._hiddenDirs) continue
      const tag = directory === currentDir ? " ◀" : ""
      const def = directory === this._defaultDir ? " [默认]" : ""
      lines.push(`${i + 1}. ${this.projectName(item)}${tag}${def}`)
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

  private formatSessionTime(timestamp: number): string {
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }

  /**
   * /session          — list top-10 sessions in current project
   * /session list     — list all sessions
   * /session <n>      — switch to session n
   */
  private async cmdSession(messageId: string, chatId: string, arg: string): Promise<void> {
    const effectiveDir = this._chatDirs[chatId] ?? this._defaultDir ?? Instance.directory
    let items: Session.Info[] = []
    await Instance.provide({
      directory: effectiveDir,
      fn: async () => {
        items = [...Session.list({ directory: effectiveDir, roots: true, limit: 100 })]
      },
    })

    const currentId = this._chatSessions[chatId]

    if (arg === "list") {
      const currentItem = items.find((i) => i.id === currentId)
      const currentTitle = currentItem?.title ?? currentId?.slice(0, 8) ?? "无"
      const lines = [`🗂 当前会话：${currentTitle}`, "", "🗂 会话列表：", ""]
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const tag = item.id === currentId ? " ◀" : ""
        lines.push(`${i + 1}. ${item.title}${tag}`)
        lines.push(`   ${this.formatSessionTime(item.time.updated)}`)
      }
      if (!items.length) lines.push("（当前项目下还没有任何会话）")
      await this.replyText(messageId, lines.join("\n"))
      return
    }

    if (arg) {
      const idx = parseInt(arg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        await this.replyText(
          messageId,
          items.length ? `❌ 请输入 1~${items.length} 之间的数字。` : "❌ 当前项目下还没有任何会话。",
        )
        return
      }
      const chosen = items[idx]
      this._chatSessions[chatId] = chosen.id
      delete this._agentOverrides[chatId]
      delete this._approvalOverrides[chatId]
      await this.replyText(
        messageId,
        `✅ 已切换到会话：${chosen.title}\n   更新时间：${this.formatSessionTime(chosen.time.updated)}`,
      )
      return
    }

    // /session — list top-10, auto-create if empty
    if (!items.length) {
      const session = await Instance.provide({
        directory: effectiveDir,
        fn: () => Session.create({ title: `飞书对话 ${chatId.slice(-6)}` }),
      })
      this._chatSessions[chatId] = session.id
      await this.replyText(messageId, "📂 当前项目下还没有任何会话，已自动创建一个新会话并切换。")
      return
    }

    const currentItem = items.find((i) => i.id === currentId) ?? items[0]
    const lines = [`🗂 当前会话：${currentItem.title}`, "", "🗂 会话列表：", ""]
    for (let i = 0; i < Math.min(items.length, 10); i++) {
      const item = items[i]
      const tag = item.id === currentId ? " ◀" : ""
      lines.push(`${i + 1}. ${item.title}${tag}`)
      lines.push(`   ${this.formatSessionTime(item.time.updated)}`)
    }
    lines.push("")
    lines.push("💡 /session n 切换会话 | /session list 查看全部")
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
    this._agentOverrides = {}
    this._approvalOverrides = {}
    this._modelList = []
    this._chatDirs = {}
    this._chatSessions = {}
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

  private async loadDefaultDir(): Promise<string | null> {
    try {
      if (existsSync(DEFAULT_PROJECT_FILE)) {
        const data = await readFile(DEFAULT_PROJECT_FILE, "utf-8")
        return JSON.parse(data)?.directory ?? null
      }
    } catch {}
    return null
  }

  private async saveDefaultDir(directory: string): Promise<void> {
    await mkdir(FEISHU_DATA_DIR, { recursive: true })
    await writeFile(DEFAULT_PROJECT_FILE, JSON.stringify({ directory }, null, 2))
  }

  async loadSession(): Promise<FeishuSession | null> {
    const config = await this.loadConfig()
    if (config && this._session) return this._session
    return null
  }
}

export const FeishuManager = new FeishuManagerImpl()
