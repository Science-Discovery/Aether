import { mkdir, readFile, writeFile, rm, stat } from "fs/promises"
import { isAbsolute, join, basename } from "path"
import { existsSync } from "fs"
import z from "zod"
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

export type MobileStatus = "idle" | "starting" | "qrcode" | "connected" | "reconnecting" | "error"

export type Platform = "feishu" | "wechat"

function isSessionNotFound(err: unknown): boolean {
  return (
    NotFoundError.isInstance(err) &&
    typeof err.data?.message === "string" &&
    err.data.message.startsWith("Session not found:")
  )
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

const HELP_TEXT =
  "📋 可用命令：\n\n/n, /new            开启新对话\n/stop               停止当前执行\n/c, /compact        压缩当前上下文\n\n/m, /model          查看可用模型\n/m l                查看全部模型\n/m n                切换编号模型\n\n/a, /agent          查看当前模式\n/a n | /a <name>    切换指定模式\n\n/variant            查看思考等级\n/variant n          切换编号思考等级\n\n/autoaccept         查看审批模式\n/autoaccept n       切换编号审批模式\n\n/p, /project        查看最近项目\n/p l                查看全部项目\n/p n                切换编号项目\n/p <path>           切换到指定路径\n\n/s, /session        查看最近会话\n/s l                查看全部会话\n/s n                切换编号会话\n\n/h, /help           显示帮助信息\n/help list          显示全部命令"

const HELP_LIST_TEXT =
  "📋 全部命令：\n\n/n, /new\n  开启新对话，清空当前会话上下文\n\n/stop\n  停止当前执行中的任务\n\n/c, /compact\n  压缩当前会话上下文\n\n/m, /model\n  查看可用模型\n/m l, /model list\n  查看全部模型（l = list）\n/m n, /model n\n  切换到编号 n 的模型（n 为全量模型编号）\n\n/a, /agent\n  查看当前模式\n/a n, /agent n\n  按编号切换模式\n/a <name>, /agent <name>\n  按名称切换模式（如 build、plan、docs）\n\n/variant\n  查看当前模型可用的思考等级\n/variant n\n  按编号切换思考等级\n/variant <name>\n  按名称切换思考等级\n\n/autoaccept\n  查看审批模式\n/autoaccept n\n  按编号切换审批模式（1=auto, 2=ask）\n/autoaccept <name>\n  切换审批模式（name 可选：auto、ask）\n\n/p, /project\n  查看最近项目\n/p l, /project list\n  查看全部项目（l = list）\n/p n, /project n\n  切换到编号 n 的项目\n/p <path>, /project <path>\n  切换到指定路径（如 /p E:\\work\\foo 或 /p /home/user/foo）\n/project hide n\n  隐藏编号 n 的项目，重新在桌面端或消息端使用后自动恢复\n\n/s, /session\n  查看最近会话\n/s l, /session list\n  查看当前项目下全部会话（l = list）\n/s n, /session n\n  切换到当前项目下编号 n 的会话\n\n/h, /help\n  显示常用命令\n/help list\n  显示全部命令"

export interface ModelRef {
  providerID: string
  modelID: string
}

interface ModelEntry {
  index: number
  providerID: string
  providerName: string
  modelID: string
  name: string
  isDefault: boolean
}

type SessionMapKey = Record<string, string>

export interface MobileAdapter {
  platform: Platform

  replyText(targetId: string, text: string): Promise<void>
  replyFile(targetId: string, filePath: string): Promise<void>
  loadConfig(): Promise<any | null>
  clearAuth(): Promise<void>
  loadSession(): Promise<any | null>

  onStatusChange?(status: MobileStatus): void
}

export abstract class MobileManagerBase {
  public adapter: MobileAdapter
  protected _status: MobileStatus = "idle"
  protected _error: { code: string; message: string } | null = null
  protected _connectedModel: ModelRef | null = null
  protected _modelList: ModelEntry[] = []
  protected sessionMap: SessionMapKey = {}
  protected _chatDirs: Record<string, string> = {}
  protected _chatSessions: Record<string, string> = {}
  protected _hiddenDirs: Record<string, number> = {}
  protected _initialDir: string = ""
  protected _globalBusListener: ((event: { directory?: string; payload: any }) => void) | null = null
  protected _pendingQuestions: Record<string, Question.Request> = {}
  protected _questionProgress: Record<string, { index: number; answers: string[][] }> = {}
  protected _pendingPermissions: Record<string, Permission.Request> = {}
  protected _pendingConfirmCreate: Record<string, { path: string }> = {}
  protected _activePrompt = new Map<string, { sessionId: string; messageId: string; directory: string }>()
  protected _processedIds = new Map<string, number>()
  protected _busUnsubs: (() => void)[] = []
  protected _manualStop = false
  protected _starting = false

  abstract platformDir(): string
  abstract platformName(): string

  protected replyTarget(chatId: string, messageId: string): string {
    return messageId
  }

  constructor(adapter: MobileAdapter) {
    this.adapter = adapter
  }

  get status() {
    return this._status
  }

  get error() {
    return this._error
  }

  protected set status(value: MobileStatus) {
    this._status = value
    Bus.publish(this.busEvents.StatusChanged, { status: value })
    this.adapter.onStatusChange?.(value)
  }

  protected statusMsg(value: MobileStatus, message: string) {
    this._status = value
    Bus.publish(this.busEvents.StatusChanged, { status: value, message })
    this.adapter.onStatusChange?.(value)
  }

  get busEvents(): Record<string, BusEvent.Definition> {
    const p = this.adapter.platform
    return {
      StatusChanged: BusEvent.define(
        `${p}.status`,
        z.object({
          status: z.enum(["idle", "starting", "connected", "reconnecting", "error"]),
          message: z.string().optional(),
        }),
      ),
      Connected: BusEvent.define(
        `${p}.connected`,
        z.object({ appId: z.string().optional(), user: z.object({ id: z.string(), name: z.string() }).optional() }),
      ),
      Error: BusEvent.define(`${p}.error`, z.object({ code: z.string(), message: z.string() })),
      Reconnecting: BusEvent.define(`${p}.reconnecting`, z.object({ attempt: z.number(), delay: z.number() })),
      QRCode: BusEvent.define(`${p}.qrcode`, z.object({ image: z.string() })),
    }
  }

  protected dir() {
    return platformDir(this.adapter.platform)
  }

  protected oldDir() {
    return legacyPlatformDir(this.adapter.platform)
  }

  public file(name: string) {
    return join(this.dir(), name)
  }

  public readPath(name: string) {
    const next = this.file(name)
    const prev = join(this.oldDir(), name)
    return existsSync(next) || !existsSync(prev) ? next : prev
  }

  // ── Path helpers ────────────────────────────────────────────────────────────

  protected normDir(d: string): string {
    const text = (d || "").replace(/\\/g, "/")
    if (!text) return ""
    if (/^\/+$/.test(text)) return "/"
    if (/^[A-Za-z]:/.test(text)) {
      const lower = `${text[0].toLowerCase()}${text.slice(1)}`
      if (/^[a-z]:\/?$/.test(lower)) return `${lower[0]}:/`
      return lower.replace(/\/+$/, "")
    }
    return text.replace(/\/+$/, "")
  }

  protected isAbsolutePath(p: string): boolean {
    const n = this.normDir(p)
    if (!n || n === "/") return false
    return n.startsWith("/") || /^[a-z]:/.test(n)
  }

  protected isRootDir(d: string): boolean {
    const text = this.normDir(d)
    if (text === "/") return true
    return /^[a-z]:/.test(text) && text.length <= 3
  }

  protected projectDir(item: Project.RecentInfo): string {
    return this.normDir(item.directory || item.worktree || "")
  }

  protected projectName(item: Project.RecentInfo): string {
    const dir = this.projectDir(item)
    return item.name || dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) || dir
  }

  protected clip(text: string, limit: number): string {
    if (text.length <= limit) return text
    return text.slice(0, limit - 3).trimEnd() + "..."
  }

  protected baseName(dir: string): string {
    return dir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) || dir
  }

  // ── Project helpers ────────────────────────────────────────────────────────

  protected getProjects(): Project.RecentInfo[] {
    return Project.recentList().filter((item) => {
      const dir = this.projectDir(item)
      return dir && !this.isRootDir(dir)
    })
  }

  protected async autoUnhide(): Promise<void> {
    if (Object.keys(this._hiddenDirs).length === 0) return
    const allProjects = this.getProjects()
    let changed = false
    for (const [directory, hideTime] of Object.entries(this._hiddenDirs)) {
      const item = allProjects.find((p) => this.projectDir(p) === directory)
      const activity = item?.time?.activity ?? 0
      if (activity > hideTime) {
        delete this._hiddenDirs[directory]
        changed = true
        console.log(`[${this.adapter.platform}] auto-restored hidden project:`, directory)
      }
    }
    if (changed) await this.saveHiddenDirs()
  }

  // ── Model helpers ──────────────────────────────────────────────────────────

  protected async buildModelList(): Promise<ModelEntry[]> {
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
      console.error(`[${this.adapter.platform}] buildModelList error:`, err)
      return []
    }
  }

  protected resolveModel(chatId: string): { providerID: ProviderID; modelID: ModelID } | undefined {
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
    return undefined
  }

  protected resolveModelStr(chatId: string): string {
    const m = this.resolveModel(chatId)
    return m ? `${m.providerID}/${m.modelID}` : "—"
  }

  protected effectiveDir(chatId: string): string {
    return this._chatDirs[chatId] ?? (this._initialDir || Instance.directory)
  }

  protected async clearRuntime(chatId: string): Promise<void> {
    delete this._pendingQuestions[chatId]
    delete this._questionProgress[chatId]
    delete this._pendingPermissions[chatId]
    delete this._pendingConfirmCreate[chatId]
    this._activePrompt.delete(chatId)
  }

  protected async commandCtx(chatId: string): Promise<{
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
    const modelStr = this.resolveModelStr(chatId)
    return { dir, sessionId, pref, projectName, sessionTitle, modeName, modelStr }
  }

  protected commandHeader(ctx: Awaited<ReturnType<typeof this.commandCtx>>): string {
    const mode = ctx.modeName.charAt(0).toUpperCase() + ctx.modeName.slice(1)
    return `${ctx.projectName}  ·  ${ctx.sessionTitle}  ·  ${mode}  ·  ${ctx.modelStr}\n————————\n`
  }

  protected async replyCmd(targetId: string, chatId: string, body: string): Promise<void> {
    if (!body.trim()) {
      await this.adapter.replyText(targetId, body)
      return
    }
    await this.adapter.replyText(targetId, this.commandHeader(await this.commandCtx(chatId)) + body)
  }

  protected async setPref(chatId: string, patch: Record<string, any>): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    await Instance.provide({
      directory: ctx.dir,
      fn: () => SessionPreference.update({ sessionID: SessionID.make(ctx.sessionId), ...patch }),
    })
  }

  protected async currentSession(chatId: string, create?: boolean): Promise<string | undefined> {
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
      fn: () => Session.create({ title: `${this.platformName()}对话 - ${new Date().toISOString()}` }),
    })
    this._chatSessions[chatId] = session.id
    return session.id
  }

  // ── Message handling ────────────────────────────────────────────────────────

  async handleMessage(chatId: string, messageId: string, text: string, rootId: string): Promise<void> {
    const reply = this.replyTarget(chatId, messageId)
    try {
      console.log(`[${this.adapter.platform}] handleMessage:`, text, localISOString())

      const isSlash = text.startsWith("/")
      const parts = isSlash ? text.trim().split(/\s+/) : []
      const cmd = isSlash ? text.trim().split(/\s+/)[0].toLowerCase() : ""

      if (cmd === "/h" || cmd === "/help") {
        await this.adapter.replyText(reply, parts[1]?.toLowerCase() === "list" ? HELP_LIST_TEXT : HELP_TEXT)
        return
      }

      await this.autoUnhide()

      if (isSlash && cmd !== "/stop" && cmd !== "/compact" && cmd !== "/c") {
        await this.handleCommand(text, reply, chatId)
        return
      }

      const effectiveDir = this.effectiveDir(chatId)

      if (effectiveDir in this._hiddenDirs) {
        delete this._hiddenDirs[effectiveDir]
        console.log(`[${this.adapter.platform}] auto-unhide via message:`, effectiveDir)
        void this.saveHiddenDirs()
      }

      if (cmd === "/stop") {
        const hasPending = chatId in this._pendingQuestions || chatId in this._pendingPermissions
        const active = this._activePrompt.get(chatId)
        if (!active && !hasPending) {
          await this.adapter.replyText(reply, "没有任务在执行")
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
        await this.adapter.replyText(reply, "✅ 已停止当前执行。")
        return
      }

      if (cmd === "/c" || cmd === "/compact") {
        const pendingQ = this._pendingQuestions[chatId]
        if (pendingQ) {
          const progress = this._questionProgress[chatId]
          await this.adapter.replyText(reply, this.formatSingleQuestion(pendingQ, progress?.index ?? 0))
          return
        }
        const pendingP = this._pendingPermissions[chatId]
        if (pendingP) {
          await this.adapter.replyText(reply, this.formatPermissionRequest(pendingP))
          return
        }
        const active = this._activePrompt.get(chatId)
        if (active) {
          await this.adapter.replyText(
            reply,
            "当前会话正在生成回复，请等待当前对话结束后再发送；如需立即开始新问题，请先 /new 或切换 /session n。如需停止本会话请输入 /stop",
          )
          return
        }

        if (!(chatId in this._chatSessions)) {
          await this.adapter.replyText(reply, "没有任务在执行")
          return
        }
        try {
          await this.cmdCompact(reply, chatId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await this.adapter.replyText(reply, `命令执行出错: ${msg}`)
        }
        return
      }

      const pendingConfirm = this._pendingConfirmCreate[chatId]
      if (pendingConfirm) {
        const lower = text.trim().toLowerCase()
        if (lower === "y" || lower === "yes" || lower === "确认") {
          await this.confirmCreateProject(chatId, reply, true)
        } else if (lower === "n" || lower === "no" || lower === "取消") {
          await this.confirmCreateProject(chatId, reply, false)
        } else {
          await this.adapter.replyText(reply, "请回复 y 确认创建或 n 取消。")
        }
        return
      }

      const pendingQ = this._pendingQuestions[chatId]
      if (pendingQ) {
        await this.handleQuestionReply(chatId, reply, text, pendingQ)
        return
      }
      const pendingP = this._pendingPermissions[chatId]
      if (pendingP) {
        await this.handlePermissionReply(chatId, reply, text, pendingP)
        return
      }

      const active = this._activePrompt.get(chatId)
      if (active) {
        await this.adapter.replyText(
          reply,
          "当前会话正在生成回复，请等待当前对话结束后再发送；如需立即开始新问题，请先 /new 或切换 /session n。如需停止本会话请输入 /stop",
        )
        return
      }

      await this.startPrompt(chatId, messageId, text, effectiveDir, rootId)
    } catch (err) {
      console.error(`[${this.adapter.platform}] handleMessage error:`, err)
      try {
        const errMsg = isSessionNotFound(err) ? "会话已不存在" : err instanceof Error ? err.message : String(err)
        await this.adapter.replyText(reply, `处理消息时出错: ${errMsg}`)
      } catch (e2) {
        console.error(`[${this.adapter.platform}] failed to send error reply:`, e2)
      }
    }
  }

  protected async startPrompt(
    chatId: string,
    messageId: string,
    text: string,
    effectiveDir: string,
    rootId: string,
  ): Promise<void> {
    const reply = this.replyTarget(chatId, messageId)
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
        console.log(`[${this.adapter.platform}] reusing existing session:`, sessionId)
      } else {
        console.log(`[${this.adapter.platform}] creating new session...`)
        const session = await Instance.provide({
          directory: effectiveDir,
          fn: () => Session.create({ title: `${this.platformName()}对话 - ${new Date().toISOString()}` }),
        })
        sessionId = session.id
        console.log(`[${this.adapter.platform}] session created:`, sessionId)
      }
      this._chatSessions[chatId] = sessionId
      this.sessionMap[sessionKey] = sessionId
      await this.saveSessionMap()
    }

    this._activePrompt.set(chatId, { sessionId, messageId, directory: effectiveDir })

    const model = this.resolveModel(chatId)
    console.log(`[${this.adapter.platform}] using model:`, model ?? "(default)")

    let promptText = text
    if (this.mightWantFile(text)) {
      promptText +=
        "\n\n[系统提示：如果用户的意图是获取某个文件，请在回复中包含该文件在当前系统上的完整绝对路径。Windows 示例：E:\\\\work\\\\demo\\\\file.md；macOS/Linux 示例：/Users/demo/file.md 或 /home/demo/file.md。系统将自动把该路径对应的文件作为附件发送给用户。如果用户无需获取文件，请忽略本提示，正常回复即可。]"
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

    console.log(`[${this.adapter.platform}] sending to aether, session:`, sessionId, localISOString())

    try {
      const msg = await Instance.provide({
        directory: effectiveDir,
        fn: () =>
          SessionPrompt.prompt({
            sessionID: SessionID.make(sessionId),
            parts: [{ type: "text", text: promptText }],
          }),
      })
      console.log(`[${this.adapter.platform}] aether responded, parts:`, msg?.parts?.length, localISOString())

      const responseText = this.extractResponseText(msg)
      if (responseText) {
        const msgModel =
          msg?.info?.role === "assistant" ? { providerID: msg.info.providerID, modelID: msg.info.modelID } : undefined
        if (msgModel && !SessionPreference.get(sessionId)?.model) {
          await Instance.provide({
            directory: effectiveDir,
            fn: () =>
              SessionPreference.update({
                sessionID: SessionID.make(sessionId),
                model: { providerID: ProviderID.make(msgModel.providerID), modelID: ModelID.make(msgModel.modelID) },
              }),
          })
        }
        const header = await this.formatHeader(chatId)
        console.log(`[${this.adapter.platform}] replying:`, responseText.slice(0, 100), localISOString())
        await this.adapter.replyText(reply, header + responseText)
      } else {
        console.log(`[${this.adapter.platform}] no text in response`)
      }

      let filesToSend = this.extractReadFiles(msg)
      if (filesToSend.length === 0 && responseText) {
        filesToSend = this.extractFilePathsFromText(responseText).slice(0, 1)
      }
      if (filesToSend.length > 0) {
        console.log(`[${this.adapter.platform}] sending`, filesToSend.length, "requested file(s)")
        for (const filePath of filesToSend.slice(0, 5)) {
          await this.adapter.replyFile(reply, filePath)
        }
      }
    } catch (err) {
      console.error(`[${this.adapter.platform}] prompt error:`, err)
      const errMsg = isSessionNotFound(err) ? "会话已不存在" : err instanceof Error ? err.message : String(err)
      await this.adapter.replyText(reply, `处理消息时出错: ${errMsg}`).catch(() => {})
    } finally {
      this._activePrompt.delete(chatId)
    }
  }

  protected enqueueMessage(chatId: string, messageId: string): boolean {
    if (messageId) {
      if (this._processedIds.has(messageId)) return false
      this._processedIds.set(messageId, Date.now())
      this.evictProcessedIds()
    }
    return true
  }

  private evictProcessedIds(): void {
    const now = Date.now()
    const maxAge = 300_000
    for (const [id, ts] of this._processedIds) {
      if (now - ts > maxAge) this._processedIds.delete(id)
    }
  }

  // ── Text extraction helpers ────────────────────────────────────────────────

  protected extractResponseText(msg: any): string | null {
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

  protected mightWantFile(text: string): boolean {
    const lower = text.toLowerCase()
    return ["发给我", "发来", "文件给我", "发过来", "发文件", "send me", "send file"].some((w) => lower.includes(w))
  }

  protected extractReadFiles(msg: any): string[] {
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

  protected extractFilePathsFromText(text: string): string[] {
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

  private isFilePath(p: string): boolean {
    if (!isAbsolute(p)) return false
    return existsSync(p)
  }

  // ── Command handlers ───────────────────────────────────────────────────────

  protected async handleCommand(text: string, targetId: string, chatId: string): Promise<void> {
    const parts = text.trim().split(/\s+/)
    const command = parts[0].toLowerCase()
    const rest = parts.slice(1).join(" ")

    try {
      if (command === "/n" || command === "/new") {
        await this.cmdNew(targetId, chatId)
      } else if (command === "/m" || command === "/model") {
        const args = parts.slice(1)
        if (args[0] === "l") args[0] = "list"
        await this.cmdModel(targetId, chatId, args)
      } else if (command === "/a" || command === "/agent") {
        await this.cmdAgent(targetId, chatId, rest)
      } else if (command === "/autoaccept") {
        await this.cmdAutoAccept(targetId, chatId, rest)
      } else if (command === "/variant") {
        await this.cmdVariant(targetId, chatId, rest)
      } else if (command === "/p" || command === "/project") {
        const arg = rest === "l" ? "list" : rest.startsWith("h ") ? `hide ${rest.slice(2).trim()}` : rest
        await this.cmdProject(targetId, chatId, arg)
      } else if (command === "/s" || command === "/session") {
        await this.cmdSession(targetId, chatId, rest === "l" ? "list" : rest)
      } else if (command === "/h" || command === "/help") {
        await this.adapter.replyText(targetId, rest.toLowerCase() === "list" ? HELP_LIST_TEXT : HELP_TEXT)
      } else {
        await this.adapter.replyText(
          targetId,
          `❓ 未知命令：${command}\n发送 /help 查看常用命令，/help list 查看全部命令。`,
        )
      }
    } catch (err) {
      console.error(`[${this.adapter.platform}] handleCommand error:`, err)
      const errMsg = err instanceof Error ? err.message : String(err)
      await this.adapter.replyText(targetId, `命令执行出错: ${errMsg}`).catch(() => {})
    }
  }

  protected async cmdNew(targetId: string, chatId: string): Promise<void> {
    for (const key of Object.keys(this.sessionMap)) {
      if (key.startsWith(`${chatId}:`)) delete this.sessionMap[key]
    }
    delete this._chatSessions[chatId]
    void this.clearRuntime(chatId)

    const dir = this.effectiveDir(chatId)
    const session = await Instance.provide({
      directory: dir,
      fn: () => Session.create({ title: `${this.platformName()}对话 - ${new Date().toISOString()}` }),
    })
    this._chatSessions[chatId] = session.id
    await this.saveSessionMap()
    await this.replyCmd(targetId, chatId, `✅ 已开启新对话\n💬 ${session.title}`)
  }

  protected async cmdModel(targetId: string, chatId: string, args: string[]): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    if (this._modelList.length === 0) {
      this._modelList = await this.buildModelList()
    }

    if (args.length === 0) {
      await this.replyCmd(targetId, chatId, this.formatModelList(ctx, false))
      return
    }

    if (args[0] === "list") {
      await this.replyCmd(targetId, chatId, this.formatModelList(ctx, true))
      return
    }

    const n = parseInt(args[0], 10)
    if (!isNaN(n) && n >= 1 && n <= this._modelList.length) {
      const entry = this._modelList[n - 1]
      await this.setPref(chatId, {
        model: { providerID: ProviderID.make(entry.providerID), modelID: ModelID.make(entry.modelID) },
      })
      await this.replyCmd(
        targetId,
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
        await this.replyCmd(targetId, chatId, `❌ 未找到模型：${arg}\n请先发送 /model 查看可用模型。`)
        return
      }
      await this.setPref(chatId, { model: { providerID: ProviderID.make(providerID), modelID: ModelID.make(modelID) } })
      await this.replyCmd(targetId, chatId, `✅ 已切换模型：${arg}\n（仅对当前对话生效，/new 后将重置）`)
      return
    }

    await this.replyCmd(targetId, chatId, "❌ 无效参数，请输入编号、list 或 provider/model 格式。")
  }

  protected formatModelList(ctx: Awaited<ReturnType<typeof this.commandCtx>>, full: boolean): string {
    const current = ctx.pref?.model

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

  protected async cmdCompact(targetId: string, chatId: string): Promise<void> {
    const ctx = await this.commandCtx(chatId)
    const model = this.resolveModel(chatId)
    if (!model) {
      await this.replyCmd(targetId, chatId, "❌ 压缩当前会话前，请先使用 /model 选择模型。")
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
    await this.replyCmd(targetId, chatId, "✅ 已开始压缩当前会话上下文，请稍后查看结果。")
  }

  protected async cmdAgent(targetId: string, chatId: string, arg: string): Promise<void> {
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
      await this.replyCmd(targetId, chatId, "❌ 无法获取模式列表，请检查 Aether 服务是否正常。")
      return
    }
    const visible = agents.filter((a) => !a.hidden)
    const names = visible.map((a) => a.name)
    if (!arg) {
      if (names.length === 0) {
        await this.replyCmd(targetId, chatId, "❌ 暂无可用模式。")
        return
      }
      const lines = ["🧠 可用模式：", ""]
      names.forEach((name, i) => {
        lines.push(`  ${i + 1}. ${name}${name === current ? " ★（当前）" : ""}`)
      })
      lines.push("", "💡 /a 编号或名称 切换模式")
      await this.replyCmd(targetId, chatId, lines.join("\n"))
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
        await this.replyCmd(targetId, chatId, `❌ 编号超出范围，请输入 1~${names.length} 之间的数字。`)
        return
      }
      await this.replyCmd(targetId, chatId, `❌ 未找到模式：${arg}，发送 /a 查看可用模式。`)
      return
    }
    await this.setPref(chatId, { agent: next })
    await this.replyCmd(targetId, chatId, `✅ 已切换模式：${next}\n（仅对当前对话生效，/new 后将重置）`)
  }

  protected async cmdAutoAccept(targetId: string, chatId: string, arg: string): Promise<void> {
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
      await this.replyCmd(targetId, chatId, lines.join("\n"))
      return
    }
    const n = parseInt(arg, 10)
    const next = /^\d+$/.test(arg) ? names[n - 1] : names.find((name) => name === arg)
    if (!next) {
      await this.replyCmd(targetId, chatId, "❌ 仅支持 1(auto) 或 2(ask)。")
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
        await this.replyCmd(targetId, chatId, "✅ 已开启自动接受权限，并已自动批准当前挂起的授权请求")
      } else {
        await this.replyCmd(targetId, chatId, "✅ 已开启自动接受权限\n（后续权限请求将自动批准）")
      }
    } else {
      await this.replyCmd(targetId, chatId, "✅ 已停止自动接受权限\n（后续权限请求将需要你确认）")
    }
  }

  protected async cmdVariant(targetId: string, chatId: string, arg: string): Promise<void> {
    const model = this.resolveModel(chatId)
    if (!model) {
      await this.replyCmd(targetId, chatId, "❌ 请先使用 /m 选择模型后再切换思考等级。")
      return
    }
    const ctx = await this.commandCtx(chatId)
    const info = await this.thinking(chatId)
    const names = ["默认", ...info.names]
    if (!arg) {
      const lines = ["🔀 可用思考等级：", ""]
      names.forEach((name, i) => {
        const active = name === "默认" ? !info.current : name === info.current
        lines.push(`  ${i + 1}. ${name}${active ? " ★（当前）" : ""}`)
      })
      lines.push("", "💡 /variant 编号或名称 切换思考等级")
      await this.replyCmd(targetId, chatId, lines.join("\n"))
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
        await this.replyCmd(targetId, chatId, `❌ 编号超出范围，请输入 1~${names.length} 之间的数字。`)
        return
      }
      await this.replyCmd(targetId, chatId, `❌ 未找到思考等级：${arg}，发送 /variant 查看可用思考等级。`)
      return
    }
    await this.setPref(chatId, { variant: next === "默认" ? undefined : next })
    await this.replyCmd(targetId, chatId, `✅ 已切换思考等级：${next}\n（仅对当前对话生效，/new 后将重置）`)
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

  protected async cmdProject(targetId: string, chatId: string, arg: string): Promise<void> {
    if (arg && this.isAbsolutePath(arg)) {
      await this.cmdProjectByPath(targetId, chatId, arg)
      return
    }
    const allProjects = this.getProjects()
    if (allProjects.length === 0) {
      await this.replyCmd(targetId, chatId, "❌ 无法获取项目列表，请检查 Aether 是否正常运行。")
      return
    }

    const visibleProjects = allProjects.filter((p) => !(this.projectDir(p) in this._hiddenDirs))
    const currentDir = this.effectiveDir(chatId)

    if (arg.startsWith("hide ")) {
      const delArg = arg.slice(5).trim()
      const idx = parseInt(delArg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= allProjects.length) {
        await this.replyCmd(targetId, chatId, `❌ 用法：/project hide n（n 为 1~${allProjects.length}）`)
        return
      }
      const target = allProjects[idx]
      const directory = this.projectDir(target)
      this._hiddenDirs[directory] = Date.now()
      await this.saveHiddenDirs()
      const name = this.projectName(target)
      await this.replyCmd(targetId, chatId, `✅ 已隐藏：${name}\n（在桌面端或消息端重新使用后自动恢复）`)
      return
    }

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
      await this.replyCmd(targetId, chatId, lines.join("\n"))
      return
    }

    if (arg) {
      const idx = parseInt(arg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= allProjects.length) {
        await this.replyCmd(targetId, chatId, `❌ 请输入 1~${allProjects.length} 之间的编号。`)
        return
      }
      const chosen = allProjects[idx]
      const newDir = this.projectDir(chosen)
      await this.switchToProject(targetId, chatId, newDir)
      return
    }

    if (visibleProjects.length === 0) {
      const hint =
        Object.keys(this._hiddenDirs).length > 0 ? `（有 ${Object.keys(this._hiddenDirs).length} 个项目已隐藏）` : ""
      await this.replyCmd(targetId, chatId, `❌ 未找到任何项目。${hint}`)
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
    await this.replyCmd(targetId, chatId, lines.join("\n"))
  }

  private async cmdProjectByPath(targetId: string, chatId: string, rawPath: string): Promise<void> {
    const normed = this.normDir(rawPath)
    if (this.isRootDir(normed)) {
      await this.replyCmd(targetId, chatId, "❌ 路径不合法：不能使用根目录。")
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
      await this.switchToProject(targetId, chatId, newDir)
      return
    }

    if (dirExists) {
      await this.switchToNewProject(targetId, chatId, normed)
      return
    }

    this._pendingConfirmCreate[chatId] = { path: normed }
    await this.replyCmd(
      targetId,
      chatId,
      `📂 路径不存在：${normed}\n回复 y 确认创建该文件夹并初始化项目，回复 n 取消。`,
    )
  }

  private async confirmCreateProject(chatId: string, targetId: string, yes: boolean): Promise<void> {
    const pending = this._pendingConfirmCreate[chatId]
    if (!pending) return
    delete this._pendingConfirmCreate[chatId]

    if (!yes) {
      await this.replyCmd(targetId, chatId, "已取消创建。")
      return
    }

    await mkdir(pending.path, { recursive: true })
    await this.switchToNewProject(targetId, chatId, pending.path)
  }

  protected async switchToProject(targetId: string, chatId: string, newDir: string): Promise<void> {
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
        const session = await Session.create({ title: `${this.platformName()}对话 - ${new Date().toISOString()}` })
        return { sessionId: session.id, sessionTitle: session.title, created: true }
      },
    })
    this._chatSessions[chatId] = newSessionId
    await this.saveSessionMap()

    const name = this.baseName(newDir)
    const note = created ? "已创建新会话" : `已进入该项目最新会话：${sessionTitle}`
    console.log(`[${this.adapter.platform}] /project switched:`, chatId, "->", newDir)
    await this.replyCmd(targetId, chatId, `✅ 已切换到：${name}\n   ${newDir}\n（${note}）`)
  }

  private async switchToNewProject(targetId: string, chatId: string, newDir: string): Promise<void> {
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
        const session = await Session.create({ title: `${this.platformName()}对话 - ${new Date().toISOString()}` })
        return { sessionId: session.id, sessionTitle: session.title, created: true }
      },
    })
    this._chatSessions[chatId] = newSessionId
    await this.saveSessionMap()

    const name = this.baseName(newDir)
    const note = created ? "已创建新会话" : `已进入该项目最新会话：${sessionTitle}`
    console.log(`[${this.adapter.platform}] /project created+switched:`, chatId, "->", newDir)
    await this.replyCmd(targetId, chatId, `✅ 已切换到：${name}\n   ${newDir}\n（${note}）`)
  }

  protected async cmdSession(targetId: string, chatId: string, arg: string): Promise<void> {
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
      await this.replyCmd(targetId, chatId, lines.join("\n"))
      return
    }

    if (arg) {
      const idx = parseInt(arg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        await this.replyCmd(
          targetId,
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
        targetId,
        chatId,
        `✅ 已切换到会话：${ctx.sessionTitle}\n   更新时间：${this.formatSessionTime(chosen.time.updated)}`,
      )
      return
    }

    if (!items.length) {
      const session = await Instance.provide({
        directory: effectiveDir,
        fn: () => Session.create({ title: `${this.platformName()}对话 - ${new Date().toISOString()}` }),
      })
      this._chatSessions[chatId] = session.id
      await this.replyCmd(targetId, chatId, "📂 当前项目下还没有任何会话，已自动创建一个新会话并切换。")
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
    await this.replyCmd(targetId, chatId, lines.join("\n"))
  }

  private formatSessionTime(timestamp: number): string {
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }

  // ── Question/Permission handlers ───────────────────────────────────────────

  protected async formatHeader(chatId: string): Promise<string> {
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
    const modelStr = this.resolveModelStr(chatId)
    return `${projectName}  ·  ${label}  ·  ${mode}  ·  ${modelStr}\n————————\n`
  }

  private async sessionTitle(sessionId: string, directory: string): Promise<string> {
    const info = await Instance.provide({
      directory,
      fn: () => [...Session.list({ directory, roots: true, limit: 100 })].find((s) => s.id === sessionId),
    })
    return info?.title ?? sessionId.slice(0, 8)
  }

  protected formatQuestionOverview(q: Question.Request): string {
    const parts = ["🤔 Agent 需要您回答以下问题：", ""]
    for (let i = 0; i < q.questions.length; i++) {
      parts.push(`${i + 1}. ${q.questions[i].header}`)
    }
    parts.push("")
    parts.push("请逐个回答，我们将按顺序引导您。")
    return parts.join("\n")
  }

  protected formatSingleQuestion(q: Question.Request, index: number): string {
    const info = q.questions[index]
    const parts = [`🤔 问题 ${index + 1}/${q.questions.length}：${info.question}`]
    if (info.options?.length) {
      parts.push("")
      parts.push("可选答案：")
      for (let j = 0; j < info.options.length; j++) {
        const opt = info.options[j]
        const suffix = opt.description ? `：${opt.description}` : ""
        parts.push(`  ${j + 1}. ${opt.label}${suffix}`)
      }
    }
    parts.push("")
    parts.push("请直接回复答案（可输入数字编号；若题目允许自定义，也可直接输入文本）。")
    return parts.join("\n")
  }

  protected formatPermissionRequest(p: Permission.Request): string {
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

  private parseSingleAnswer(text: string, info: Question.Info): string[] | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const options = info.options ?? []
    if (options.length > 0 && trimmed.match(/^\d+$/)) {
      const idx = parseInt(trimmed) - 1
      if (idx >= 0 && idx < options.length) return [options[idx].label]
      if (!info.custom) return null
    } else if (options.length > 0 && !info.custom) {
      const match = options.find((o) => o.label === trimmed)
      if (!match) return null
      return [match.label]
    }
    return [trimmed]
  }

  private async handleQuestionReply(
    chatId: string,
    targetId: string,
    text: string,
    pending: Question.Request,
  ): Promise<void> {
    const progress = this._questionProgress[chatId]
    if (!progress) return
    const info = pending.questions[progress.index]
    const answer = this.parseSingleAnswer(text, info)
    if (!answer) {
      await this.adapter.replyText(
        targetId,
        "未识别，请回复答案或数字编号。\n\n" + this.formatSingleQuestion(pending, progress.index),
      )
      return
    }
    progress.answers.push(answer)
    progress.index += 1
    if (progress.index < pending.questions.length) {
      await this.adapter.replyText(targetId, `✅ 已收到问题 ${progress.index} 的回答。`)
      await this.adapter.replyText(targetId, this.formatSingleQuestion(pending, progress.index))
      return
    }
    const active = this._activePrompt.get(chatId)
    delete this._pendingQuestions[chatId]
    delete this._questionProgress[chatId]
    try {
      await Instance.provide({
        directory: active?.directory ?? this.effectiveDir(chatId),
        fn: () => Question.reply({ requestID: pending.id, answers: progress.answers }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._pendingQuestions[chatId] = pending
      this._questionProgress[chatId] = progress
      await this.adapter.replyText(targetId, `❌ 提交答案失败: ${msg}\n请重新发送您的答案。`)
      return
    }
    await this.adapter.replyText(targetId, "✅ 所有问题已回答完毕，请等待当前对话继续处理。")
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
    targetId: string,
    text: string,
    pending: Permission.Request,
  ): Promise<void> {
    const reply = this.parsePermissionReply(text)
    if (!reply) {
      await this.adapter.replyText(targetId, "未识别，请回复数字编号。\n\n" + this.formatPermissionRequest(pending))
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
      await this.adapter.replyText(targetId, `❌ 提交授权失败: ${msg}\n请重新发送您的选择。`)
      return
    }
    const notice = {
      once: "已收到授权：允许一次，继续处理中。",
      always: "已收到授权：始终允许，继续处理中。",
      reject: "已收到你的选择：拒绝，正在继续处理。",
    }[reply]
    await this.adapter.replyText(targetId, notice)
  }

  // ── Bus subscription for question/permission ──────────────────────────────

  protected subscribeBusEvents(): void {
    const onQuestion = (event: { directory?: string; payload: any }) => {
      if (event.payload?.type !== "question.asked") return
      const q = event.payload.properties as Question.Request
      for (const [chatId, info] of this._activePrompt) {
        if (info.sessionId === q.sessionID) {
          this._pendingQuestions[chatId] = q
          this._questionProgress[chatId] = { index: 0, answers: [] }
          const target = this.replyTarget(chatId, info.messageId)
          if (q.questions.length > 1) {
            void this.adapter.replyText(target, this.formatQuestionOverview(q))
          }
          void this.adapter.replyText(target, this.formatSingleQuestion(q, 0))
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
          void this.adapter.replyText(this.replyTarget(chatId, info.messageId), this.formatPermissionRequest(p))
          return
        }
      }
    }
    GlobalBus.on("event", onPermission)
    this._busUnsubs.push(() => GlobalBus.off("event", onPermission))

    this._globalBusListener = (event) => {
      const dir = event.directory ? this.normDir(event.directory) : null
      if (!dir || !(dir in this._hiddenDirs)) return
      delete this._hiddenDirs[dir]
      console.log(`[${this.adapter.platform}] auto-unhide via GlobalBus activity:`, dir)
      void this.saveHiddenDirs()
    }
    GlobalBus.on("event", this._globalBusListener)
  }

  protected unsubscribeBusEvents(): void {
    if (this._globalBusListener) {
      GlobalBus.off("event", this._globalBusListener)
      this._globalBusListener = null
    }
    for (const unsub of this._busUnsubs) unsub()
    this._busUnsubs = []
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  protected async saveSessionMap(): Promise<void> {
    await mkdir(this.dir(), { recursive: true })
    await writeFile(this.file("sessions.json"), JSON.stringify(this.sessionMap, null, 2))
  }

  protected async loadSessionMap(): Promise<SessionMapKey> {
    try {
      const next = this.readPath("sessions.json")
      if (existsSync(next)) {
        const data = await readFile(next, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return {}
  }

  protected async saveHiddenDirs(): Promise<void> {
    await mkdir(this.dir(), { recursive: true })
    await writeFile(this.file("hidden_projects.json"), JSON.stringify(this._hiddenDirs, null, 2))
  }

  protected async loadHiddenDirs(): Promise<Record<string, number>> {
    try {
      const next = this.readPath("hidden_projects.json")
      if (existsSync(next)) {
        const data = await readFile(next, "utf-8")
        return JSON.parse(data)
      }
    } catch {}
    return {}
  }

  async clearSession(): Promise<void> {
    try {
      await rm(this.file("sessions.json"), { force: true })
      await rm(this.file("hidden_projects.json"), { force: true })
      this.sessionMap = {}
      this._hiddenDirs = {}
    } catch {}
    await this.adapter.clearAuth()
  }
}
