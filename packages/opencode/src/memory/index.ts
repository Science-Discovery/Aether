import fs from "fs/promises"
import { mkdirSync } from "fs"
import path from "path"
import { Database as BunSqlite } from "bun:sqlite"
import { ulid } from "ulid"
import z from "zod"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Global } from "@/global"
import { Database } from "@/storage/db"
import { Config } from "@/config/config"
import { Session } from "@/session"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Auth } from "@/auth"
import { Lock } from "@/util/lock"
import {
  emptyMemoryDocument,
  parseMemoryMarkdown,
  renderMemoryDocument,
  type MemoryBlock,
  type MemoryDocument,
  type MemoryScope,
  type MemoryType,
} from "./markdown"
import { searchMemoryDocument, type MemorySearchInput } from "./search"
import { hasForgetIntent, hasSensitiveSignal, shouldQuickReflect } from "./gate"

type Role = "user" | "assistant" | "system" | "tool"
type EventStatus =
  | "new"
  | "pending_important"
  | "applied"
  | "ignored"
  | "deleted"
  | "forgot"
  | "deprecated"
  | "superseded"

type MemoryEvent = {
  id: string
  created_at: number
  op: "remember" | "forget"
  type: MemoryType | null
  intent: "explicit" | "observed"
  raw_text: string
  channel_id: string | null
  project_id: string | null
  session_id: string | null
  message_id: string | null
  role: Role | null
  source_json: string
  candidate_key: string | null
  candidate_summary: string | null
  confidence_hint: number | null
  status: EventStatus
  reflected_at: number | null
  result_json: string | null
}

type Paths = {
  globalMemoryDir: string
  channelRootDir: string
  channelID: string
}

type SessionForInitialization = {
  channelID: string
  projectID?: string
  sessionID: string
  messages: Array<{ role: "user" | "assistant"; text: string; createdAt: number }>
}

type InitializerCandidate = {
  text: string
  type?: MemoryType
  scope?: MemoryScope
}

type ReflectionCandidate = {
  eventID: string
  type: MemoryType
  scope: MemoryScope
  memory: string
  confidence: number
  weight: number
  evidence: string
}

let overridePaths: Paths | undefined
let documentCache: { path: string; mtimeMs: number; doc: MemoryDocument } | undefined
let db: BunSqlite | undefined
let initializeCancelled = false
let scannerForTest: (() => AsyncGenerator<SessionForInitialization>) | undefined
let extractorForTest: ((session: SessionForInitialization) => Promise<InitializerCandidate[]>) | undefined
let startupCatchupStarted = false
let reflectorForTest:
  | ((input: { events: MemoryEvent[]; doc: MemoryDocument; mode: "quick" | "daily" | "manual" }) => Promise<ReflectionCandidate[]>)
  | undefined

const ReflectionOutput = z.object({
  candidates: z.array(
    z.object({
      event_id: z.string(),
      type: z.enum(["preference", "fact", "task"]),
      scope: z.string(),
      memory: z.string().min(1),
      confidence: z.number().min(0).max(1).optional(),
      weight: z.number().min(0).max(1).optional(),
      evidence: z.string().optional(),
    }),
  ),
})

const InitializationOutput = z.object({
  candidates: z.array(
    z.object({
      type: z.enum(["preference", "fact", "task"]),
      scope: z.string(),
      memory: z.string().min(1),
      evidence: z.string().optional(),
    }),
  ),
})

const ForgetDecisionOutput = z.object({
  delete_ids: z.array(z.string()),
  keep_ids: z.array(z.string()).optional(),
  reason: z.string().optional(),
})

function defaultPaths(): Paths {
  return {
    globalMemoryDir: path.join(Global.Path.data, "memory"),
    channelRootDir: Global.Path.data,
    channelID: path.basename(Database.channelDir()),
  }
}

function paths() {
  return overridePaths ?? defaultPaths()
}

function currentChannelDir() {
  const p = paths()
  return path.join(p.channelRootDir, p.channelID)
}

function dbPath(channelID = paths().channelID) {
  return path.join(paths().channelRootDir, channelID, "memory.db")
}

function mdPath() {
  return path.join(paths().globalMemoryDir, "AETHER_MEMORY.md")
}

function statePath() {
  return path.join(paths().globalMemoryDir, "reflection-state.json")
}

function memoryLockPath() {
  return path.join(paths().globalMemoryDir, "AETHER_MEMORY.lock")
}

async function ensureDirs() {
  await fs.mkdir(paths().globalMemoryDir, { recursive: true })
  await fs.mkdir(currentChannelDir(), { recursive: true })
}

function initDb(sqlite: BunSqlite) {
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = NORMAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec(`CREATE TABLE IF NOT EXISTS memory_event (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('remember', 'forget')),
    type TEXT CHECK (type IN ('preference', 'fact', 'task')),
    intent TEXT NOT NULL CHECK (intent IN ('explicit', 'observed')),
    raw_text TEXT NOT NULL,
    channel_id TEXT,
    project_id TEXT,
    session_id TEXT,
    message_id TEXT,
    role TEXT CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    source_json TEXT NOT NULL,
    candidate_key TEXT,
    candidate_summary TEXT,
    confidence_hint REAL,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'pending_important', 'applied', 'ignored', 'deleted', 'forgot', 'deprecated', 'superseded')),
    reflected_at INTEGER,
    result_json TEXT
  )`)
  sqlite.exec("CREATE INDEX IF NOT EXISTS memory_event_created_idx ON memory_event(created_at)")
  sqlite.exec("CREATE INDEX IF NOT EXISTS memory_event_status_idx ON memory_event(status)")
  sqlite.exec("CREATE INDEX IF NOT EXISTS memory_event_candidate_key_idx ON memory_event(candidate_key)")
  sqlite.exec("CREATE INDEX IF NOT EXISTS memory_event_project_created_idx ON memory_event(project_id, created_at)")
  sqlite.exec("CREATE INDEX IF NOT EXISTS memory_event_session_created_idx ON memory_event(session_id, created_at)")
  sqlite.exec(`CREATE TABLE IF NOT EXISTS reflection_run (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('quick', 'daily', 'manual')),
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    model TEXT,
    input_event_ids_json TEXT,
    md_before_hash TEXT,
    md_after_hash TEXT,
    summary_json TEXT,
    error TEXT
  )`)
  sqlite.exec("CREATE TABLE IF NOT EXISTS memory_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  return sqlite
}

function openDb() {
  if (db) return db
  mkdirSync(path.dirname(dbPath()), { recursive: true })
  const sqlite = initDb(new BunSqlite(dbPath(), { create: true }))
  db = sqlite
  return sqlite
}

function openDbForChannel(channelID: string) {
  if (channelID === paths().channelID) return { database: openDb(), close: () => undefined }
  mkdirSync(path.dirname(dbPath(channelID)), { recursive: true })
  const database = initDb(new BunSqlite(dbPath(channelID), { create: true }))
  return {
    database,
    close: () => database.close(),
  }
}

function invalidateDocumentCache() {
  documentCache = undefined
}

async function readDocument() {
  return readDocumentWithOptions({ createIfMissing: true })
}

async function readDocumentWithOptions(input: { createIfMissing: boolean }) {
  await ensureDirs()
  const file = mdPath()
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat) {
    const doc = emptyMemoryDocument()
    if (input.createIfMissing) await writeDocument(doc)
    return doc
  }
  if (documentCache && documentCache.path === file && documentCache.mtimeMs === stat.mtimeMs) return documentCache.doc
  const doc = parseMemoryMarkdown(await fs.readFile(file, "utf8"))
  documentCache = { path: file, mtimeMs: stat.mtimeMs, doc }
  return doc
}

async function writeDocument(doc: MemoryDocument) {
  await ensureDirs()
  using _ = await Lock.write(memoryLockPath())
  const file = mdPath()
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const rendered = renderMemoryDocument({ ...doc, updated_at: new Date().toISOString() })
  parseMemoryMarkdown(rendered)
  await fs.writeFile(tmp, rendered)
  await fs.rename(tmp, file)
  invalidateDocumentCache()
}

function insertEvent(input: {
  op: "remember" | "forget"
  type?: MemoryType | null
  intent?: "explicit" | "observed"
  text: string
  status?: EventStatus
  source: {
    createdAt: number
    channelID?: string
    projectID?: string
    sessionID?: string
    messageID?: string
    role?: Role
    [key: string]: unknown
  }
  result?: unknown
}) {
  const event = {
    id: `mem_${ulid()}`,
    created_at: input.source.createdAt,
    op: input.op,
    type: input.type ?? null,
    intent: input.intent ?? "observed",
    raw_text: input.text,
    channel_id: input.source.channelID ?? paths().channelID,
    project_id: input.source.projectID ?? null,
    session_id: input.source.sessionID ?? null,
    message_id: input.source.messageID ?? null,
    role: input.source.role ?? null,
    source_json: JSON.stringify(input.source),
    candidate_key: null,
    candidate_summary: null,
    confidence_hint: null,
    status: input.status ?? "new",
    reflected_at: null,
    result_json: input.result ? JSON.stringify(input.result) : null,
  }
  openDb()
    .prepare(
      `INSERT INTO memory_event (
        id, created_at, op, type, intent, raw_text, channel_id, project_id, session_id, message_id, role,
        source_json, candidate_key, candidate_summary, confidence_hint, status, reflected_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.created_at,
      event.op,
      event.type,
      event.intent,
      event.raw_text,
      event.channel_id,
      event.project_id,
      event.session_id,
      event.message_id,
      event.role,
      event.source_json,
      event.candidate_key,
      event.candidate_summary,
      event.confidence_hint,
      event.status,
      event.reflected_at,
      event.result_json,
    )
  return event
}

function sessionHasMemorySignal(session: SessionForInitialization) {
  const userText = session.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text)
    .join("\n")
  return shouldQuickReflect({ text: userText, intent: "observed", op: "remember", shortcutTriggers: [] }).shouldRun
}

function sessionLooksWorthLLMInitialization(session: SessionForInitialization) {
  const userMessages = session.messages.filter((message) => message.role === "user" && message.text.trim())
  if (userMessages.length === 0) return false
  const text = userMessages.map((message) => message.text).join("\n")
  if (hasSensitiveSignal(text)) return false
  if (text.length >= 120) return true
  if (userMessages.length >= 2) return true
  return /(我|my|prefer|preference|project|项目|默认|以后|喜欢|偏好|希望|倾向|常用|习惯|每天|定期|提醒|remember)/i.test(text)
}

function extractRuleMemoryCandidates(session: SessionForInitialization): InitializerCandidate[] {
  const candidates: InitializerCandidate[] = []
  for (const message of session.messages) {
    if (message.role !== "user") continue
    const decision = shouldQuickReflect({
      text: message.text,
      intent: "observed",
      op: "remember",
      shortcutTriggers: [],
    })
    if (!decision.shouldRun) continue
    const text = sanitizeMemoryText(message.text)
    if (!text || hasSensitiveSignal(text)) continue
    const type = classifyType(text)
    candidates.push({
      text,
      type,
      scope: inferScope({ text, type, projectID: session.projectID }),
    })
  }
  return candidates.slice(0, 8)
}

async function extractMemoryCandidates(session: SessionForInitialization): Promise<InitializerCandidate[]> {
  const ruleCandidates = extractRuleMemoryCandidates(session)
  if (ruleCandidates.length > 0) return ruleCandidates
  if (!sessionLooksWorthLLMInitialization(session)) return []
  return llmInitializeExtractor(session).catch(() => [])
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function readReflectionState(): Promise<Record<string, unknown>> {
  return fs
    .readFile(statePath(), "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => ({}))
}

async function writeReflectionState(patch: Record<string, unknown>) {
  await ensureDirs()
  const current = await readReflectionState()
  await fs.writeFile(statePath(), JSON.stringify({ ...current, ...patch }, null, 2))
}

function dateKey(time: number) {
  return new Date(time).toISOString().slice(0, 10)
}

function textFromMessage(message: { parts?: Array<{ type?: string; text?: string }>; info?: { role?: string } }) {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

async function* defaultSessionScanner(): AsyncGenerator<SessionForInitialization> {
  for (const listed of Session.listGlobal({ limit: 500, archivedMode: "exclude" })) {
    const project = listed.project
    const messages = await Instance.provide({
      directory: listed.directory,
      create: false,
      project: project
        ? {
            id: project.id,
            worktree: project.worktree,
            time: { created: Date.now(), updated: Date.now() },
            sandboxes: [],
          }
        : undefined,
      worktree: project?.worktree,
      fn: () => Session.messages({ sessionID: listed.id }).catch(() => []),
    })
    yield {
      channelID: paths().channelID,
      projectID: listed.projectID,
      sessionID: listed.id,
      messages: messages
        .map((message) => ({
          role: message.info.role,
          text: textFromMessage(message),
          createdAt: message.info.time.created,
        }))
        .filter(
          (message): message is { role: "user" | "assistant"; text: string; createdAt: number } =>
            (message.role === "user" || message.role === "assistant") && Boolean(message.text),
        ),
    }
  }
}

function classifyType(text: string, hinted?: MemoryType | null): MemoryType {
  if (hinted) return hinted
  if (/(待办|之后|每天|定期|提醒|继续|follow up|todo|remind|schedule|daily)/i.test(text)) return "task"
  if (/(我喜欢|我偏好|我希望|默认|以后|倾向|prefer|preference|by default|always)/i.test(text)) return "preference"
  return "fact"
}

function inferScope(input: { text: string; type: MemoryType; projectID?: string | null; sourceJson?: string }): MemoryScope {
  const sourceScope = (() => {
    if (!input.sourceJson) return undefined
    try {
      const parsed = JSON.parse(input.sourceJson) as { scope?: string }
      return typeof parsed.scope === "string" ? parsed.scope : undefined
    } catch {
      return undefined
    }
  })()
  if (sourceScope === "global" || sourceScope?.startsWith("project:")) return sourceScope as MemoryScope
  if (input.projectID && /(这个项目|当前项目|此 repo|这个 repo|this project|current project|this repo)/i.test(input.text)) {
    return `project:${input.projectID}`
  }
  if (input.type === "task" && input.projectID) return `project:${input.projectID}`
  return "global"
}

function sanitizeMemoryText(text: string) {
  return text
    .replace(/^\s*(请|麻烦)?\s*(记住|remember|keep in mind|please note)[：:\s]*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
}

function prefixForType(type: MemoryType) {
  if (type === "preference") return "PREF"
  if (type === "task") return "TASK"
  return "FACT"
}

function candidateKey(input: Pick<ReflectionCandidate, "type" | "scope" | "memory">) {
  return `${input.type}:${input.scope}:${input.memory.toLowerCase().replace(/\s+/g, " ").slice(0, 96)}`
}

function memoryTopic(input: string) {
  const text = input.toLowerCase()
  if (/(回答|回复|answer|response|verbose|concise|详细|简短|短回答|长回答)/i.test(text)) return "response-style"
  if (/(中文|英文|language|chinese|english)/i.test(text)) return "language"
  if (/(bun|node|typescript|javascript|runtime)/i.test(text)) return "runtime"
  return text.replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean).slice(0, 4).join(" ")
}

function conflictsWith(existing: MemoryBlock, candidate: ReflectionCandidate) {
  if (existing.status !== "active") return false
  if (existing.id === candidate.eventID) return false
  if (existing.type !== candidate.type || existing.scope !== candidate.scope) return false
  const topic = memoryTopic(candidate.memory)
  if (!topic || topic !== memoryTopic(existing.memory)) return false
  if (existing.memory === candidate.memory) return false
  return true
}

function buildShortcut(candidate: ReflectionCandidate) {
  const words = candidate.memory
    .split(/[\s,，;；、|/\\]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 6)
  return {
    shortcut: `${candidate.type}:${candidate.scope}`,
    triggers: [...new Set(words.length ? words : [candidate.type])],
    types: [candidate.type],
    target_ids: [] as string[],
    weight: Math.max(0.5, candidate.weight),
    instruction: `Call memory_search before tasks related to ${candidate.type} ${candidate.scope}.`,
  }
}

function reflectEvent(event: MemoryEvent): ReflectionCandidate | undefined {
  if (event.op !== "remember") return
  const text = sanitizeMemoryText(event.raw_text)
  if (!text) return
  if (event.intent !== "explicit" && hasSensitiveSignal(text)) return
  const type = classifyType(text, event.type)
  return {
    eventID: event.id,
    type,
    scope: inferScope({ text, type, projectID: event.project_id, sourceJson: event.source_json }),
    memory: text,
    confidence: event.intent === "explicit" ? 0.9 : 0.68,
    weight: event.intent === "explicit" ? 0.86 : 0.55,
    evidence: event.intent === "explicit" ? "用户明确请求记住。" : "从用户会话中提取到的长期信号。",
  }
}

async function deterministicReflector(input: { events: MemoryEvent[] }) {
  return input.events.map(reflectEvent).filter((item) => item !== undefined)
}

function compactDocForLLM(doc: MemoryDocument) {
  return {
    shortcuts: doc.shortcuts.slice(0, 50).map((shortcut) => ({
      shortcut: shortcut.shortcut,
      triggers: shortcut.triggers,
      types: shortcut.types,
      weight: shortcut.weight,
    })),
    memories: doc.memories.slice(0, 200).map((memory) => ({
      id: memory.id,
      type: memory.type,
      scope: memory.scope,
      memory: memory.memory,
      confidence: memory.confidence,
      weight: memory.weight,
      status: memory.status,
    })),
  }
}

function clamp01(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

function normalizeLLMScope(value: string, fallback: MemoryScope) {
  if (value === "global") return value
  if (/^project:[A-Za-z0-9_.:-]+$/.test(value)) return value as MemoryScope
  return fallback
}

async function llmReflector(input: {
  events: MemoryEvent[]
  doc: MemoryDocument
  mode: "quick" | "daily" | "manual"
}): Promise<ReflectionCandidate[]> {
  if (!input.events.length) return []
  const model = await Provider.defaultModel()
  const resolved = await Provider.getModel(model.providerID, model.modelID)
  const language = await Provider.getLanguage(resolved)
  const system = [
    "You are Aether's memory reflection engine.",
    "Convert raw memory events into durable long-term memory candidates.",
    "Return only JSON that matches the schema.",
    "Allowed memory types: preference, fact, task.",
    "Allowed scopes: global or project:<project_id>.",
    "Do not create a candidate for one-off questions, transient chat, or low-confidence guesses.",
    "Do not create a candidate from sensitive observed data such as IDs, passwords, addresses, phone numbers, medical, political, or religious information unless the user explicitly asked to remember it.",
    "Prefer global for user-level preferences and profile-like facts.",
    "Prefer project:<project_id> for project constraints, project facts, and project tasks.",
    "Merge duplicates conceptually by returning the cleanest concise memory text.",
    input.mode === "quick"
      ? "Quick mode: analyze only the provided user-origin memory events and decide whether each event is worth writing as durable memory."
      : "Heavy mode: organize memories by topic. For each type/scope/topic combination, emit at most one candidate. When multiple events or existing memories concern the same theme, merge complementary details into one coherent topical memory instead of separate fragmented entries.",
    input.mode === "quick"
      ? "Quick mode: do not rely on current memory context; it is intentionally omitted to save tokens."
      : "Heavy mode: use current_memory to group related preferences, facts, and tasks under stable themes such as response style, language, tools, project workflow, research interests, and recurring tasks. If two candidate memories would share the same theme, combine them before returning JSON.",
    "Do not expose raw event IDs inside memory or evidence; use event_id only in the structured field.",
  ].join("\n")
  const userMessage: ModelMessage = {
    role: "user",
    content: JSON.stringify(
      {
        mode: input.mode,
        current_memory: input.mode === "quick" ? { shortcuts: [], memories: [] } : compactDocForLLM(input.doc),
        events: input.events.map((event) => ({
          id: event.id,
          op: event.op,
          type_hint: event.type,
          intent: event.intent,
          raw_text: event.raw_text,
          channel_id: event.channel_id,
          project_id: event.project_id,
          session_id: event.session_id,
          role: event.role,
          created_at: event.created_at,
        })),
      },
      null,
      2,
    ),
  }
  const params = {
    model: language,
    temperature: 0,
    schema: ReflectionOutput,
    messages: [
      { role: "system", content: system },
      userMessage,
    ],
  } satisfies Parameters<typeof generateObject>[0]

  const authInfo = await Auth.get(model.providerID)
  const object =
    model.providerID === "openai" && authInfo?.type === "oauth"
      ? await (async () => {
          const result = streamObject({
            ...params,
            messages: [userMessage],
            providerOptions: ProviderTransform.providerOptions(resolved, {
              store: false,
              instructions: system,
            }),
            onError: () => {},
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
          }
          return result.object
        })()
      : await generateObject(params).then((result) => result.object)

  const byID = new Map(input.events.map((event) => [event.id, event]))
  return object.candidates
    .map((candidate) => {
      const event = byID.get(candidate.event_id)
      if (!event) return
      const type = classifyType(candidate.memory, candidate.type)
      const fallbackScope = inferScope({ text: candidate.memory, type, projectID: event.project_id, sourceJson: event.source_json })
      return {
        eventID: event.id,
        type,
        scope: normalizeLLMScope(candidate.scope, fallbackScope),
        memory: sanitizeMemoryText(candidate.memory),
        confidence: clamp01(candidate.confidence, event.intent === "explicit" ? 0.86 : 0.68),
        weight: clamp01(candidate.weight, event.intent === "explicit" ? 0.82 : 0.55),
        evidence: (candidate.evidence || (event.intent === "explicit" ? "用户明确请求记住。" : "由 LLM 反思提取。")).slice(0, 180),
      } satisfies ReflectionCandidate
    })
    .filter((item): item is ReflectionCandidate => item !== undefined && item.memory.length > 0)
}

async function llmInitializeExtractor(session: SessionForInitialization): Promise<InitializerCandidate[]> {
  const model = await Provider.defaultModel()
  const resolved = await Provider.getModel(model.providerID, model.modelID)
  const language = await Provider.getLanguage(resolved)
  const system = [
    "You are Aether's one-time memory initialization extractor.",
    "Read one historical session and extract only stable, useful long-term memory candidates.",
    "Return only JSON that matches the schema.",
    "Allowed memory types: preference, fact, task.",
    "Allowed scopes: global or project:<project_id>.",
    "Only user messages are provided. Do not infer memories that require unavailable assistant context.",
    "Do not record one-off questions, transient commands, ordinary chat, tool outputs, or completed reminders.",
    "Do not record sensitive data such as IDs, passwords, addresses, phone numbers, medical, political, or religious information.",
    "Prefer global for user-level preferences and profile-like facts.",
    "Prefer project:<project_id> for project constraints, project facts, and project tasks.",
    "Keep each memory concise and self-contained.",
  ].join("\n")
  const messages = session.messages
    .filter((message) => message.role === "user")
    .slice(-30)
    .map((message) => ({
      role: message.role,
      created_at: message.createdAt,
      text: message.text.slice(0, 1200),
    }))
  const userMessage: ModelMessage = {
    role: "user",
    content: JSON.stringify(
      {
        channel_id: session.channelID,
        project_id: session.projectID,
        session_id: session.sessionID,
        messages,
      },
      null,
      2,
    ),
  }
  const params = {
    model: language,
    temperature: 0,
    schema: InitializationOutput,
    messages: [
      { role: "system", content: system },
      userMessage,
    ],
  } satisfies Parameters<typeof generateObject>[0]
  const authInfo = await Auth.get(model.providerID)
  const object =
    model.providerID === "openai" && authInfo?.type === "oauth"
      ? await (async () => {
          const result = streamObject({
            ...params,
            messages: [userMessage],
            providerOptions: ProviderTransform.providerOptions(resolved, {
              store: false,
              instructions: system,
            }),
            onError: () => {},
          })
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
          }
          return result.object
        })()
      : await generateObject(params).then((result) => result.object)

  return object.candidates
    .map((candidate): InitializerCandidate | undefined => {
      const type = classifyType(candidate.memory, candidate.type)
      const text = sanitizeMemoryText(candidate.memory)
      if (!text || hasSensitiveSignal(text)) return
      return {
        text,
        type,
        scope: normalizeLLMScope(candidate.scope, inferScope({ text, type, projectID: session.projectID })),
      } satisfies InitializerCandidate
    })
    .filter((item): item is InitializerCandidate => item !== undefined)
    .slice(0, 8)
}

async function llmForgetDecide(input: { query: string; candidates: MemoryBlock[] }) {
  const model = await Provider.defaultModel()
  const resolved = await Provider.getModel(model.providerID, model.modelID)
  const language = await Provider.getLanguage(resolved)
  const system = [
    "You decide which long-term memory blocks should be forgotten.",
    "Return only JSON that matches the schema.",
    "Delete only memories clearly targeted by the user's forget request.",
    "If the request is ambiguous or no candidate truly matches, return an empty delete_ids array.",
  ].join("\n")
  const userMessage: ModelMessage = {
    role: "user",
    content: JSON.stringify(
      {
        request: input.query,
        candidates: input.candidates.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          scope: candidate.scope,
          memory: candidate.memory,
          evidence: candidate.evidence,
        })),
      },
      null,
      2,
    ),
  }
  const params = {
    model: language,
    temperature: 0,
    schema: ForgetDecisionOutput,
    messages: [
      { role: "system", content: system },
      userMessage,
    ],
  } satisfies Parameters<typeof generateObject>[0]
  const authInfo = await Auth.get(model.providerID)
  const result =
    model.providerID === "openai" && authInfo?.type === "oauth"
      ? await (async () => {
          const stream = streamObject({
            ...params,
            messages: [userMessage],
            providerOptions: ProviderTransform.providerOptions(resolved, {
              store: false,
              instructions: system,
            }),
            onError: () => {},
          })
          for await (const part of stream.fullStream) {
            if (part.type === "error") throw part.error
          }
          return stream.object
        })()
      : await generateObject(params).then((output) => output.object)
  const allowed = new Set(input.candidates.map((candidate) => candidate.id))
  const deleteIDs = result.delete_ids.filter((id) => allowed.has(id))
  const keepIDs = (result.keep_ids ?? []).filter((id) => allowed.has(id))
  return {
    deleteIDs,
    keepIDs,
    reason: result.reason ?? "LLM forget decision",
  }
}

async function defaultForgetDecision(input: { query: string; candidates: MemoryBlock[] }) {
  try {
    return await llmForgetDecide(input)
  } catch {
    return { deleteIDs: input.candidates.map((candidate) => candidate.id), keepIDs: [], reason: "matched candidates" }
  }
}

async function runReflector(input: { events: MemoryEvent[]; doc: MemoryDocument; mode: "quick" | "daily" | "manual" }) {
  if (reflectorForTest) return reflectorForTest(input)
  try {
    return await llmReflector(input)
  } catch (error) {
    if (input.mode === "quick") throw error
    // Keep full reflection usable when model configuration is unavailable; the
    // deterministic fallback preserves the same schema boundary for scheduled maintenance.
  }
  return deterministicReflector(input)
}

function mergeCandidates(doc: MemoryDocument, candidates: ReflectionCandidate[]) {
  const now = new Date().toISOString()
  const byKey = new Map<string, MemoryBlock>()
  for (const memory of doc.memories) byKey.set(candidateKey(memory), memory)
  const updatedIDs: string[] = []
  const eventResults: Record<string, string> = {}
  let shortcutChanged = false

  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    const existing = byKey.get(key)
    if (existing) {
      existing.confidence = Math.max(existing.confidence, candidate.confidence)
      existing.weight = Math.max(existing.weight, candidate.weight)
      existing.evidence = candidate.evidence
      existing.updated_at = now
      existing.status = "active"
      updatedIDs.push(existing.id)
      eventResults[candidate.eventID] = existing.id
      continue
    }
    for (const memory of doc.memories) {
      if (!conflictsWith(memory, candidate)) continue
      memory.status = "deprecated"
      memory.updated_at = now
      shortcutChanged = true
    }
    const id = `${prefixForType(candidate.type)}-${ulid()}`
    const block: MemoryBlock = {
      id,
      type: candidate.type,
      scope: candidate.scope,
      memory: candidate.memory,
      confidence: candidate.confidence,
      weight: candidate.weight,
      evidence: candidate.evidence,
      updated_at: now,
      status: "active",
    }
    doc.memories.push(block)
    byKey.set(key, block)
    updatedIDs.push(id)
    eventResults[candidate.eventID] = id

    const shortcut = buildShortcut(candidate)
    const existingShortcut = doc.shortcuts.find(
      (item) => item.shortcut === shortcut.shortcut && item.instruction === shortcut.instruction,
    )
    if (existingShortcut) {
      const activeIDs = new Set(doc.memories.filter((memory) => memory.status === "active").map((memory) => memory.id))
      existingShortcut.target_ids = existingShortcut.target_ids.filter((target) => activeIDs.has(target))
      if (!existingShortcut.target_ids.includes(id)) existingShortcut.target_ids.push(id)
      shortcutChanged = true
      existingShortcut.triggers = [...new Set([...existingShortcut.triggers, ...shortcut.triggers])].slice(0, 12)
      existingShortcut.weight = Math.max(existingShortcut.weight, shortcut.weight)
    } else {
      shortcut.target_ids.push(id)
      doc.shortcuts.push(shortcut)
      shortcutChanged = true
    }
  }

  return { updatedIDs: [...new Set(updatedIDs)], eventResults, shortcutChanged }
}

async function memoryChannels() {
  await ensureDirs()
  const found = new Set<string>([paths().channelID])
  const entries = await fs.readdir(paths().channelRootDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = dbPath(entry.name)
    if (await fs.stat(file).catch(() => undefined)) found.add(entry.name)
  }
  return [...found].sort()
}

async function pendingEvents(input: { mode: "quick" | "daily" | "manual"; eventIDs?: string[] }) {
  if (input.eventIDs?.length) {
    const database = openDb()
    const placeholders = input.eventIDs.map(() => "?").join(", ")
    return database
      .prepare(`SELECT * FROM memory_event WHERE id IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
      .all(...input.eventIDs) as MemoryEvent[]
  }
  const limit = input.mode === "quick" ? 20 : 200
  const rows: MemoryEvent[] = []
  const channels = input.mode === "daily" ? await memoryChannels() : [paths().channelID]
  for (const channelID of channels) {
    const handle = openDbForChannel(channelID)
    try {
      const next = handle.database
        .prepare(
          `SELECT * FROM memory_event
           WHERE op = 'remember' AND status IN ('new', 'pending_important')
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
        )
        .all(limit) as MemoryEvent[]
      rows.push(...next.map((event) => ({ ...event, channel_id: event.channel_id ?? channelID })))
    } finally {
      handle.close()
    }
  }
  return rows.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)).slice(0, limit)
}

function updateEventStatus(event: MemoryEvent, input: { status: EventStatus; reflectedAt: number; result: unknown }) {
  const handle = openDbForChannel(event.channel_id ?? paths().channelID)
  try {
    handle.database
      .prepare("UPDATE memory_event SET status = ?, reflected_at = ?, result_json = ? WHERE id = ?")
      .run(input.status, input.reflectedAt, JSON.stringify(input.result), event.id)
  } finally {
    handle.close()
  }
}

export namespace Memory {
  export function configureForTest(input: Paths) {
    overridePaths = input
    stop()
    reflectorForTest = (reflectInput) => deterministicReflector(reflectInput)
  }

  export async function stop() {
    db?.close()
    db = undefined
    invalidateDocumentCache()
    initializeCancelled = false
    startupCatchupStarted = false
    scannerForTest = undefined
    extractorForTest = undefined
  }

  export async function purge() {
    await stop()
    await fs.rm(paths().globalMemoryDir, { recursive: true, force: true })
    await fs.rm(dbPath(), { force: true }).catch(() => undefined)
    await fs.rm(`${dbPath()}-wal`, { force: true }).catch(() => undefined)
    await fs.rm(`${dbPath()}-shm`, { force: true }).catch(() => undefined)
  }

  export async function status() {
    const stat = await fs.stat(mdPath()).catch(() => undefined)
    const doc = await readDocumentWithOptions({ createIfMissing: false })
    const cfg = await Config.get().catch(() => ({} as Awaited<ReturnType<typeof Config.get>>))
    const state = await readReflectionState()
    const hasHistorySessions = Boolean(Session.listGlobal({ limit: 1, archivedMode: "exclude" }).next().value)
    return {
      enabled: cfg.memory?.enabled ?? true,
      dailyReflectEnabled: cfg.memory?.dailyReflect?.enabled ?? true,
      dailyReflectTime: cfg.memory?.dailyReflect?.time ?? "03:00",
      markdown_exists: Boolean(stat),
      markdown_updated_at: stat?.mtimeMs ?? null,
      memory_count: doc.memories.length,
      shortcut_count: doc.shortcuts.length,
      needs_initialization: !stat,
      has_history_sessions: hasHistorySessions,
      initialization: state.initialization ?? { status: "idle" },
    }
  }

  export async function writeDocumentForTest(doc: MemoryDocument) {
    await writeDocument(doc)
  }

  export async function eventsForTest(): Promise<MemoryEvent[]> {
    return openDb().prepare("SELECT * FROM memory_event ORDER BY created_at ASC, id ASC").all() as MemoryEvent[]
  }

  export function setSessionScannerForTest(scanner: () => AsyncGenerator<SessionForInitialization>) {
    scannerForTest = scanner
  }

  export function setInitializerExtractorForTest(extractor: (session: SessionForInitialization) => Promise<InitializerCandidate[]>) {
    extractorForTest = extractor
  }

  export function setReflectorForTest(
    reflector: (input: { events: MemoryEvent[]; doc: MemoryDocument; mode: "quick" | "daily" | "manual" }) => Promise<ReflectionCandidate[]>,
  ) {
    reflectorForTest = reflector
  }

  export async function search(input: MemorySearchInput) {
    const doc = await readDocument()
    return {
      results: searchMemoryDocument(doc, input),
      ranking_note: "结果按相关度、scope、权重和新近程度综合排序。",
    }
  }

  export async function remember(input: {
    text: string
    type?: MemoryType
    intent: "explicit" | "observed"
    source: Parameters<typeof insertEvent>[0]["source"]
  }) {
    if (!(await isEnabled())) return { eventID: "", status: "ignored" as const, reason: "memory disabled" }
    await ensureDirs()
    const gate = shouldQuickReflect({ text: input.text, intent: input.intent, op: "remember", shortcutTriggers: [] })
    const event = insertEvent({
      op: "remember",
      type: input.type,
      intent: input.intent,
      text: input.text,
      status: gate.shouldRun ? "new" : "ignored",
      source: input.source,
    })
    if (gate.priority === "important") {
      openDb().prepare("UPDATE memory_event SET status = ? WHERE id = ?").run("pending_important", event.id)
      const reflected = await reflect({ mode: "quick", reason: gate.reason, eventIDs: [event.id] }).catch((error) => ({
        changed: false,
        summary: error instanceof Error ? error.message : String(error),
      }))
      return {
        eventID: event.id,
        status: reflected.changed ? ("applied" as const) : ("queued" as const),
        reason: reflected.changed ? gate.reason : `${gate.reason}; quick LLM reflection did not apply a memory yet: ${reflected.summary}`,
      }
    }
    return { eventID: event.id, status: gate.shouldRun ? ("queued" as const) : ("ignored" as const), reason: gate.reason }
  }

  export async function forget(input: {
    query?: string
    ids?: string[]
    type?: MemoryType
    source: Parameters<typeof insertEvent>[0]["source"]
    decide?: (input: {
      query: string
      candidates: MemoryBlock[]
    }) => Promise<{ deleteIDs: string[]; keepIDs: string[]; reason: string }>
  }) {
    if (!(await isEnabled())) return { eventID: "", deletedIDs: [], status: "not_found" as const }
    const doc = await readDocument()
    let candidates = input.ids?.length
      ? doc.memories.filter((memory) => input.ids!.includes(memory.id))
      : searchMemoryDocument(doc, { query: input.query ?? "", types: input.type ? [input.type] : undefined, limit: 10 })
    const broadFallback = !candidates.length && !input.ids?.length && Boolean(input.query)
    if (broadFallback) {
      candidates = doc.memories
        .filter((memory) => memory.status === "active")
        .filter((memory) => !input.type || memory.type === input.type)
        .slice(0, 20)
    }
    if (!candidates.length) {
      return { eventID: "", deletedIDs: [], status: "not_found" as const }
    }
    const decision = input.decide
      ? await input.decide({ query: input.query ?? input.ids?.join(", ") ?? "", candidates })
      : broadFallback
        ? await llmForgetDecide({ query: input.query ?? input.ids?.join(", ") ?? "", candidates }).catch(() => ({
            deleteIDs: [],
            keepIDs: candidates.map((candidate) => candidate.id),
            reason: "No keyword candidates and LLM forget decision failed.",
          }))
        : await defaultForgetDecision({ query: input.query ?? input.ids?.join(", ") ?? "", candidates })
    const deleteSet = new Set(decision.deleteIDs)
    const deletedIDs = doc.memories.filter((memory) => deleteSet.has(memory.id)).map((memory) => memory.id)
    if (!deletedIDs.length) return { eventID: "", deletedIDs: [], status: "not_found" as const }
    const next = {
      ...doc,
      memories: doc.memories.filter((memory) => !deleteSet.has(memory.id)),
      shortcuts: doc.shortcuts
        .map((shortcut) => ({
          ...shortcut,
          target_ids: shortcut.target_ids.filter((id) => !deleteSet.has(id)),
        }))
        .filter((shortcut) => shortcut.target_ids.length > 0),
    }
    await writeDocument(next)
    const event = insertEvent({
      op: "forget",
      intent: "explicit",
      text: input.query ?? deletedIDs.join(", "),
      status: "forgot",
      source: input.source,
      result: { deletedIDs, reason: decision.reason },
    })
    return { eventID: event.id, deletedIDs, status: "deleted" as const }
  }

  export async function reflect(input: {
    mode: "quick" | "daily" | "manual"
    reason?: string
    eventIDs?: string[]
  }) {
    if (!(await isEnabled())) {
      return { runID: "", changed: false, updatedIDs: [], deletedIDs: [], shortcutChanged: false, summary: "Memory is disabled." }
    }
    const cfg = await Config.get().catch(() => ({} as Awaited<ReturnType<typeof Config.get>>))
    if (input.mode === "daily" && input.reason === "cron" && cfg.memory?.dailyReflect?.enabled === false) {
      return {
        runID: "",
        changed: false,
        updatedIDs: [],
        deletedIDs: [],
        shortcutChanged: false,
        summary: "Daily memory reflection is disabled.",
      }
    }
    const started = Date.now()
    const id = `refl_${ulid()}`
    const events = await pendingEvents({ mode: input.mode, eventIDs: input.eventIDs })
    const before = await readDocument()
    const candidates = await runReflector({ events, doc: before, mode: input.mode })
    const next: MemoryDocument = {
      ...before,
      shortcuts: before.shortcuts.map((shortcut) => ({ ...shortcut, target_ids: [...shortcut.target_ids] })),
      memories: before.memories.map((memory) => ({ ...memory })),
    }
    const merged = mergeCandidates(next, candidates)
    const changed = merged.updatedIDs.length > 0
    if (changed) await writeDocument(next)
    const now = Date.now()
    for (const event of events) {
      const memoryID = merged.eventResults[event.id]
      updateEventStatus(event, {
        status: memoryID ? "applied" : "ignored",
        reflectedAt: now,
        result: { memoryID: memoryID ?? null, runID: id },
      })
    }
    openDb()
      .prepare(
        "INSERT INTO reflection_run (id, mode, started_at, completed_at, input_event_ids_json, summary_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.mode,
        started,
        Date.now(),
        JSON.stringify(events.map((event) => event.id)),
        JSON.stringify({ reason: input.reason ?? "", updatedIDs: merged.updatedIDs }),
      )
    if (input.mode === "daily") {
      await writeReflectionState({
        last_successful_daily_reflect_at: Date.now(),
        last_daily_reflect_run_id: id,
      })
    }
    return {
      runID: id,
      changed,
      updatedIDs: merged.updatedIDs,
      deletedIDs: [],
      shortcutChanged: merged.shortcutChanged,
      summary: changed ? `Applied ${merged.updatedIDs.length} memory update(s).` : "No changes.",
    }
  }

  export async function initialize(input: { confirm: boolean }) {
    if (!(await isEnabled())) return { status: "cancelled" as const, scanned: 0, imported: 0 }
    if (!input.confirm) return { status: "cancelled" as const, scanned: 0, imported: 0 }
    initializeCancelled = false
    await ensureDirs()
    const startedAt = Date.now()
    let scanned = 0
    let imported = 0
    const writeInitializationProgress = (patch: Record<string, unknown> = {}) =>
      writeReflectionState({
        initialization: {
          status: "running",
          started_at: startedAt,
          updated_at: Date.now(),
          scanned,
          imported,
          ...patch,
        },
      })

    await writeInitializationProgress()
    const scanner = scannerForTest ?? defaultSessionScanner
    for await (const session of scanner()) {
      if (initializeCancelled) break
      scanned++
      if (!sessionHasMemorySignal(session)) {
        await writeInitializationProgress({
          current_session_id: session.sessionID,
          current_project_id: session.projectID ?? null,
        })
        await sleep(250)
        continue
      }
      const candidates = extractorForTest ? await extractorForTest(session) : await extractMemoryCandidates(session)
      for (const candidate of candidates) {
        insertEvent({
          op: "remember",
          type: candidate.type,
          intent: "observed",
          text: candidate.text,
          status: "new",
          source: {
            createdAt: Date.now(),
            channelID: session.channelID,
            projectID: session.projectID,
            sessionID: session.sessionID,
            role: "user",
            scope: candidate.scope,
          },
        })
        imported++
      }
      await writeInitializationProgress({
        current_session_id: session.sessionID,
        current_project_id: session.projectID ?? null,
      })
      await sleep(250)
    }
    if (imported > 0) {
      await writeInitializationProgress({ status: "reflecting" })
      await reflect({ mode: "daily", reason: "initialize" })
    }
    const status = initializeCancelled ? ("cancelled" as const) : ("succeeded" as const)
    await writeReflectionState({
      initialization: {
        status,
        started_at: startedAt,
        completed_at: Date.now(),
        scanned,
        imported,
      },
    })
    return { status, scanned, imported }
  }

  export async function startupCatchup() {
    if (startupCatchupStarted) return { started: false, reason: "already checked this startup" }
    startupCatchupStarted = true
    if (!(await isEnabled())) return { started: false, reason: "memory disabled" }
    const cfg = await Config.get().catch(() => ({} as Awaited<ReturnType<typeof Config.get>>))
    if (cfg.memory?.dailyReflect?.enabled === false) return { started: false, reason: "daily reflect disabled" }
    const state = await readReflectionState()
    const last = typeof state.last_successful_daily_reflect_at === "number" ? state.last_successful_daily_reflect_at : 0
    if (last && dateKey(last) === dateKey(Date.now())) return { started: false, reason: "already reflected today" }
    void reflect({ mode: "daily", reason: "startup-catchup" })
      .then((result) =>
        writeReflectionState({
          last_startup_catchup_at: Date.now(),
          last_startup_catchup_result: result.summary,
        }),
      )
      .catch((error) =>
        writeReflectionState({
          last_startup_catchup_at: Date.now(),
          last_startup_catchup_result: error instanceof Error ? error.message : String(error),
        }),
      )
    return { started: true, reason: "scheduled" }
  }

  export async function cancelInitialize() {
    initializeCancelled = true
    return { ok: true }
  }

  export function detectForgetIntent(text: string) {
    return hasForgetIntent(text)
  }

  export async function isEnabled() {
    const cfg = await Config.get().catch(() => ({} as Awaited<ReturnType<typeof Config.get>>))
    return cfg.memory?.enabled ?? true
  }

  export async function shortcutSystemPrompt() {
    if (!(await isEnabled())) return undefined
    const doc = await readDocument()
    if (!doc.shortcuts.length) return undefined
    const lines = [
      "<user_memory_shortcuts>",
      "These are memory shortcuts, not full memories. Use them only to decide whether memory_search is needed.",
      "",
    ]
    for (const shortcut of doc.shortcuts) {
      lines.push(
        `- shortcut: ${shortcut.shortcut}`,
        `  triggers: ${shortcut.triggers.join(", ")}`,
        `  instruction: ${shortcut.instruction}`,
        "",
      )
    }
    lines.push(
      "If a shortcut matches the current task, call memory_search. Do not treat shortcut text as factual memory.",
      "</user_memory_shortcuts>",
    )
    return lines.join("\n")
  }
}
