import { mkdir, readFile, writeFile, rm, stat } from "fs/promises"
import { isAbsolute, join, basename } from "path"
import { existsSync } from "fs"
import z from "zod"
import * as lark from "@larksuiteoapi/node-sdk"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
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
import { SessionPreference } from "@/session/preference"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { NotFoundError } from "@/storage/db"
import { legacyPlatformDir, platformDir } from "@/persist/naming"

function isSessionNotFound(err: unknown): boolean {
  return (
    NotFoundError.isInstance(err) &&
    typeof err.data?.message === "string" &&
    err.data.message.startsWith("Session not found:")
  )
}

function dir() {
  return platformDir("feishu")
}

function oldDir() {
  return legacyPlatformDir("feishu")
}

function file(name: string) {
  return join(dir(), name)
}

function old(name: string) {
  return join(oldDir(), name)
}

function readPath(name: "config.json" | "sessions.json" | "hidden_projects.json") {
  const next = file(name)
  const prev = old(name)
  return existsSync(next) || !existsSync(prev) ? next : prev
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

const HELP_TEXT =
  "📋 可用命令：\n\n/n, /new            开启新对话\n/stop               停止当前执行\n/c, /compact        压缩当前上下文\n\n/m, /model          查看可用模型\n/m l                查看全部模型\n/m n                切换编号模型\n\n/a, /agent          查看当前模式\n/a n | /a <name>    切换指定模式\n\n/variant            查看思考等级\n/variant n          切换编号思考等级\n\n/autoaccept         查看审批模式\n/autoaccept n       切换编号审批模式\n\n/p, /project        查看最近项目\n/p l                查看全部项目\n/p n                切换编号项目\n/p <path>           切换到指定路径\n\n/s, /session        查看最近会话\n/s l                查看全部会话\n/s n                切换编号会话\n\n/h, /help           显示帮助信息\n/help list          显示全部命令"

const HELP_LIST_TEXT =
  "📋 全部命令：\n\n/n, /new\n  开启新对话，清空当前会话上下文\n\n/stop\n  停止当前执行中的任务\n\n/c, /compact\n  压缩当前会话上下文\n\n/m, /model\n  查看可用模型\n/m l, /model list\n  查看全部模型（l = list）\n/m n, /model n\n  切换到编号 n 的模型（n 为全量模型编号）\n\n/a, /agent\n  查看当前模式\n/a n, /agent n\n  按编号切换模式\n/a <name>, /agent <name>\n  按名称切换模式（如 build、plan、docs）\n\n/variant\n  查看当前模型可用的思考等级\n/variant n\n  按编号切换思考等级\n/variant <name>\n  按名称切换思考等级\n\n/autoaccept\n  查看审批模式\n/autoaccept n\n  按编号切换审批模式（1=auto, 2=ask）\n/autoaccept <name>\n  切换审批模式（name 可选：auto、ask）\n\n/p, /project\n  查看最近项目\n/p l, /project list\n  查看全部项目（l = list）\n/p n, /project n\n  切换到编号 n 的项目\n/p <path>, /project <path>\n  切换到指定路径（如 /p E:\\work\\foo 或 /p /home/user/foo）\n/project hide n\n  隐藏编号 n 的项目，重新在桌面端或消息端使用后自动恢复\n\n/s, /session\n  查看最近会话\n/s l, /session list\n  查看当前项目下全部会话（l = list）\n/s n, /session n\n  切换到当前项目下编号 n 的会话\n\n/h, /help\n  显示常用命令\n/help list\n  显示全部命令"

export const FeishuEvent = {
  StatusChanged: BusEvent.define(
    "feishu.status",
    z.object({
      status: z.enum(["idle", "starting", "connected", "reconnecting", "error"]),
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
  Reconnecting: BusEvent.define(
    "feishu.reconnecting",
    z.object({
      attempt: z.number(),
      delay: z.number(),
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
  // Initial directory computed from first visible project on connect.
  private _initialDir: string = ""
  // GlobalBus listener for detecting web UI activity on hidden projects.
  private _globalBusListener: ((event: { directory?: string; payload: any }) => void) | null = null
  // ─────────────────────────────────────────────────────────────────────────

  // ── Agent & approval state ────────────────────────────────────────────────
  // (Moved to SessionPreference)
  // ─────────────────────────────────────────────────────────────────────────

  // ── Pending interaction state ─────────────────────────────────────────────
  private _pendingQuestions: Record<string, Question.Request> = {}
  private _pendingPermissions: Record<string, Permission.Request> = {}
  private _pendingConfirmCreate: Record<string, { path: string }> = {}
  private _activePrompt = new Map<
    string,
    {
      sessionId: string
      messageId: string
      directory: string
    }
  >()
  private _processedIds = new Map<string, number>()
  private _busUnsubs: (() => void)[] = []
  private _heartbeat: ReturnType<typeof setInterval> | null = null
  private _heartbeatFails = 0
  private _reconnect: ReturnType<typeof setTimeout> | null = null
  private _reconnectCount = 0
  private _manualStop = false
  private _lastConfig: FeishuConfig | null = null
  private _starting = false
  // ── 诊断用字段 ─────────────────────────────────────────────────────────────
  private _lastWsEventTime: number = 0
  // ─────────────────────────────────────────────────────────────────────────

  private static readonly HEARTBEAT_MS = 30_000
  private static readonly HEARTBEAT_FAILS = 3
  private static readonly RECONNECT_MAX_MS = 300_000

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
    if (/^[A-Za-z]:/.test(text)) {
      const lower = `${text[0].toLowerCase()}${text.slice(1)}`
      if (/^[a-z]:\/?$/.test(lower)) return `${lower[0]}:/`
      return lower.replace(/\/+$/, "")
    }
    return text.replace(/\/+$/, "")
  }

  private isAbsolutePath(p: string): boolean {
    const n = this.normDir(p)
    if (!n || n === "/") return false
    return n.startsWith("/") || /^[a-z]:/.test(n)
  }

  private isRootDir(dir: string): boolean {
    const text = this.normDir(dir)
    if (text === "/") return true
    return /^[a-z]:/.test(text) && text.length <= 3
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

  /** Model resolution: SessionPreference → connection snapshot → undefined */
  private resolveModel(chatId: string): { providerID: ProviderID; modelID: ModelID } | undefined {
    const sessionId = this._chatSessions[chatId]
    if (sessionId) {
      const pref = SessionPreference.get(sessionId)
      if (pref?.model) {
        return {
          providerID: ProviderID.make(pref.model.providerID),
          modelID: ModelID.make(pref.model.modelID),
        }
      }
    }
    if (!this._connectedModel) return undefined
    return {
      providerID: ProviderID.make(this._connectedModel.providerID),
      modelID: ModelID.make(this._connectedModel.modelID),
    }
  }

  private effectiveDir(chatId: string): string {
    return this._chatDirs[chatId] ?? (this._initialDir || Instance.directory)
  }

  private async clearRuntime(chatId: string): Promise<void> {
    delete this._pendingQuestions[chatId]
    delete this._pendingPermissions[chatId]
    delete this._pendingConfirmCreate[chatId]
    this._activePrompt.delete(chatId)
  }

  private async commandCtx(chatId: string): Promise<{
    dir: string
    sessionId: string
    pref: ReturnType<typeof SessionPreference.get>
    projectName: string
    sessionTitle: string
    modeName: string
    modelStr: string
  }> {
    const dir = this.effectiveDir(chatId)
    const sessionId = await this.currentSession(chatId, true)
    if (!sessionId) throw new Error("no session for chat: " + chatId)
    const pref = SessionPreference.get(sessionId)
    const projectItem = this.getProjects().find((p) => this.normDir(this.projectDir(p)) === this.normDir(dir))
    const projectName = this.clip(
      projectItem
        ? this.projectName(projectItem)
        : (dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) ?? dir),
      24,
    )
    let sessionTitle = sessionId.slice(0, 8)
    try {
      const info = await Instance.provide({
        directory: dir,
        fn: () => [...Session.list({ directory: dir, roots: true, limit: 100 })].find((s) => s.id === sessionId),
      })
      if (info?.title) sessionTitle = info.title
    } catch {}
    sessionTitle = this.clip(sessionTitle, 24)
    const modeName = pref?.agent ?? "build"
    const model = this.resolveModel(chatId)
    const modelStr = model
      ? `${model.providerID}/${model.modelID}`
      : this._connectedModel
        ? `${this._connectedModel.providerID}/${this._connectedModel.modelID}`
        : "—"
    return { dir, sessionId, pref, projectName, sessionTitle, modeName, modelStr }
  }

  private commandHeader(ctx: Awaited<ReturnType<typeof this.commandCtx>>): string {
    const mode = ctx.modeName.charAt(0).toUpperCase() + ctx.modeName.slice(1)
    return `${ctx.projectName}  ·  ${ctx.sessionTitle}  ·  ${mode}  ·  ${ctx.modelStr}\n————————\n`
  }

  private async replyCmd(messageId: string, chatId: string, body: string): Promise<void> {
    if (!body.trim()) {
      await this.replyText(messageId, body)
      return
    }
    await this.replyText(messageId, this.commandHeader(await this.commandCtx(chatId)) + body)
  }

  private async setPref(chatId: string, patch: Record<string, any>): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    await Instance.provide({
      directory: ctx.dir,
      fn: () => SessionPreference.update({ sessionID: SessionID.make(ctx.sessionId), ...patch }),
    })
  }

  private async currentSession(chatId: string, create?: boolean): Promise<string | undefined> {
    const pinned = this._chatSessions[chatId]
    if (pinned) return pinned
    const dir = this.effectiveDir(chatId)
    const recent = await Instance.provide({
      directory: dir,
      fn: () => [...Session.list({ directory: dir, roots: true, limit: 1 })],
    })
    if (recent[0]) {
      this._chatSessions[chatId] = recent[0].id
      return recent[0].id
    }
    if (!create) return
    const session = await Instance.provide({
      directory: dir,
      fn: () => Session.create({ title: `飞书对话 - ${new Date().toISOString()}` }),
    })
    this._chatSessions[chatId] = session.id
    return session.id
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
    if (this.wsClient || this._starting || ["starting", "connected", "reconnecting"].includes(this._status)) {
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
    this._manualStop = false
    this._lastConfig = cfg

    await this.saveConfig(cfg)
    this.sessionMap = await this.loadSessionMap()
    this._hiddenDirs = await this.loadHiddenDirs()
    void this._doStart(cfg, model ?? null)
    return { success: true }
  }

  private async _doStart(config: FeishuConfig, model: ModelRef | null): Promise<void> {
    this._starting = true
    try {
      this.statusMsg("starting", "正在连接飞书...")
      console.log("[feishu] _doStart called")

      const boundHandleMessage = (data: any) => {
        const gap = this._lastWsEventTime ? `gap=${Date.now() - this._lastWsEventTime}ms` : "first"
        this._lastWsEventTime = Date.now()
        console.log("[feishu] >>> event received!", gap, localISOString())
        void this.enqueueMessage(data)
      }

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
      this.bindLifecycle(this.wsClient)

      console.log("[feishu] calling wsClient.start()...")
      await this.wsClient.start({ eventDispatcher })
      console.log("[feishu] wsClient.start() resolved")

      this._connectedModel = model
      this._reconnectCount = 0
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

      const onQuestion = (event: { directory?: string; payload: any }) => {
        if (event.payload?.type !== "question.asked") return
        const q = event.payload.properties as Question.Request
        for (const [chatId, info] of this._activePrompt) {
          if (info.sessionId === q.sessionID) {
            this._pendingQuestions[chatId] = q
            void this.replyText(info.messageId, this.formatQuestionRequest(q))
            return
          }
        }
      }
      GlobalBus.on("event", onQuestion)
      this._busUnsubs.push(() => GlobalBus.off("event", onQuestion))

      const onPermission = (event: { directory?: string; payload: any }) => {
        if (event.payload?.type !== "permission.asked") return
        const p = event.payload.properties as Permission.Request
        for (const [chatId, info] of this._activePrompt) {
          if (info.sessionId === p.sessionID) {
            const pref = SessionPreference.get(info.sessionId)
            if (pref?.autoAccept) {
              void Instance.provide({
                directory: info.directory,
                fn: () => Permission.reply({ requestID: p.id, reply: "always" }),
              })
              return
            }
            this._pendingPermissions[chatId] = p
            void this.replyText(info.messageId, this.formatPermissionRequest(p))
            return
          }
        }
      }
      GlobalBus.on("event", onPermission)
      this._busUnsubs.push(() => GlobalBus.off("event", onPermission))

      this._session = {
        connected: true,
        appId: config.appId,
        createdAt: Date.now(),
      }
      this.startHeartbeat()
      this.status = "connected"
      Bus.publish(FeishuEvent.Connected, { appId: config.appId })

      // 5s 后打印服务端 pong 下发的实际配置（pingInterval 等）
      setTimeout(() => {
        const wsClientAny = this.wsClient as any
        const ws = wsClientAny?.wsConfig?.getWS?.()
        if (ws) {
          console.log(
            `[feishu] pong config: pingInterval=${ws.pingInterval}ms reconnectInterval=${ws.reconnectInterval}ms reconnectNonce=${ws.reconnectNonce}ms`,
            localISOString(),
          )
        }
      }, 5_000)

      // Compute initial directory from first visible project
      const allProjects = this.getProjects()
      const visibleProjects = allProjects.filter((p) => !(this.projectDir(p) in this._hiddenDirs))
      this._initialDir = visibleProjects.length > 0 ? this.projectDir(visibleProjects[0]) : Instance.directory
      console.log("[feishu] initial dir:", this._initialDir)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._error = { code: "start_failed", message }
      this.status = "error"
      Bus.publish(FeishuEvent.Error, this._error)
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
      const close = ws.addEventListener?.bind(ws)
      if (typeof close === "function") {
        close("close", (code: number, reason: Buffer) => {
          console.log(`[feishu] socket close code=${code} reason="${reason?.toString?.() || ""}"`, localISOString())
          this.onDisconnect("socket_close")
        })
        close("error", () => this.onDisconnect("socket_error"))
        return
      }
      const add = ws.on?.bind(ws)
      if (typeof add === "function") {
        add("close", (code: number, reason: Buffer) => {
          console.log(`[feishu] socket close code=${code} reason="${reason?.toString?.() || ""}"`, localISOString())
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
    Bus.publish(FeishuEvent.Reconnecting, { attempt, delay })
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
    this._heartbeat = setInterval(() => {
      void this.checkHeartbeat()
    }, FeishuManagerImpl.HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (!this._heartbeat) return
    clearInterval(this._heartbeat)
    this._heartbeat = null
  }

  private async checkHeartbeat(): Promise<void> {
    if (this._manualStop || this._status !== "connected") return
    try {
      await this.getTenantAccessToken()
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
    if (this._globalBusListener) {
      GlobalBus.off("event", this._globalBusListener)
      this._globalBusListener = null
    }
    if (this.wsClient) {
      const prev = this._manualStop
      this._manualStop = true
      try {
        if (typeof this.wsClient.close === "function") {
          await this.wsClient.close()
        }
      } catch {}
      this._manualStop = prev
      this.wsClient = null
    }
    this.larkClient = null
    this._session = null
    this._modelList = []
    this._pendingQuestions = {}
    this._pendingPermissions = {}
    this._pendingConfirmCreate = {}
    this._activePrompt.clear()
    for (const unsub of this._busUnsubs) unsub()
    this._busUnsubs = []
    if (!reset) return
    this._connectedModel = null
    this._chatDirs = {}
    this._chatSessions = {}
    this._initialDir = ""
    this.status = "idle"
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      console.log("[feishu] handleMessage invoked", localISOString())
      console.log("[feishu] received event:", JSON.stringify(data).slice(0, 500))
      const message = data?.message
      if (!message) {
        console.log("[feishu] no message in event data, keys:", Object.keys(data || {}))
        return
      }

      const chatId = message.chat_id
      const messageId = message.message_id
      const rootId = message.root_id || message.parent_id || messageId
      const chatType = message.chat_type
      console.log("[feishu] message:", { chatId, messageId, type: message.message_type, chatType })

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

      text = text.replace(/@_\w+\s*/g, "").trim()
      if (!text) return
      console.log("[feishu] text:", text, localISOString())

      const isSlash = text.startsWith("/")
      const parts = isSlash ? text.trim().split(/\s+/) : []
      const cmd = isSlash ? text.trim().split(/\s+/)[0].toLowerCase() : ""

      if (cmd === "/h" || cmd === "/help") {
        await this.replyText(messageId, parts[1]?.toLowerCase() === "list" ? HELP_LIST_TEXT : HELP_TEXT)
        return
      }

      await this.autoUnhide()

      if (isSlash && cmd !== "/stop" && cmd !== "/compact" && cmd !== "/c") {
        await this.handleCommand(text, messageId, chatId)
        return
      }

      const effectiveDir = this.effectiveDir(chatId)

      if (effectiveDir in this._hiddenDirs) {
        delete this._hiddenDirs[effectiveDir]
        console.log("[feishu] auto-unhide via Feishu message:", effectiveDir)
        void this.saveHiddenDirs()
      }

      if (cmd === "/stop") {
        const hasPending = chatId in this._pendingQuestions || chatId in this._pendingPermissions
        const active = this._activePrompt.get(chatId)
        if (!active && !hasPending) {
          await this.replyText(messageId, "没有任务在执行")
          return
        }
        if (active) {
          try {
            await Instance.provide({
              directory: active.directory,
              fn: () => SessionPrompt.cancel(SessionID.make(active.sessionId)),
            })
          } catch {}
        }
        await this.clearRuntime(chatId)
        await this.replyText(messageId, "✅ 已停止当前执行。")
        return
      }

      if (cmd === "/c" || cmd === "/compact") {
        const pendingQ = this._pendingQuestions[chatId]
        if (pendingQ) {
          await this.replyText(messageId, this.formatQuestionRequest(pendingQ))
          return
        }
        const pendingP = this._pendingPermissions[chatId]
        if (pendingP) {
          await this.replyText(messageId, this.formatPermissionRequest(pendingP))
          return
        }
        const active = this._activePrompt.get(chatId)
        if (active) {
          await this.replyText(
            messageId,
            "当前会话正在生成回复，请等待当前对话结束后再发送；如需立即开始新问题，请先 /new 或切换 /session n。如需停止本会话请输入 /stop",
          )
          return
        }
        if (!(chatId in this._chatSessions)) {
          await this.replyText(messageId, "没有任务在执行")
          return
        }
        try {
          await this.cmdCompact(messageId, chatId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await this.replyText(messageId, `命令执行出错: ${msg}`)
        }
        return
      }

      const pendingConfirm = this._pendingConfirmCreate[chatId]
      if (pendingConfirm) {
        const lower = text.trim().toLowerCase()
        if (lower === "y" || lower === "yes" || lower === "确认") {
          await this.confirmCreateProject(chatId, messageId, true)
        } else if (lower === "n" || lower === "no" || lower === "取消") {
          await this.confirmCreateProject(chatId, messageId, false)
        } else {
          await this.replyText(messageId, "请回复 y 确认创建或 n 取消。")
        }
        return
      }

      const pendingQ = this._pendingQuestions[chatId]
      if (pendingQ) {
        await this.handleQuestionReply(chatId, messageId, text, pendingQ)
        return
      }
      const pendingP = this._pendingPermissions[chatId]
      if (pendingP) {
        await this.handlePermissionReply(chatId, messageId, text, pendingP)
        return
      }

      const active = this._activePrompt.get(chatId)
      if (active) {
        await this.replyText(
          messageId,
          "当前会话正在生成回复，请等待当前对话结束后再发送；如需立即开始新问题，请先 /new 或切换 /session n。如需停止本会话请输入 /stop",
        )
        return
      }

      await this.startPrompt(chatId, messageId, text, effectiveDir, rootId)
    } catch (err) {
      console.error("[feishu] handleMessage error:", err)
      try {
        const messageId = data?.message?.message_id
        if (messageId) {
          const errMsg = isSessionNotFound(err) ? "会话已不存在" : err instanceof Error ? err.message : String(err)
          await this.replyText(messageId, `处理消息时出错: ${errMsg}`)
        }
      } catch (e2) {
        console.error("[feishu] failed to send error reply:", e2)
      }
    }
  }

  private async startPrompt(
    chatId: string,
    messageId: string,
    text: string,
    effectiveDir: string,
    rootId: string,
  ): Promise<void> {
    this._activePrompt.set(chatId, { sessionId: "", messageId, directory: effectiveDir })
    const sessionKey = `${chatId}:${rootId}`
    let sessionId = this._chatSessions[chatId] ?? this.sessionMap[sessionKey]

    if (!sessionId) {
      const recent = await Instance.provide({
        directory: effectiveDir,
        fn: () => [...Session.list({ directory: effectiveDir, roots: true, limit: 1 })],
      })
      if (recent.length > 0) {
        sessionId = recent[0].id
        console.log("[feishu] reusing existing session:", sessionId)
      } else {
        console.log("[feishu] creating new session...")
        const session = await Instance.provide({
          directory: effectiveDir,
          fn: () => Session.create({ title: `飞书对话 - ${new Date().toISOString()}` }),
        })
        sessionId = session.id
        console.log("[feishu] session created:", sessionId)
      }
      this._chatSessions[chatId] = sessionId
      this.sessionMap[sessionKey] = sessionId
      await this.saveSessionMap()
    }

    this._activePrompt.set(chatId, { sessionId, messageId, directory: effectiveDir })

    const model = this.resolveModel(chatId)
    console.log("[feishu] using model:", model ?? "(default)")

    let promptText = text
    if (this.mightWantFile(text)) {
      promptText +=
        "\n\n[系统提示：如果用户的意图是获取某个文件，请在回复中包含该文件在当前系统上的完整绝对路径。Windows 示例：E:\\\\work\\\\demo\\\\file.md；macOS/Linux 示例：/Users/demo/file.md 或 /home/demo/file.md。系统将自动把该路径对应的文件作为附件发送给用户。如果用户无需获取文件，请忽略本提示，正常回复即可。]"
    }
    const intent = this.detectSummaryIntent(text)
    if (intent.isSummary) {
      console.log("[feishu] summary intent detected, fetching chat history...")
      const history = await this.fetchChatHistory(chatId, { today: intent.today, count: intent.count })
      if (history) {
        promptText = `${text}\n\n以下是群聊记录，请据此进行总结：\n\n${history}`
      } else {
        await this.replyText(messageId, "⚠️ 未能获取群聊记录（可能需要在飞书开放平台开启 im:message.group_msg 权限）")
        return
      }
    }

    const pref = sessionId ? SessionPreference.get(sessionId) : undefined
    if (pref?.autoAccept) {
      const session = await Instance.provide({
        directory: effectiveDir,
        fn: () => Session.get(SessionID.make(sessionId)),
      })
      if (!session.permission?.some((r) => r.permission === "*" && r.action === "allow")) {
        await Instance.provide({
          directory: effectiveDir,
          fn: () =>
            Session.setPermission({
              sessionID: SessionID.make(sessionId),
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            }),
        })
      }
    }

    console.log("[feishu] sending to aether, session:", sessionId, localISOString())

    try {
      const msg = await Instance.provide({
        directory: effectiveDir,
        fn: () =>
          SessionPrompt.prompt({
            sessionID: SessionID.make(sessionId),
            parts: [{ type: "text", text: promptText }],
          }),
      })
      console.log("[feishu] aether responded, parts:", msg?.parts?.length, localISOString())

      const responseText = this.extractResponseText(msg)
      if (responseText) {
        const header = await this.formatHeader(chatId)
        console.log("[feishu] replying:", responseText.slice(0, 100), localISOString())
        await this.replyText(messageId, header + responseText)
      } else {
        console.log("[feishu] no text in response")
      }

      let filesToSend = this.extractReadFiles(msg)
      if (filesToSend.length === 0 && responseText) {
        filesToSend = this.extractFilePathsFromText(responseText).slice(0, 1)
      }
      if (filesToSend.length > 0) {
        console.log("[feishu] sending", filesToSend.length, "requested file(s)")
        for (const filePath of filesToSend.slice(0, 5)) {
          await this.replyFile(messageId, filePath)
        }
      }
    } catch (err) {
      console.error("[feishu] prompt error:", err)
      const errMsg = isSessionNotFound(err) ? "会话已不存在" : err instanceof Error ? err.message : String(err)
      await this.replyText(messageId, `处理消息时出错: ${errMsg}`).catch(() => {})
    } finally {
      this._activePrompt.delete(chatId)
    }
  }

  private enqueueMessage(data: any): Promise<void> {
    const messageId = data?.message?.message_id ?? ""
    if (messageId) {
      if (this._processedIds.has(messageId)) return Promise.resolve()
      this._processedIds.set(messageId, Date.now())
      this.evictProcessedIds()
    }
    return this.handleMessage(data)
  }

  private evictProcessedIds(): void {
    const now = Date.now()
    const maxAge = 300_000
    for (const [id, ts] of this._processedIds) {
      if (now - ts > maxAge) this._processedIds.delete(id)
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
    if (!msg?.parts) {
      const error = msg?.info?.error
      if (error) return `AI 服务错误: ${error?.data?.message || error?.name || "未知错误"}`
      return null
    }
    const textParts = msg.parts.filter((p: any) => p.type === "text")
    if (textParts.length === 0) {
      const error = msg?.info?.error
      if (error) return `AI 服务错误: ${error?.data?.message || error?.name || "未知错误"}`
      return null
    }
    return textParts.map((p: any) => p.text).join("\n")
  }

  /** Coarse filter: does this message possibly involve a file request? */
  private mightWantFile(text: string): boolean {
    const lower = text.toLowerCase()
    return ["发给我", "发来", "文件给我", "发过来", "发文件", "send me", "send file"].some((w) => lower.includes(w))
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

  /** Extract existing absolute file paths mentioned in text (e.g. in AI response). */
  private extractFilePathsFromText(text: string): string[] {
    const files = [
      ...this.extractPathTokens(text, /`([^`]+)`/g),
      ...this.extractPathTokens(text, /([A-Za-z]:\\[^\s'"(){}<>]+|\/(?:[^\s`'"(){}<>]+\/?)+)/g),
    ]
    return [...new Set(files.filter((p) => this.isFilePath(p)))]
  }

  private extractPathTokens(text: string, pattern: RegExp): string[] {
    const items: string[] = []
    for (const match of text.matchAll(pattern)) {
      const raw = (match[1] ?? match[0] ?? "").trim()
      const file = raw.replace(/^[`'\"]+|[`'\",.;:!?]+$/g, "").trim()
      if (file) items.push(file)
    }
    return items
  }

  private isFilePath(path: string): boolean {
    if (!isAbsolute(path)) return false
    return existsSync(path)
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

    try {
      if (command === "/n" || command === "/new") {
        await this.cmdNew(messageId, chatId)
      } else if (command === "/m" || command === "/model") {
        const args = parts.slice(1)
        if (args[0] === "l") args[0] = "list"
        await this.cmdModel(messageId, chatId, args)
      } else if (command === "/a" || command === "/agent") {
        await this.cmdAgent(messageId, chatId, rest)
      } else if (command === "/autoaccept") {
        await this.cmdAutoAccept(messageId, chatId, rest)
      } else if (command === "/variant") {
        await this.cmdVariant(messageId, chatId, rest)
      } else if (command === "/p" || command === "/project") {
        const arg = rest === "l" ? "list" : rest.startsWith("h ") ? `hide ${rest.slice(2).trim()}` : rest
        await this.cmdProject(messageId, chatId, arg)
      } else if (command === "/s" || command === "/session") {
        await this.cmdSession(messageId, chatId, rest === "l" ? "list" : rest)
      } else if (command === "/h" || command === "/help") {
        await this.replyText(messageId, rest.toLowerCase() === "list" ? HELP_LIST_TEXT : HELP_TEXT)
      } else {
        await this.replyText(messageId, `❓ 未知命令：${command}\n发送 /help 查看常用命令，/help list 查看全部命令。`)
      }
    } catch (err) {
      console.error("[feishu] handleCommand error:", err)
      const errMsg = err instanceof Error ? err.message : String(err)
      await this.replyText(messageId, `命令执行出错: ${errMsg}`).catch(() => {})
    }
  }

  /** /new — clear session mapping, keep connection snapshot */
  private async cmdNew(messageId: string, chatId: string): Promise<void> {
    for (const key of Object.keys(this.sessionMap)) {
      if (key.startsWith(`${chatId}:`)) delete this.sessionMap[key]
    }
    delete this._chatSessions[chatId]
    void this.clearRuntime(chatId)

    const dir = this.effectiveDir(chatId)
    const session = await Instance.provide({
      directory: dir,
      fn: () => Session.create({ title: `飞书对话 - ${new Date().toISOString()}` }),
    })
    this._chatSessions[chatId] = session.id
    await this.saveSessionMap()
    await this.replyCmd(messageId, chatId, `✅ 已开启新对话\n💬 ${session.title}`)
  }

  /**
   * /model        — list models with current selection (top 5 per provider)
   * /model list   — list ALL models
   * /model <n>    — set per-chat model override to entry n
   * /model <provider/model> — set per-chat model override by name
   */
  private async cmdModel(messageId: string, chatId: string, args: string[]): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    if (this._modelList.length === 0) {
      this._modelList = await this.buildModelList()
    }

    if (args.length === 0) {
      await this.replyCmd(messageId, chatId, this.formatModelList(ctx, false))
      return
    }

    if (args[0] === "list") {
      await this.replyCmd(messageId, chatId, this.formatModelList(ctx, true))
      return
    }

    const n = parseInt(args[0], 10)
    if (!isNaN(n) && n >= 1 && n <= this._modelList.length) {
      const entry = this._modelList[n - 1]
      await this.setPref(chatId, {
        model: { providerID: ProviderID.make(entry.providerID), modelID: ModelID.make(entry.modelID) },
      })
      await this.replyCmd(
        messageId,
        chatId,
        `✅ 已切换模型：${entry.providerID}/${entry.modelID}\n（仅对当前对话生效，/new 后将重置）`,
      )
      return
    }

    const arg = args[0]
    if (arg.includes("/")) {
      const [providerID, modelID] = arg.split("/", 2)
      const found = this._modelList.find((e) => e.providerID === providerID && e.modelID === modelID)
      if (!found) {
        await this.replyCmd(messageId, chatId, `❌ 未找到模型：${arg}\n请先发送 /model 查看可用模型。`)
        return
      }
      await this.setPref(chatId, { model: { providerID: ProviderID.make(providerID), modelID: ModelID.make(modelID) } })
      await this.replyCmd(messageId, chatId, `✅ 已切换模型：${arg}\n（仅对当前对话生效，/new 后将重置）`)
      return
    }

    await this.replyCmd(messageId, chatId, "❌ 无效参数，请输入编号、list 或 provider/model 格式。")
  }

  private formatModelList(ctx: Awaited<ReturnType<typeof this.commandCtx>>, full: boolean): string {
    const prefModel = ctx.pref?.model
    const current = prefModel ?? this._connectedModel

    const lines: string[] = []
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
        lines.push(`  ... 还有 ${entries.length - visible.length} 个，发送 /m l 查看全部`)
      }
    }

    if (this._modelList.length === 0) {
      lines.push("（暂无可用模型，请先在 Aether 中配置 provider）")
    }

    lines.push("")
    lines.push("💡 /m n 切换模型 | /m l 查看全部")
    return lines.join("\n")
  }

  private async thinking(chatId: string) {
    const ctx = await this.commandCtx(chatId)
    const model = this.resolveModel(chatId)
    if (!model) return { names: [], current: ctx.pref?.variant }
    const all = await Instance.provide({
      directory: ctx.dir,
      fn: () => Provider.list(),
    })
    const info = all[model.providerID]
    const item = info?.models?.[model.modelID] as { variants?: Record<string, unknown> } | undefined
    return {
      names: Object.keys(item?.variants ?? {}),
      current: ctx.pref?.variant,
    }
  }

  /** /compact — compress the current session context */
  private async cmdCompact(messageId: string, chatId: string): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    const model = this.resolveModel(chatId)
    if (!model) {
      await this.replyCmd(messageId, chatId, "❌ 压缩当前会话前，请先使用 /model 选择模型。")
      return
    }
    await Instance.provide({
      directory: ctx.dir,
      fn: async () => {
        const msgs = await Session.messages({ sessionID: SessionID.make(ctx.sessionId) })
        let currentAgent = await Agent.defaultAgent()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "user") {
            currentAgent = info.agent || (await Agent.defaultAgent())
            break
          }
        }
        await SessionCompaction.create({
          sessionID: SessionID.make(ctx.sessionId),
          agent: ctx.pref?.agent ?? currentAgent,
          model,
          auto: false,
        })
        await SessionPrompt.loop({ sessionID: SessionID.make(ctx.sessionId) })
      },
    })
    await this.replyCmd(messageId, chatId, "✅ 已开始压缩当前会话上下文，请稍后查看结果。")
  }

  /**
   * /agent        — show current agent mode
   * /agent <name> — switch to named agent (e.g. build, plan, docs)
   */
  private async cmdAgent(messageId: string, chatId: string, arg: string): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    let agents: { name: string; hidden?: boolean }[] = []
    let current: string = "build"
    try {
      await Instance.provide({
        directory: ctx.dir,
        fn: async () => {
          agents = await Agent.list()
          current = ctx.pref?.agent || (await Agent.defaultAgent())
        },
      })
    } catch {
      await this.replyCmd(messageId, chatId, "❌ 无法获取模式列表，请检查 Aether 服务是否正常。")
      return
    }
    const visible = agents.filter((a) => !a.hidden)
    const names = visible.map((a) => a.name)
    if (!arg) {
      if (names.length === 0) {
        await this.replyCmd(messageId, chatId, "❌ 暂无可用模式。")
        return
      }
      const lines = ["🧠 可用模式：", ""]
      names.forEach((name, i) => {
        lines.push(`  ${i + 1}. ${name}${name === current ? " ★（当前）" : ""}`)
      })
      lines.push("", "💡 /a 编号或名称 切换模式")
      await this.replyCmd(messageId, chatId, lines.join("\n"))
      return
    }
    const n = parseInt(arg, 10)
    const next = /^\d+$/.test(arg)
      ? n >= 1 && n <= names.length
        ? names[n - 1]
        : undefined
      : names.find((name) => name === arg)
    if (!next) {
      if (/^\d+$/.test(arg)) {
        await this.replyCmd(messageId, chatId, `❌ 编号超出范围，请输入 1~${names.length} 之间的数字。`)
        return
      }
      await this.replyCmd(messageId, chatId, `❌ 未找到模式：${arg}，发送 /a 查看可用模式。`)
      return
    }
    await this.setPref(chatId, { agent: next })
    await this.replyCmd(messageId, chatId, `✅ 已切换模式：${next}\n（仅对当前对话生效，/new 后将重置）`)
  }

  /**
   * /autoaccept        — show current approval mode
   * /autoaccept <name> — switch approval mode (auto, ask)
   */
  private async cmdAutoAccept(messageId: string, chatId: string, arg: string): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    const auto = ctx.pref?.autoAccept ?? false
    const names = ["auto", "ask"] as const
    if (!arg) {
      const lines = [
        "🔐 可用审批模式：",
        "",
        `  1. auto（自动批准）${auto ? " ★（当前）" : ""}`,
        `  2. ask（手动审批）${auto ? "" : " ★（当前）"}`,
        "",
        "💡 /autoaccept 编号或名称 切换审批模式",
      ]
      await this.replyCmd(messageId, chatId, lines.join("\n"))
      return
    }
    const n = parseInt(arg, 10)
    const next = /^\d+$/.test(arg) ? names[n - 1] : names.find((name) => name === arg)
    if (!next) {
      await this.replyCmd(messageId, chatId, "❌ 仅支持 1(auto) 或 2(ask)。")
      return
    }
    await this.setPref(chatId, { autoAccept: next === "auto" })
    if (next === "auto") {
      const pending = this._pendingPermissions[chatId]
      if (pending) {
        delete this._pendingPermissions[chatId]
        await Instance.provide({
          directory: ctx.dir,
          fn: () => Permission.reply({ requestID: pending.id, reply: "always" }),
        })
        await this.replyCmd(messageId, chatId, "✅ 已开启自动接受权限，并已自动批准当前挂起的授权请求")
      } else {
        await this.replyCmd(messageId, chatId, "✅ 已开启自动接受权限\n（后续权限请求将自动批准）")
      }
    } else {
      await this.replyCmd(messageId, chatId, "✅ 已停止自动接受权限\n（后续权限请求将需要你确认）")
    }
  }

  private async cmdVariant(messageId: string, chatId: string, arg: string): Promise<void> {
    const model = this.resolveModel(chatId)
    if (!model) {
      await this.replyCmd(messageId, chatId, "❌ 请先使用 /m 选择模型后再切换思考等级。")
      return
    }
    const info = await this.thinking(chatId)
    const names = ["默认", ...info.names]
    if (!arg) {
      const lines = ["🔀 可用思考等级：", ""]
      names.forEach((name, i) => {
        const active = name === "默认" ? !info.current : name === info.current
        lines.push(`  ${i + 1}. ${name}${active ? " ★（当前）" : ""}`)
      })
      lines.push("", "💡 /variant 编号或名称 切换思考等级")
      await this.replyCmd(messageId, chatId, lines.join("\n"))
      return
    }
    const n = parseInt(arg, 10)
    const next = /^\d+$/.test(arg)
      ? n >= 1 && n <= names.length
        ? names[n - 1]
        : undefined
      : names.find((name) => name === arg || (name === "默认" && arg === "default"))
    if (!next) {
      if (/^\d+$/.test(arg)) {
        await this.replyCmd(messageId, chatId, `❌ 编号超出范围，请输入 1~${names.length} 之间的数字。`)
        return
      }
      await this.replyCmd(messageId, chatId, `❌ 未找到思考等级：${arg}，发送 /variant 查看可用思考等级。`)
      return
    }
    await this.setPref(chatId, { variant: next === "默认" ? undefined : next })
    await this.replyCmd(messageId, chatId, `✅ 已切换思考等级：${next}\n（仅对当前对话生效，/new 后将重置）`)
  }

  /**
   * /project            — list top-10 visible projects with full-list numbering (current marked ◀)
   * /project list       — list ALL projects including hidden ones
   * /project <n>        — switch to project n
   * /project hide <n>   — hide project n
   */
  private async cmdProject(messageId: string, chatId: string, arg: string): Promise<void> {
    if (arg && this.isAbsolutePath(arg)) {
      await this.cmdProjectByPath(messageId, chatId, arg)
      return
    }
    const allProjects = this.getProjects()
    if (allProjects.length === 0) {
      await this.replyCmd(messageId, chatId, "❌ 无法获取项目列表，请检查 Aether 是否正常运行。")
      return
    }

    const visibleProjects = allProjects.filter((p) => !(this.projectDir(p) in this._hiddenDirs))
    const currentDir = this.effectiveDir(chatId)

    // /project hide <n>
    if (arg.startsWith("hide ")) {
      const delArg = arg.slice(5).trim()
      const idx = parseInt(delArg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= allProjects.length) {
        await this.replyCmd(messageId, chatId, `❌ 用法：/project hide n（n 为 1~${allProjects.length}）`)
        return
      }
      const target = allProjects[idx]
      const directory = this.projectDir(target)
      this._hiddenDirs[directory] = Date.now()
      await this.saveHiddenDirs()
      const name = this.projectName(target)
      await this.replyCmd(messageId, chatId, `✅ 已隐藏：${name}\n（在桌面端或消息端重新使用后自动恢复）`)
      return
    }

    // /project list — all projects including hidden
    if (arg === "list") {
      const lines = ["📂 项目列表：", ""]
      for (let i = 0; i < allProjects.length; i++) {
        const item = allProjects[i]
        const directory = this.projectDir(item)
        const tag = directory === currentDir ? " ◀" : ""
        const mark = directory in this._hiddenDirs ? " [已隐藏]" : ""
        lines.push(`${i + 1}. ${this.projectName(item)}${tag}${mark}`)
        lines.push(`   ${directory}`)
      }
      await this.replyCmd(messageId, chatId, lines.join("\n"))
      return
    }

    // /project <n> — switch to project n (1-indexed into allProjects)
    if (arg) {
      const idx = parseInt(arg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= allProjects.length) {
        await this.replyCmd(messageId, chatId, `❌ 请输入 1~${allProjects.length} 之间的编号。`)
        return
      }
      const chosen = allProjects[idx]
      const newDir = this.projectDir(chosen)
      await this.switchToProject(messageId, chatId, newDir)
      return
    }

    // /project — list top-10 visible projects with full-list numbering
    if (visibleProjects.length === 0) {
      const hint =
        Object.keys(this._hiddenDirs).length > 0 ? `（有 ${Object.keys(this._hiddenDirs).length} 个项目已隐藏）` : ""
      await this.replyCmd(messageId, chatId, `❌ 未找到任何项目。${hint}`)
      return
    }

    const lines = ["📂 项目列表：", ""]
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
    lines.push("💡 /p n 切换 | /p l 查看全部 | /p <path> 指定路径")
    if (Object.keys(this._hiddenDirs).length > 0) {
      lines.push(`ℹ️ 已隐藏 ${Object.keys(this._hiddenDirs).length} 个项目（重新使用后自动恢复）`)
    }
    await this.replyCmd(messageId, chatId, lines.join("\n"))
  }

  private formatSessionTime(timestamp: number): string {
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }

  private async cmdProjectByPath(messageId: string, chatId: string, rawPath: string): Promise<void> {
    const normed = this.normDir(rawPath)
    if (this.isRootDir(normed)) {
      await this.replyCmd(messageId, chatId, "❌ 路径不合法：不能使用根目录。")
      return
    }

    const allProjects = this.getProjects()
    const existing = allProjects.find((p) => this.projectDir(p) === normed)
    const dirExists = existsSync(normed)

    if (existing) {
      if (!dirExists) {
        await mkdir(normed, { recursive: true })
      }
      const newDir = this.projectDir(existing)
      await this.switchToProject(messageId, chatId, newDir)
      return
    }

    if (dirExists) {
      await this.switchToNewProject(messageId, chatId, normed)
      return
    }

    this._pendingConfirmCreate[chatId] = { path: normed }
    await this.replyCmd(
      messageId,
      chatId,
      `📂 路径不存在：${normed}\n回复 y 确认创建该文件夹并初始化项目，回复 n 取消。`,
    )
  }

  private async confirmCreateProject(chatId: string, messageId: string, yes: boolean): Promise<void> {
    const pending = this._pendingConfirmCreate[chatId]
    if (!pending) return
    delete this._pendingConfirmCreate[chatId]

    if (!yes) {
      await this.replyCmd(messageId, chatId, "已取消创建。")
      return
    }

    await mkdir(pending.path, { recursive: true })
    await this.switchToNewProject(messageId, chatId, pending.path)
  }

  private async switchToProject(messageId: string, chatId: string, newDir: string): Promise<void> {
    for (const key of Object.keys(this.sessionMap)) {
      if (key.startsWith(`${chatId}:`)) delete this.sessionMap[key]
    }
    this._chatDirs[chatId] = newDir
    void this.clearRuntime(chatId)

    if (newDir in this._hiddenDirs) {
      delete this._hiddenDirs[newDir]
      await this.saveHiddenDirs()
    }

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
        }
        const session = await Session.create({ title: `飞书对话 - ${new Date().toISOString()}` })
        return { sessionId: session.id, sessionTitle: session.title, created: true }
      },
    })
    this._chatSessions[chatId] = newSessionId
    await this.saveSessionMap()

    const name = this.baseName(newDir)
    const note = created ? "已创建新会话" : `已进入该项目最新会话：${sessionTitle}`
    console.log("[feishu] /project switched:", chatId, "->", newDir)
    await this.replyCmd(messageId, chatId, `✅ 已切换到：${name}\n   ${newDir}\n（${note}）`)
  }

  private async switchToNewProject(messageId: string, chatId: string, newDir: string): Promise<void> {
    for (const key of Object.keys(this.sessionMap)) {
      if (key.startsWith(`${chatId}:`)) delete this.sessionMap[key]
    }
    this._chatDirs[chatId] = newDir
    void this.clearRuntime(chatId)

    const { project } = await Project.fromDirectory(newDir)
    if (project.vcs !== "git") {
      const initialized = await Project.initGit({ directory: newDir, project })
      await Instance.reload({
        directory: newDir,
        worktree: newDir,
        project: initialized,
        init: InstanceBootstrap,
      })
    }

    const {
      sessionId: newSessionId,
      sessionTitle,
      created,
    } = await Instance.provide({
      directory: newDir,
      init: InstanceBootstrap,
      fn: async () => {
        const recent = [...Session.list({ directory: newDir, roots: true, limit: 1 })]
        if (recent.length > 0) {
          return {
            sessionId: recent[0].id,
            sessionTitle: recent[0].title ?? recent[0].id.slice(0, 8),
            created: false,
          }
        }
        const session = await Session.create({ title: `飞书对话 - ${new Date().toISOString()}` })
        return { sessionId: session.id, sessionTitle: session.title, created: true }
      },
    })
    this._chatSessions[chatId] = newSessionId
    await this.saveSessionMap()

    const name = this.baseName(newDir)
    const note = created ? "已创建新会话" : `已进入该项目最新会话：${sessionTitle}`
    console.log("[feishu] /project created+switched:", chatId, "->", newDir)
    await this.replyCmd(messageId, chatId, `✅ 已切换到：${name}\n   ${newDir}\n（${note}）`)
  }

  private baseName(dir: string): string {
    return dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) || dir
  }

  /**
   * /session          — list top-10 sessions in current project
   * /session list     — list all sessions
   * /session <n>      — switch to session n
   */
  private async cmdSession(messageId: string, chatId: string, arg: string): Promise<void> {
    const effectiveDir = this.effectiveDir(chatId)
    let items: Session.Info[] = []
    await Instance.provide({
      directory: effectiveDir,
      fn: async () => {
        items = [...Session.list({ directory: effectiveDir, roots: true, limit: 100 })]
      },
    })

    const currentId = this._chatSessions[chatId]

    if (arg === "list") {
      const lines = ["🗂 会话列表：", ""]
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const tag = item.id === currentId ? " ◀" : ""
        lines.push(`${i + 1}. ${item.title}${tag}`)
        lines.push(`   ${this.formatSessionTime(item.time.updated)}`)
      }
      if (!items.length) lines.push("（当前项目下还没有任何会话）")
      await this.replyCmd(messageId, chatId, lines.join("\n"))
      return
    }

    if (arg) {
      const idx = parseInt(arg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        await this.replyCmd(
          messageId,
          chatId,
          items.length ? `❌ 请输入 1~${items.length} 之间的数字。` : "❌ 当前项目下还没有任何会话。",
        )
        return
      }
      const chosen = items[idx]
      this._chatSessions[chatId] = chosen.id
      void this.clearRuntime(chatId)
      const ctx = await this.commandCtx(chatId)
      await this.replyCmd(
        messageId,
        chatId,
        `✅ 已切换到会话：${ctx.sessionTitle}\n   更新时间：${this.formatSessionTime(chosen.time.updated)}`,
      )
      return
    }

    // /session — list top-10, auto-create if empty
    if (!items.length) {
      const session = await Instance.provide({
        directory: effectiveDir,
        fn: () => Session.create({ title: `飞书对话 - ${new Date().toISOString()}` }),
      })
      this._chatSessions[chatId] = session.id
      await this.replyCmd(messageId, chatId, "📂 当前项目下还没有任何会话，已自动创建一个新会话并切换。")
      return
    }

    const lines = ["🗂 会话列表：", ""]
    for (let i = 0; i < Math.min(items.length, 10); i++) {
      const item = items[i]
      const tag = item.id === currentId ? " ◀" : ""
      lines.push(`${i + 1}. ${item.title}${tag}`)
      lines.push(`   ${this.formatSessionTime(item.time.updated)}`)
    }
    lines.push("")
    lines.push("💡 /s n 切换会话 | /s l 查看全部")
    await this.replyCmd(messageId, chatId, lines.join("\n"))
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async formatHeader(chatId: string): Promise<string> {
    const active = this._activePrompt.get(chatId)
    const sessionId = active?.sessionId ?? this._chatSessions[chatId] ?? ""
    const effectiveDir = active?.directory ?? this.effectiveDir(chatId)
    const projectItem = this.getProjects().find((p) => this.normDir(this.projectDir(p)) === this.normDir(effectiveDir))
    const projectName = this.clip(
      projectItem
        ? this.projectName(projectItem)
        : (effectiveDir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) ?? effectiveDir),
      24,
    )
    const label = sessionId ? this.clip(await this.sessionTitle(sessionId, effectiveDir), 24) : "—"
    const pref = sessionId ? SessionPreference.get(sessionId) : undefined
    const modeName = pref?.agent ?? "build"
    const mode = modeName.charAt(0).toUpperCase() + modeName.slice(1)
    const model = this.resolveModel(chatId)
    const modelStr = model
      ? `${model.providerID}/${model.modelID}`
      : this._connectedModel
        ? `${this._connectedModel.providerID}/${this._connectedModel.modelID}`
        : "—"
    return `${projectName}  ·  ${label}  ·  ${mode}  ·  ${modelStr}\n————————\n`
  }

  private async sessionTitle(sessionId: string, directory: string): Promise<string> {
    const info = await Instance.provide({
      directory,
      fn: () => [...Session.list({ directory, roots: true, limit: 100 })].find((s) => s.id === sessionId),
    })
    return info?.title ?? sessionId.slice(0, 8)
  }

  private parseQuestionAnswers(text: string, questions: Question.Info[]): string[][] | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const answers: string[][] = []
    for (const info of questions) {
      const options = info.options ?? []
      if (options.length > 0 && trimmed.match(/^\d+$/)) {
        const idx = parseInt(trimmed) - 1
        if (idx >= 0 && idx < options.length) {
          answers.push([options[idx].label])
          continue
        }
        if (!info.custom) return null
      } else if (options.length > 0 && !info.custom) {
        const match = options.find((o) => o.label === trimmed)
        if (!match) return null
        answers.push([match.label])
        continue
      }
      answers.push([trimmed])
    }
    return answers
  }

  private async handleQuestionReply(
    chatId: string,
    messageId: string,
    text: string,
    pending: Question.Request,
  ): Promise<void> {
    const answers = this.parseQuestionAnswers(text, pending.questions)
    if (!answers) {
      await this.replyText(messageId, "未识别，请回复答案或数字编号。\n\n" + this.formatQuestionRequest(pending))
      return
    }
    const active = this._activePrompt.get(chatId)
    delete this._pendingQuestions[chatId]
    try {
      await Instance.provide({
        directory: active?.directory ?? this.effectiveDir(chatId),
        fn: () => Question.reply({ requestID: pending.id, answers }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._pendingQuestions[chatId] = pending
      await this.replyText(messageId, `❌ 提交答案失败: ${msg}\n请重新发送您的答案。`)
      return
    }
    await this.replyText(messageId, "已提交回答，请等待当前对话继续处理。")
  }

  private parsePermissionReply(text: string): Permission.Reply | null {
    const trimmed = text.trim()
    if (trimmed === "1") return "once"
    if (trimmed === "2") return "always"
    if (trimmed === "3") return "reject"
    return null
  }

  private async handlePermissionReply(
    chatId: string,
    messageId: string,
    text: string,
    pending: Permission.Request,
  ): Promise<void> {
    const reply = this.parsePermissionReply(text)
    if (!reply) {
      await this.replyText(messageId, "未识别，请回复数字编号。\n\n" + this.formatPermissionRequest(pending))
      return
    }
    const active = this._activePrompt.get(chatId)
    delete this._pendingPermissions[chatId]
    try {
      await Instance.provide({
        directory: active?.directory ?? this.effectiveDir(chatId),
        fn: () => Permission.reply({ requestID: pending.id, reply }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._pendingPermissions[chatId] = pending
      await this.replyText(messageId, `❌ 提交授权失败: ${msg}\n请重新发送您的选择。`)
      return
    }
    const notice = {
      once: "已收到授权：允许一次，继续处理中。",
      always: "已收到授权：始终允许，继续处理中。",
      reject: "已收到你的选择：拒绝，正在继续处理。",
    }[reply]
    await this.replyText(messageId, notice)
  }

  private formatQuestionRequest(q: Question.Request): string {
    const parts = ["🤔 Agent 需要您回答：", ""]
    for (let i = 0; i < q.questions.length; i++) {
      const info = q.questions[i]
      if (q.questions.length > 1) parts.push(`【问题 ${i + 1}】${info.question}`)
      else parts.push(info.question)
      if (info.options?.length) {
        parts.push("可选答案：")
        for (let j = 0; j < info.options.length; j++) {
          const opt = info.options[j]
          const suffix = opt.description ? `：${opt.description}` : ""
          parts.push(`  ${j + 1}. ${opt.label}${suffix}`)
        }
      }
    }
    parts.push("")
    parts.push("请直接回复答案（可输入数字编号；若题目允许自定义，也可直接输入文本）。")
    parts.push("如需开始新问题，请先 /new 或切换 /session n。")
    return parts.join("\n")
  }

  private formatPermissionRequest(p: Permission.Request): string {
    const parts = ["🔐 当前操作需要你的授权：", ""]
    parts.push(`权限：${p.permission}`)
    if (p.patterns?.length) {
      parts.push("范围：")
      for (const item of p.patterns) parts.push(`  - ${item}`)
    }
    parts.push("")
    parts.push("请直接回复：")
    parts.push("1. 允许一次（仅这次）")
    parts.push("2. 始终允许（后续同类操作自动通过）")
    parts.push("3. 拒绝（本次不允许执行）")
    parts.push("如需开始新问题，请先 /new 或切换 /session n。")
    return parts.join("\n")
  }

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

  private async sendToChat(chatId: string, text: string): Promise<void> {
    if (!this.larkClient) return
    try {
      await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      })
    } catch (err) {
      console.error("[feishu] send error:", err)
    }
  }

  async stop(): Promise<void> {
    this._manualStop = true
    this._reconnectCount = 0
    await this.cleanupConnection()
    // _hiddenDirs intentionally kept (persisted, survives reconnect)
  }

  async clearSession(): Promise<void> {
    try {
      await rm(file("config.json"), { force: true })
      await rm(file("sessions.json"), { force: true })
      await rm(file("hidden_projects.json"), { force: true })
      this._session = null
      this.sessionMap = {}
      this._hiddenDirs = {}
    } catch {}
  }

  async loadConfig(): Promise<FeishuConfig | null> {
    try {
      const next = readPath("config.json")
      if (existsSync(next)) {
        const data = await readFile(next, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return null
  }

  private async saveConfig(config: FeishuConfig): Promise<void> {
    await mkdir(dir(), { recursive: true })
    await writeFile(file("config.json"), JSON.stringify(config, null, 2))
  }

  private async loadSessionMap(): Promise<SessionMap> {
    try {
      const next = readPath("sessions.json")
      if (existsSync(next)) {
        const data = await readFile(next, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return {}
  }

  private async saveSessionMap(): Promise<void> {
    await mkdir(dir(), { recursive: true })
    await writeFile(file("sessions.json"), JSON.stringify(this.sessionMap, null, 2))
  }

  private async loadHiddenDirs(): Promise<Record<string, number>> {
    try {
      const next = readPath("hidden_projects.json")
      if (existsSync(next)) {
        const data = await readFile(next, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return {}
  }

  private async saveHiddenDirs(): Promise<void> {
    await mkdir(dir(), { recursive: true })
    await writeFile(file("hidden_projects.json"), JSON.stringify(this._hiddenDirs, null, 2))
  }

  async loadSession(): Promise<FeishuSession | null> {
    const config = await this.loadConfig()
    if (config && this._session) return this._session
    return null
  }
}

export const FeishuManager = new FeishuManagerImpl()
