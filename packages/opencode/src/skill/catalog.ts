import fs from "fs/promises"
import os from "os"
import path from "path"
import { generateObject, generateText } from "ai"
import stripAnsi from "strip-ansi"
import z from "zod"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"
import { Process } from "@/util/process"
import { Provider } from "@/provider/provider"
import { Instance } from "@/project/instance"
import { Config } from "@/config/config"
import { ModelID, ProviderID } from "@/provider/schema"

const Rank = z.enum(["exact", "semantic"])
const Relevance = z.enum(["high", "medium", "low"])
const Tier = z.enum(["main", "more"])
const Scope = z.enum(["project", "global"])
const ProviderKind = z.enum(["registry", "external"])
const SummarySource = z.enum(["skills_summary", "skill_md"])
const DescribeSource = z.enum(["skills_summary", "skill_md", "fallback"])
const InstallStatus = z.enum(["queued", "running", "success", "error"])

export const SearchResult = z.object({
  id: z.string(),
  provider: ProviderKind,
  rank: Rank,
  name: z.string(),
  description: z.string().optional(),
  installs: z.string().optional(),
  url: z.string().optional(),
  registry: z.string().optional(),
  version: z.string().optional(),
  package: z.string().optional(),
  source: z.string().optional(),
  installed: z.boolean().default(false),
  scope: Scope.optional(),
  update_available: z.boolean().optional(),
  summary_zh: z.string().optional(),
  summary_source: SummarySource.optional(),
  relevance: Relevance.optional(),
  tier: Tier.optional(),
})
export type SearchResult = z.infer<typeof SearchResult>

export const SearchOutput = z.object({
  main: SearchResult.array(),
  more: SearchResult.array(),
  meta: z.object({
    model: z.string().optional(),
    latency_ms: z.number().optional(),
  }),
})
export type SearchOutput = z.infer<typeof SearchOutput>

type FindResult = {
  package: string
  installs: string
  source: string
  name: string
  url: string
}

export const Installed = SearchResult.omit({ rank: true }).extend({
  update_available: z.boolean().default(false),
})
export type Installed = z.infer<typeof Installed>

export const SearchInput = z.object({
  query: z.string(),
  semantic: z.boolean().optional(),
})

export const DescribeInput = z.object({
  id: z.string(),
  name: z.string(),
  provider: ProviderKind,
  description: z.string().optional(),
  url: z.string().optional(),
  source: z.string().optional(),
  registry: z.string().optional(),
  package: z.string().optional(),
})

export const DescribeResult = z.object({
  summary_zh: z.string(),
  summary_source: DescribeSource.optional(),
})

export const InstallInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("registry"),
    registry: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal("external"),
    package: z.string(),
    scope: Scope,
  }),
])

export const UpdateInput = z.object({
  names: z.array(z.string()).optional(),
})

export const InstallJob = z.object({
  job_id: z.string(),
  id: z.string(),
  provider: ProviderKind,
  name: z.string(),
  registry: z.string().optional(),
  package: z.string().optional(),
  source: z.string().optional(),
  scope: Scope.optional(),
  status: InstallStatus,
  message: z.string().optional(),
  started_at: z.number().optional(),
  finished_at: z.number().optional(),
})

const Entry = z.object({
  name: z.string(),
  description: z.string().optional().default(""),
  version: z.string().optional(),
  files: z.array(z.string()),
  tags: z.array(z.string()).optional().default([]),
  checksum: z.string().optional(),
  homepage: z.string().optional(),
  updated_at: z.string().optional(),
})

const Index = z.object({
  skills: z.array(Entry),
})

const LockEntry = z.object({
  registry: z.string(),
  version: z.string().optional(),
  checksum: z.string().optional(),
  installed_at: z.number(),
})

const Lock = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), LockEntry).default({}),
})

const ExternalLockEntry = z.object({
  source: z.string(),
  sourceType: z.string().optional(),
  computedHash: z.string().optional(),
})

const ExternalLock = z.object({
  version: z.number(),
  skills: z.record(z.string(), ExternalLockEntry),
})

const Terms = z.object({
  intent: z.string().optional().default(""),
  phrases: z.array(z.string()).max(3).default([]),
  keywords: z.array(z.string()).max(8).default([]),
})

const Review = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        relevance: Relevance,
        summary_zh: z.string().trim().optional().default(""),
      }),
    )
    .default([]),
})

type RegistryItem = z.infer<typeof Entry> & { registry: string; base: string }
type LockItem = z.infer<typeof LockEntry>
type LockState = { version: 1; skills: Record<string, LockItem> }
type Text = Awaited<ReturnType<typeof Process.text>>
type Page = { text: string; source: z.infer<typeof SummarySource> }
type Job = z.infer<typeof InstallJob> & { directory: string; work: () => Promise<void> }
type SearchModel = { providerID: ProviderID; modelID: ModelID }
type Reviewed = {
  id: string
  relevance: z.infer<typeof Relevance>
  summary_zh?: string
  summary_source?: z.infer<typeof SummarySource>
}

export const BenchInput = z.object({
  query: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      source: z.string().optional(),
      description: z.string().optional(),
      rank: Rank.default("semantic"),
      body: z.string().optional(),
      summary_source: SummarySource.optional(),
    }),
  ),
})

const REGISTRY_MS = 1_500
const CLI_MS = 2_000
const FIND_MS = 4_500
const PAGE_MS = 2_500
const SUMMARY_TTL = 86_400_000
const SEARCH_MODELS = [
  "opencode/big-pickle",
  "opencode/qwen3.6-plus-free",
  "opencode/gpt-5-nano",
  "opencode/nemotron-3-super-free",
  "opencode/minimax-m2.5-free",
] as const
const memo = new Map<string, { at: number; result: z.infer<typeof DescribeResult> }>()
const pending = new Map<string, Promise<z.infer<typeof DescribeResult>>>()
const pageMemo = new Map<string, { at: number; result: Page | undefined }>()
const pagePending = new Map<string, Promise<Page | undefined>>()
const slots = new Map<number, { queue: Array<() => void>; count: number }>()
const task = new Map<string, Job>()
const wait: string[] = []
const list = new Map<string, string[]>()
let active = 0

export function limit<T>(ms: number, fallback: T, run: () => Promise<T>) {
  return Promise.race([
    run().catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

export async function exec(cmd: string[], ms = CLI_MS): Promise<Text> {
  const abort = new AbortController()
  const id = setTimeout(() => abort.abort(), ms)
  return Process.text(cmd, {
    cwd: Instance.worktree,
    nothrow: true,
    abort: abort.signal,
    kill: "SIGKILL",
    timeout: 0,
  })
    .catch(() => ({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      text: "",
    }))
    .finally(() => clearTimeout(id))
}

function clean(input: string) {
  return input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function decode(input: string) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
}

function strip(input: string) {
  return decode(input)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function clip(input: string, max = 600) {
  return input.length <= max ? input : `${input.slice(0, max - 1).trim()}…`
}

function prose(input: string, mark: string) {
  const idx = input.indexOf(mark)
  if (idx < 0) return
  const body = input.slice(idx)
  const match = /<div class="prose[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(body)
  if (!match) return
  const text = clip(strip(match[1]))
  if (!text) return
  return text
}

export function extractPage(input: string): Page | undefined {
  const summary = prose(input, "Summary</div>")
  if (summary) return { text: summary, source: "skills_summary" }

  const skill = prose(input, "SKILL.md</span>")
  if (skill) return { text: skill, source: "skill_md" }
}

function tokens(input: string) {
  return clean(input).split(/\s+/).filter(Boolean)
}

async function gate<T>(max: number, run: () => Promise<T>) {
  const slot = slots.get(max) ?? { queue: [], count: 0 }
  slots.set(max, slot)
  if (slot.count >= max) await new Promise<void>((resolve) => slot.queue.push(resolve))
  slot.count += 1
  return run().finally(() => {
    slot.count -= 1
    slot.queue.shift()?.()
  })
}

function put(job: Job) {
  task.set(job.job_id, job)
  const next = [job.job_id, ...(list.get(job.directory) ?? []).filter((item) => item !== job.job_id)].slice(0, 50)
  list.set(job.directory, next)
}

function view(job: Job) {
  return InstallJob.parse({
    job_id: job.job_id,
    id: job.id,
    provider: job.provider,
    name: job.name,
    registry: job.registry,
    package: job.package,
    source: job.source,
    scope: job.scope,
    status: job.status,
    message: job.message,
    started_at: job.started_at,
    finished_at: job.finished_at,
  })
}

function step() {
  while (active < 2) {
    const id = wait.shift()
    if (!id) return
    const job = task.get(id)
    if (!job) continue
    job.status = "running"
    job.started_at = Date.now()
    put(job)
    active += 1
    void Instance.provide({
      directory: job.directory,
      fn: async () => {
        await job.work()
      },
    })
      .then(() => {
        job.status = "success"
        job.finished_at = Date.now()
        job.message = undefined
        put(job)
      })
      .catch((err) => {
        job.status = "error"
        job.finished_at = Date.now()
        job.message = text(err)
        put(job)
      })
      .finally(() => {
        active -= 1
        step()
      })
  }
}

function text(input: unknown) {
  return input instanceof Error ? input.message : String(input)
}

function parseModel(input?: string) {
  if (!input) return
  const idx = input.indexOf("/")
  if (idx <= 0 || idx === input.length - 1) return
  return {
    providerID: ProviderID.make(input.slice(0, idx)),
    modelID: ModelID.make(input.slice(idx + 1)),
  } satisfies SearchModel
}

function printModel(input?: SearchModel) {
  if (!input) return
  return `${input.providerID}/${input.modelID}`
}

async function pick(input?: SearchModel) {
  if (input) return input
  const cfg = await Config.get().catch(() => undefined)
  const fromConfig = parseModel(cfg?.search_model)
  if (fromConfig) return fromConfig
  for (const item of SEARCH_MODELS) {
    const next = parseModel(item)
    if (!next) continue
    const ok = await Provider.getModel(next.providerID, next.modelID).then(() => true).catch(() => false)
    if (ok) return next
  }
  const fallback = await Provider.defaultModel().catch(() => undefined)
  if (!fallback) return
  return {
    providerID: fallback.providerID,
    modelID: fallback.modelID,
  } satisfies SearchModel
}

async function language(input?: SearchModel) {
  const model = await pick(input)
  if (!model) return { model }
  const resolved = await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
  if (!resolved) return { model }
  const out = await Provider.getLanguage(resolved).catch(() => undefined)
  return { model, language: out }
}

export function seed(query: string) {
  const map: Record<string, string[]> = {
    update: ["updater", "refresh", "sync", "maintenance", "check"],
    auto: ["automatic", "automation"],
    skill: ["skills", "plugin"],
    install: ["add", "download", "setup"],
  }
  const words = tokens(query).flatMap((part) => map[part] ?? [])
  const text = query.toLowerCase()
  const alias: Array<[string, string[]]> = [
    ["润色", ["polish", "proofread", "editing", "rewrite", "humanizer"]],
    ["改写", ["rewrite", "editing", "polish"]],
    ["改论文", ["paper", "polish", "latex", "proofread"]],
    ["论文", ["paper", "latex", "manuscript"]],
    ["更新", ["update", "updater", "refresh", "sync", "check"]],
    ["自动更新", ["auto updater", "update", "updater", "refresh", "sync"]],
    ["技能", ["skills", "find", "install"]],
    ["skill", ["skills", "find", "install"]],
    ["有人味", ["humanizer", "natural", "human-like", "writing"]],
    ["人味", ["humanizer", "human-like", "natural"]],
    ["写作", ["writing", "rewrite", "editing"]],
    ["翻译", ["translate", "translation"]],
    ["总结", ["summarize", "summary"]],
  ]
  return [
    ...words,
    ...alias.flatMap(([key, value]) => (text.includes(key) ? value : [])),
  ]
}

function score(query: string, text: string) {
  const q = clean(query)
  const t = clean(text)
  if (!q || !t) return undefined
  if (t === q) return "exact" as const
  if (t.includes(q)) return "exact" as const
  return tokens(q).every((part) => t.includes(part)) ? ("semantic" as const) : undefined
}

function kind(input: string) {
  const text = clean(input)
  const out = new Set<string>()
  if (/\b(paper|latex|manuscript|submission|academic|journal|conference|scholarly)\b/.test(text)) out.add("paper")
  if (/\b(proofread|proofreading|copy editing|copyediting|copy edit|grammar|editorial|reviewing|review)\b/.test(text)) out.add("proof")
  if (/\b(human|humanizer|humanize|human like|humanlike|natural language|natural writing|rewrite|rewriting)\b/.test(text)) out.add("human")
  if (/\b(video|media|multimedia|clip|audio|footage|render|subtitle|captions?)\b/.test(text)) out.add("media")
  if (/\b(find|search|install|plugin|marketplace)\b|discover skills|skills cli/.test(text)) out.add("tool")
  if (/\b(update|updater|refresh|sync|maintenance|auto update|autoupdate)\b|check updates?\b/.test(text)) out.add("updater")
  if (/\b(ui|ux|interface)\b|design system/.test(text)) out.add("ui")
  if (/\b(code|refactor|lint|format|coding)\b/.test(text)) out.add("code")
  if (/\b(translate|translation)\b/.test(text)) out.add("translate")
  return out
}

function intent(query: string) {
  const want = kind([query, ...seed(query)].join(" "))
  if (want.has("translate")) return "translate" as const
  if (want.has("paper") || want.has("proof")) return "paper" as const
  if (want.has("human")) return "human" as const
  if (want.has("tool") || want.has("updater")) return "tool" as const
}

function blocked(query: string, item: SearchResult, body?: string) {
  const want = intent(query)
  if (!want) return false
  const have = kind([item.name, item.source, item.registry, item.description, body].filter(Boolean).join(" "))
  if (want === "paper") return have.has("media") || have.has("ui") || have.has("tool") || have.has("updater") || have.has("translate")
  if (want === "human") return have.has("media") || have.has("ui") || have.has("tool") || have.has("updater")
  if (want === "translate") return have.has("media") || have.has("ui") || have.has("tool") || have.has("updater")
  return have.has("paper") || have.has("proof") || have.has("media") || have.has("ui") || have.has("human")
}

function relate(query: string, item: SearchResult, body?: string): z.infer<typeof Relevance> {
  const want = intent(query)
  const have = kind([item.name, item.source, item.registry, item.description, body].filter(Boolean).join(" "))

  if (want === "paper") {
    if (have.has("paper") || have.has("proof")) return "high"
    if (have.has("human") || have.has("code")) return "medium"
    if (have.has("media") || have.has("tool") || have.has("ui") || have.has("translate")) return "low"
  }

  if (want === "human") {
    if (have.has("human")) return "high"
    if (have.has("proof") || have.has("paper")) return "medium"
    if (have.has("media") || have.has("tool") || have.has("ui")) return "low"
  }

  if (want === "translate") {
    if (have.has("translate")) return "high"
    if (have.has("paper") || have.has("proof")) return "medium"
    if (have.has("media") || have.has("tool") || have.has("ui")) return "low"
  }

  if (want === "tool") {
    if (have.has("tool") || have.has("updater")) return "high"
    if (have.has("code")) return "medium"
    if (have.has("paper") || have.has("proof") || have.has("media") || have.has("ui") || have.has("human")) return "low"
  }

  if (item.rank === "exact") return "high"
  if (item.rank === "semantic") return "medium"
  return "low"
}

function level(
  query: string,
  item: SearchResult,
  body?: string,
  review?: z.infer<typeof Relevance>,
): z.infer<typeof Relevance> {
  const base = relate(query, item, body)
  if (!review) return base
  if (base === "high") return "high"
  if (base === "low") return "low"
  return review === "low" ? "low" : "medium"
}

export function split(query: string, item: SearchResult, body?: string, relevance?: z.infer<typeof Relevance>) {
  if (blocked(query, item, body)) return
  const rank = relevance ?? item.relevance ?? relate(query, item, body)
  if (item.provider === "external" && !body) return item.rank === "exact" ? ("more" as const) : undefined
  if (rank === "high") return "main" as const
  if (rank === "medium") return "more" as const
}

async function refine(
  query: string,
  coarse: SearchResult[],
  pages: Array<{ item: SearchResult; page?: Page }>,
  model?: SearchModel,
  start = Date.now(),
) {
  const order = new Set(merge(query, coarse))
  const body = new Map(pages.map((item) => [item.item.id, item.page]))
  const rated = await review(query, pages.filter((entry) => entry.page), model)
  const map = new Map(rated.map((item) => [item.id, item]))
  const refined = coarse.reduce<SearchResult[]>((acc, item) => {
    if (item.provider === "registry") {
      const relevance = item.rank === "exact" ? "high" : "medium"
      const tier = split(query, item, item.description, relevance)
      if (!tier) return acc
      acc.push({
        ...item,
        relevance,
        tier,
      })
      return acc
    }
    const page = body.get(item.id)
    const next = map.get(item.id)
    const relevance = level(query, item, page?.text, next?.relevance)
    const tier = split(query, item, page?.text, relevance)
    if (!tier) return acc
    acc.push({
      ...item,
      relevance,
      summary_zh: next?.summary_zh,
      summary_source: page?.source,
      tier,
    })
    return acc
  }, [])
  const sorted = refined.toSorted((a, b) => {
    const left = a.relevance === "high" ? 2 : a.relevance === "medium" ? 1 : 0
    const right = b.relevance === "high" ? 2 : b.relevance === "medium" ? 1 : 0
    if (left !== right) return right - left
    return [...order].indexOf(a.id) - [...order].indexOf(b.id)
  })
  return {
    main: sorted.filter((item) => item.tier === "main"),
    more: sorted.filter((item) => item.tier === "more"),
    meta: {
      model: printModel(model),
      latency_ms: Date.now() - start,
    },
  } satisfies SearchOutput
}

function rank(input: SearchResult) {
  const exact = input.rank === "exact" ? 100 : 0
  const local = input.provider === "registry" ? 20 : 0
  const installed = input.installed ? 10 : 0
  return exact + local + installed
}

function registryDir() {
  return path.join(Instance.worktree, ".opencode", "skills")
}

function registryLockFile() {
  return path.join(Instance.worktree, ".opencode", "skills-lock.json")
}

function externalDir(scope: z.infer<typeof Scope>) {
  if (scope === "global") return path.join(Global.Path.home, ".agents", "skills")
  return path.join(Instance.worktree, ".agents", "skills")
}

function externalLockFile() {
  return path.join(Instance.worktree, "skills-lock.json")
}

function base(url: string) {
  return url.endsWith("/") ? url : `${url}/`
}

async function readLock(): Promise<LockState> {
  const lock = await Filesystem.readJson(registryLockFile())
    .then((x) => Lock.parse(x))
    .catch(
      () =>
        ({
          version: 1 as const,
          skills: {},
        }) satisfies LockState,
    )
  return {
    version: 1,
    skills: lock.skills as Record<string, LockItem>,
  }
}

async function writeLock(lock: LockState) {
  await Filesystem.writeJson(registryLockFile(), lock)
}

async function readExternalLock() {
  return Filesystem.readJson(externalLockFile()).then((x) => ExternalLock.parse(x)).catch(() => undefined)
}

async function registry() {
  const cfg = await Config.get()
  const urls = cfg.skills?.urls ?? []
  const list = await Promise.all(
    urls.map(async (url) => {
      const root = base(url)
      const index = new URL("index.json", root).href
      const data = await fetch(index, { signal: AbortSignal.timeout(REGISTRY_MS) })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Failed to fetch ${index}`))))
        .then((json) => Index.parse(json))
        .catch(() => undefined)
      if (!data) return []
      return data.skills
        .filter((item) => item.files.includes("SKILL.md"))
        .map((item) => ({ ...item, registry: url, base: root }))
    }),
  )
  return list.flat()
}

async function installedGlobal() {
  const dir = externalDir("global")
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return new Set(entries.filter((item) => item.isDirectory()).map((item) => item.name))
}

async function state() {
  const [lock, ext, global] = await Promise.all([readLock(), readExternalLock(), installedGlobal()])
  return { lock, ext, global }
}

async function semantic(query: string, model?: SearchModel) {
  const fallback = {
    intent: query,
    phrases: [],
    keywords: [...new Set(seed(query))].slice(0, 8),
  }
  return limit(1200, fallback, async () =>
    {
      const resolved = await language(model)
      if (!resolved.language) return fallback

      return generateObject({
        model: resolved.language,
        temperature: 0.2,
        schema: Terms,
        messages: [
          {
            role: "system",
            content:
              "Expand skill search queries into concise phrases and keywords. Prefer synonyms, related actions, and common package terms.",
          },
          {
            role: "user",
            content: `Query: ${query}`,
          },
        ],
      }).then((x) => x.object)
    },
  )
}

async function find(query: string, ms = CLI_MS) {
  const out = await exec(["npx", "-y", "skills", "find", query], ms)
  return parseFind(out.text)
}

async function checkExternal() {
  const out = await exec(["npx", "-y", "skills", "check"])
  return parseCheck(out.text)
}

async function addExternal(input: { source: string; skill: string; scope: z.infer<typeof Scope> }) {
  const cmd = [
    "npx",
    "-y",
    "skills",
    "add",
    input.source,
    "--skill",
    input.skill,
    "--agent",
    "opencode",
    "--yes",
    "--copy",
  ]
  if (input.scope === "global") cmd.splice(4, 0, "-g")
  await Process.run(cmd, {
    cwd: Instance.worktree,
  })
}

async function fetchSkill(item: RegistryItem) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-skill-"))
  await Promise.all(
    item.files.map(async (file) => {
      const url = new URL(`${item.name}/${file}`, item.base).href
      const body = await fetch(url)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`Failed to fetch ${url}`))))
        .then((buf) => new Uint8Array(buf))
      await Filesystem.write(path.join(dir, file), body)
    }),
  )
  return dir
}

async function addRegistry(item: RegistryItem) {
  const dir = registryDir()
  const dst = path.join(dir, item.name)
  const lock = await readLock()
  const current = lock.skills[item.name]
  const exists = await Filesystem.isDir(dst)
  if (exists && (!current || current.registry !== item.registry)) {
    throw new Error(`Skill "${item.name}" already exists`)
  }

  const tmp = await fetchSkill(item)
  await fs.rm(dst, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(dir, { recursive: true })
  await fs.cp(tmp, dst, { recursive: true })
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)

  lock.skills[item.name] = {
    registry: item.registry,
    version: item.version,
    checksum: item.checksum,
    installed_at: Date.now(),
  }
  await writeLock(lock)
}

function entryText(item: RegistryItem) {
  return [item.name, item.description, ...(item.tags ?? [])].join(" ")
}

function localResult(
  query: string,
  item: RegistryItem,
  st: Awaited<ReturnType<typeof state>>,
  extra: string[],
): SearchResult | undefined {
  const text = entryText(item)
  const hit = [query, ...extra]
    .map((term) => score(term, text))
    .find((term): term is z.infer<typeof Rank> => !!term)
  if (!hit) return
  const installed = !!st.lock.skills[item.name]
  return {
    id: `${item.registry}#${item.name}`,
    provider: "registry",
    rank: hit,
    name: item.name,
    description: item.description,
    registry: item.registry,
    version: item.version,
    installed,
    scope: installed ? "project" : undefined,
  }
}

function externalResult(
  query: string,
  item: FindResult,
  st: Awaited<ReturnType<typeof state>>,
  extra: string[],
): SearchResult | undefined {
  const text = [item.name, item.source].join(" ")
  const hit = [query, ...extra]
    .map((term) => score(term, text))
    .find((term): term is z.infer<typeof Rank> => !!term)
  if (!hit) return
  const project = st.ext?.skills[item.name]
  const global = st.global.has(item.name)
  return {
    id: item.package,
    provider: "external",
    rank: hit,
    name: item.name,
    installs: item.installs,
    package: item.package,
    source: item.source,
    url: item.url,
    installed: !!project || global,
    scope: project ? "project" : global ? "global" : undefined,
  }
}

async function page(key: string, url?: string) {
  if (!url) return
  const cached = pageMemo.get(key)
  if (cached && Date.now() - cached.at < SUMMARY_TTL) return cached.result
  const inflight = pagePending.get(key)
  if (inflight) return inflight

  const run = gate(4, async () =>
    fetch(url, { signal: AbortSignal.timeout(PAGE_MS) })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`Failed to fetch ${url}`))))
      .then((html) => extractPage(html))
      .catch(() => undefined),
  ).finally(() => pagePending.delete(key))

  pagePending.set(key, run)
  const result = await run
  pageMemo.set(key, { at: Date.now(), result })
  return result
}

export function brief(input: z.input<typeof DescribeInput>, body?: string) {
  const all = clean([input.name, input.source, input.registry, input.description, body].filter(Boolean).join(" "))
  const guess = ([
    [/(video|media)/, "这个 skill 主要用于视频或多媒体内容的编辑与处理。"],
    [/(paper|latex|manuscript|submission|review)/, "这个 skill 主要用于学术论文或 LaTeX 文稿的润色、修改和审阅。"],
    [/(proofread|proofreading|copy editing|copyediting|copy edit|grammar)/, "这个 skill 主要用于英文文本的校对、语法修改和措辞润色。"],
    [/(humanizer|human like|humanlike|natural language|natural writing|rewrite)/, "这个 skill 主要用于把文本改写得更自然、更像真人表达。"],
    [/(find|search|install|skills|plugin)/, "用于搜索、发现并安装其他技能"],
    [/(ui|ux)/, "用于界面细节优化与体验打磨"],
    [/(code)/, "用于代码整理、优化或修订"],
  ] as const)
    .find(([rule]) => rule.test(all))
    ?.[1]
  const line = clip((body ?? input.description ?? "").replace(/\s+/g, " ").trim(), 120)
  if (guess) return guess.startsWith("这个 skill") ? guess : `这个 skill 主要${guess}。`
  if (line) return `这个 skill 主要围绕 ${line}`
  if (input.source) return `这是 ${input.source} 提供的 ${input.name} skill。当前只拿到了基础信息，建议先点开详情后再决定。`
  return `这是一个名为 ${input.name} 的 skill。当前只拿到了基础信息，建议先看详情。`
}

async function review(query: string, list: Array<{ item: SearchResult; page?: Page }>, model?: SearchModel) {
  const fallback = list.map((entry) => ({
    id: entry.item.id,
    relevance: relate(query, entry.item, entry.page?.text),
    summary_zh: entry.page?.text ? brief(entry.item, entry.page.text) : undefined,
    summary_source: entry.page?.source,
  })) satisfies Reviewed[]

  if (list.length === 0) return fallback

  const resolved = await language(model)
  if (!resolved.language) return fallback
  const lang = resolved.language

  return limit(2_500, fallback, async () => {
    const out = await generateObject({
      model: lang,
      temperature: 0.2,
      schema: Review,
      messages: [
        {
          role: "system",
          content:
            "你是一个技能市场检索重排器。给定用户查询和若干 skill 的真实内容，请为每个 skill 输出 high/medium/low 相关度，并用简体中文写一句不超过 40 字的简介。只能依据提供材料，不要猜测没有出现的功能。",
        },
        {
          role: "user",
          content: [
            `查询：${query}`,
            ...list.map((entry) =>
              [
                `ID: ${entry.item.id}`,
                `Name: ${entry.item.name}`,
                `Source: ${entry.item.source ?? entry.item.registry ?? "unknown"}`,
                `Material: ${entry.page?.text ?? entry.item.description ?? ""}`,
              ].join("\n"),
            ),
          ].join("\n\n"),
        },
      ],
    }).then((item) => item.object.items)
    const map = new Map(out.map((item) => [item.id, item]))
    return fallback.map((item) => {
      const next = map.get(item.id)
      if (!next) return item
      return {
        ...item,
        relevance: next.relevance,
        summary_zh: next.summary_zh || item.summary_zh,
      }
    })
  })
}

async function zh(input: z.input<typeof DescribeInput>, body?: string, model?: SearchModel) {
  const base = brief(input, body)
  if (!body) return base

  const resolved = await language(model)
  if (!resolved.language) return base
  const lang = resolved.language

  return limit(1_500, base, async () =>
    generateText({
      model: lang,
      temperature: 0.2,
      maxOutputTokens: 120,
      messages: [
        {
          role: "system",
          content:
            "你是一个技能市场助手。请基于给定材料，用简体中文写 1 到 2 句简介，说明这个 skill 适合做什么、何时使用。不要使用项目符号，不要虚构功能。",
        },
        {
          role: "user",
          content: `Skill: ${input.name}\nSource: ${input.source ?? input.registry ?? "unknown"}\nMaterial:\n${body}`,
        },
      ],
    }).then((out) => out.text.trim() || base),
  )
}

export function splitPackage(input: string) {
  const idx = input.lastIndexOf("@")
  if (idx <= 0 || idx === input.length - 1) throw new Error(`Invalid package: ${input}`)
  return {
    source: input.slice(0, idx),
    skill: input.slice(idx + 1),
  }
}

export function parseFind(input: string) {
  const text = stripAnsi(input)
  const lines = text.split(/\r?\n/)
  const out: FindResult[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const next = lines[i + 1]?.trim()
    const match = /^([^ ]+@[^ ]+)\s+([0-9.]+[KMB]?)\s+installs$/i.exec(line)
    if (!match || !next?.startsWith("└ ")) continue
    const info = splitPackage(match[1])
    out.push({
      package: match[1],
      installs: match[2],
      source: info.source,
      name: info.skill,
      url: next.replace(/^└\s+/, ""),
    })
  }
  return out
}

export function parseCheck(input: string) {
  const text = stripAnsi(input)
  const lines = text.split(/\r?\n/)
  const updates: Record<string, string> = {}
  const failed: Record<string, string> = {}
  let mode: "updates" | "failed" | undefined
  let name = ""
  for (const row of lines) {
    const line = row.trim()
    if (line.includes("update(s) available")) {
      mode = "updates"
      continue
    }
    if (line.startsWith("Could not check")) {
      mode = "failed"
      continue
    }
    if (line.startsWith("↑ ") || line.startsWith("✗ ")) {
      name = line.slice(2).trim()
      continue
    }
    if (!name || !line.startsWith("source: ")) continue
    const src = line.slice("source: ".length).trim()
    if (mode === "updates") updates[name] = src
    if (mode === "failed") failed[name] = src
    name = ""
  }
  return { updates, failed }
}

export function merge(query: string, list: Array<Pick<SearchResult, "id" | "name" | "provider" | "rank" | "installed">>) {
  return list
    .toSorted((a, b) => {
      const diff = rank(a as SearchResult) - rank(b as SearchResult)
      if (diff !== 0) return -diff
      const exact = clean(a.name) === clean(query) ? 1 : 0
      const other = clean(b.name) === clean(query) ? 1 : 0
      if (exact !== other) return other - exact
      return a.name.localeCompare(b.name)
    })
    .map((item) => item.id)
}

export namespace Catalog {
  async function current() {
    const st = await state()
    const external = Object.entries(st.ext?.skills ?? {}).map(([name, item]) => ({
      id: `${item.source}@${name}`,
      provider: "external" as const,
      name,
      package: `${item.source}@${name}`,
      source: item.source,
      installed: true,
      scope: "project" as const,
      update_available: false,
    }))
    const global = [...st.global]
      .filter((name) => !st.ext?.skills[name])
      .map((name) => ({
        id: `global:${name}`,
        provider: "external" as const,
        name,
        installed: true,
        scope: "global" as const,
        update_available: false,
      }))
    const registry = Object.entries(st.lock.skills).map(([name, item]) => ({
      id: `${item.registry}#${name}`,
      provider: "registry" as const,
      name,
      registry: item.registry,
      version: item.version,
      installed: true,
      scope: "project" as const,
      update_available: false,
    }))
    return [...registry, ...external, ...global]
  }

  export async function search(input: z.input<typeof SearchInput>, model?: SearchModel) {
    const start = Date.now()
    const params = SearchInput.parse(input)
    const query = params.query.trim()
    const current = await pick(model)
    if (!query) return { main: [], more: [], meta: { model: printModel(current), latency_ms: Date.now() - start } }

    const expanded =
      params.semantic === false ? { intent: query, phrases: [], keywords: [] } : await semantic(query, current)
    const extra = [...expanded.phrases, ...expanded.keywords].filter((item) => clean(item) !== clean(query))
    const st = await state()
    const local = await registry().then((items) =>
      items
        .map((item) => localResult(query, item, st, extra))
        .filter((item): item is SearchResult => !!item),
    )

    const searches = [query, ...extra]
      .filter((item, idx, arr): item is string => !!item && arr.indexOf(item) === idx)
      .slice(0, 4)
    const external = (
      await Promise.all(searches.map((item) => find(item, params.semantic === false ? CLI_MS : FIND_MS)))
    )
      .flat()
      .reduce((acc, item) => acc.set(item.package, item), new Map<string, FindResult>())
    const extraResults = [...external.values()]
      .map((item) => externalResult(query, item, st, extra))
      .filter((item): item is SearchResult => !!item)

    const all = [...local, ...extraResults]
    const order = new Set(merge(query, all))
    const coarse = all.toSorted((a, b) => [...order].indexOf(a.id) - [...order].indexOf(b.id))
    if (params.semantic === false) {
      return {
        main: coarse.map((item) => ({ ...item, tier: "main" as const })),
        more: [],
        meta: {
          model: printModel(current),
          latency_ms: Date.now() - start,
        },
      } satisfies SearchOutput
    }

    const picked = coarse.filter((item) => item.provider === "external").slice(0, 12)
    const pages = await Promise.all(
      picked.map(async (item) => ({
        item,
        page: await page(item.url ?? item.id, item.url),
      })),
    )
    return refine(query, coarse, pages, current, start)
  }

  export async function bench(input: z.input<typeof BenchInput>, model?: SearchModel) {
    const start = Date.now()
    const params = BenchInput.parse(input)
    const current = await pick(model)
    const coarse = params.items.map((item) => ({
      id: item.id,
      provider: "external" as const,
      rank: item.rank,
      name: item.name,
      description: item.description,
      source: item.source,
      installed: false,
    }))
    const pages = params.items.map((item, idx) => ({
      item: coarse[idx]!,
      page: item.body ? { text: item.body, source: item.summary_source ?? "skill_md" } : undefined,
    }))
    return refine(params.query, coarse, pages, current, start)
  }

  export async function installed() {
    return current()
  }

  export async function describe(input: z.input<typeof DescribeInput>) {
    const params = DescribeInput.parse(input)
    const key = params.url ?? params.package ?? params.id
    const cached = memo.get(key)
    if (cached && Date.now() - cached.at < SUMMARY_TTL) return cached.result
    const inflight = pending.get(key)
    if (inflight) return inflight

    const run = gate(2, async () => {
      const current = await pick()
      const content = await page(key, params.url)
      const result = {
        summary_zh: await zh(params, content?.text, current),
        summary_source: content?.source ?? "fallback",
      } satisfies z.infer<typeof DescribeResult>
      memo.set(key, { at: Date.now(), result })
      return result
    }).finally(() => pending.delete(key))

    pending.set(key, run)
    return run
  }

  export async function check() {
    const base = await current()
    const st = await state()
    const registryItems = await registry()
    const registryMap = new Map(registryItems.map((item) => [`${item.registry}#${item.name}`, item]))
    const external = base.some((item) => item.provider === "external" && item.scope === "project" && item.source)
      ? await checkExternal()
      : { updates: {}, failed: {} }
    return base.map((item) => {
      if (item.provider === "registry" && item.registry) {
        const next = registryMap.get(`${item.registry}#${item.name}`)
        const prev = st.lock.skills[item.name]
        const update = !!next && (next.version !== prev?.version || next.checksum !== prev?.checksum)
        return { ...item, description: next?.description, update_available: update }
      }
      if (item.provider === "external" && item.scope === "project" && item.source) {
        return {
          ...item,
          update_available: external.updates[item.name] === item.source,
        }
      }
      return item
    })
  }

  export async function jobs() {
    const ids = list.get(Instance.directory) ?? []
    return ids.flatMap((id) => {
      const job = task.get(id)
      return job ? [view(job)] : []
    })
  }

  export async function install(input: z.input<typeof InstallInput>) {
    const params = InstallInput.parse(input)
    const directory = Instance.directory
    const job =
      params.kind === "registry"
        ? ({
            job_id: crypto.randomUUID(),
            id: `${params.registry}#${params.name}`,
            directory,
            provider: "registry" as const,
            name: params.name,
            registry: params.registry,
            status: "queued" as const,
            work: async () => {
              const item = await registry().then((items) =>
                items.find((item) => item.registry === params.registry && item.name === params.name),
              )
              if (!item) throw new Error(`Skill "${params.name}" not found in registry`)
              await addRegistry(item)
              await Instance.dispose()
            },
          } satisfies Job)
        : ((item) =>
            ({
              job_id: crypto.randomUUID(),
              id: params.package,
              directory,
              provider: "external" as const,
              name: item.skill,
              package: params.package,
              source: item.source,
              scope: params.scope,
              status: "queued" as const,
              work: async () => {
                await addExternal({
                  source: item.source,
                  skill: item.skill,
                  scope: params.scope,
                })
                await Instance.dispose()
              },
            } satisfies Job))(splitPackage(params.package))
    put(job)
    wait.push(job.job_id)
    step()
    return view(task.get(job.job_id)!)
  }

  export async function update(input: z.input<typeof UpdateInput>) {
    const params = UpdateInput.parse(input)
    const names = new Set(params.names ?? [])
    const status = await check()
    const list = status.filter((item) => item.update_available && (names.size === 0 || names.has(item.name)))
    const registryMap = await registry().then((items) => new Map(items.map((item) => [`${item.registry}#${item.name}`, item])))

    for (const item of list) {
      if (item.provider === "registry" && item.registry) {
        const next = registryMap.get(`${item.registry}#${item.name}`)
        if (!next) continue
        await addRegistry(next)
        continue
      }
      if (item.provider === "external" && item.scope === "project" && "source" in item && item.source) {
        await addExternal({
          source: item.source,
          skill: item.name,
          scope: "project",
        })
      }
    }

    if (list.length > 0) await Instance.dispose()
    return { ok: true, updated: list.map((item) => item.name) }
  }
}
