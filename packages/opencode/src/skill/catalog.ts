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
import { Skill } from "@/skill"

const Rank = z.enum(["exact", "semantic"])
const Relevance = z.enum(["high", "medium", "low"])
const Tier = z.enum(["main", "more"])
const Scope = z.enum(["project", "global"])
const ProviderKind = z.enum(["registry", "external"])
const Role = z.enum(["direct", "supporting", "meta", "unrelated"])
const SummarySource = z.enum(["skills_summary", "skill_md"])
const DescribeSource = z.enum(["skills_summary", "skill_md", "fallback"])
const InstallStatus = z.enum(["queued", "running", "success", "error"])
const SearchStatus = z.enum(["success", "timeout", "error", "pending"])
const SearchSource = z.object({
  status: SearchStatus,
  count: z.number().optional(),
  message: z.string().optional(),
})

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
  probe: z.string().optional(),
  probe_index: z.number().optional(),
  installed: z.boolean().default(false),
  scope: Scope.optional(),
  update_available: z.boolean().optional(),
  summary_zh: z.string().optional(),
  summary_source: SummarySource.optional(),
  why_recommended: z.string().optional(),
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
    local: SearchSource.optional(),
    external: SearchSource.optional(),
  }),
})
export type SearchOutput = z.infer<typeof SearchOutput>

type FindResult = {
  package: string
  installs?: string
  source: string
  name: string
  url: string
}
type FindState = z.infer<typeof SearchStatus>
type FindOutput = {
  status: FindState
  items: FindResult[]
  message?: string
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

const Plan = z.object({
  goal: z.string().optional().default(""),
  domain: z.string().optional().default(""),
  action: z.string().optional().default(""),
  artifact: z.string().optional().default(""),
  tags: z.array(z.string()).max(8).default([]),
  native: z.array(z.string()).max(6).default([]),
  direct: z.array(z.string()).max(6).default([]),
  supporting: z.array(z.string()).max(6).default([]),
  broad: z.array(z.string()).max(6).default([]),
  probes: z.array(z.string()).max(6).default([]),
  avoid: z.array(z.string()).max(6).default([]),
  meta: z.boolean().default(false),
})

const Review = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        relevance: Relevance,
        role: Role,
        why_recommended: z.string().trim().optional().default(""),
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
type LocalInfo = Awaited<ReturnType<typeof Skill.all>>[number]
type SearchPlan = z.infer<typeof Plan>
type Reviewed = {
  id: string
  relevance: z.infer<typeof Relevance>
  role: z.infer<typeof Role>
  why_recommended?: string
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
const FIND_MS = 15_000
const WEB_MS = 6_000
const PAGE_MS = 2_500
const SUMMARY_TTL = 86_400_000
const SEARCH_TTL = 30_000
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
const SEARCH_MODELS = [
  "opencode/big-pickle",
  "opencode/qwen3.6-plus-free",
  "opencode/gpt-5-nano",
  "opencode/nemotron-3-super-free",
  "opencode/minimax-m2.5-free",
] as const
const memo = new Map<string, { at: number; result: z.infer<typeof DescribeResult> }>()
const pending = new Map<string, Promise<z.infer<typeof DescribeResult>>>()
const findMemo = new Map<string, { at: number; result: FindOutput }>()
const findPending = new Map<string, Promise<FindOutput>>()
const webMemo = new Map<string, { at: number; result: FindOutput }>()
const webPending = new Map<string, Promise<FindOutput>>()
const pageMemo = new Map<string, { at: number; result: Page | undefined }>()
const pagePending = new Map<string, Promise<Page | undefined>>()
const slots = new Map<number, { queue: Array<() => void>; count: number }>()
const task = new Map<string, Job>()
const wait: string[] = []
const list = new Map<string, string[]>()
let active = 0

export function resetForTest() {
  memo.clear()
  pending.clear()
  findMemo.clear()
  findPending.clear()
  webMemo.clear()
  webPending.clear()
  pageMemo.clear()
  pagePending.clear()
  slots.clear()
  task.clear()
  wait.splice(0, wait.length)
  list.clear()
  active = 0
}

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
    .catch((err) => ({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
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

const cue = {
  academic: {
    test: /(学术|科研|研究|论文|期刊|会议|投稿|答辩|academic|research|scientific|scholarly|journal|conference|thesis)/i,
    probes: ["academic", "research", "scientific"],
    label: "学术研究",
  },
  manuscript: {
    test: /(论文|稿件|摘要|引言|latex|manuscript|paper|abstract|introduction|citation)/i,
    probes: ["paper", "manuscript", "latex"],
    label: "论文写作",
  },
  polish: {
    test: /(润色|校对|修改|proofread|proofreading|polish|editing|editorial|grammar)/i,
    probes: ["polish", "proofread", "editing"],
    label: "润色校对",
  },
  human: {
    test: /(人味|自然表达|更自然|自然一些|自然点|更像人|去ai|改写|真人|humanize|humanizer|human sounding|more human|human|natural writing|natural language|rewrite|tone)/i,
    probes: ["humanize writing", "natural writing", "rewrite"],
    label: "自然改写",
  },
  translate: {
    test: /(翻译|translate|translation|translator|localize|localization|localisation|localized|bilingual)/i,
    probes: ["translate", "translation"],
    label: "翻译转换",
  },
  convert: {
    test: /(转换|转成|导出|convert|conversion|markdown|to markdown|to pdf|to md|to docx)/i,
    probes: ["convert", "markdown conversion"],
    label: "内容转换",
  },
  visualization: {
    test:
      /(绘图|作图|画图|可视化|图表|曲线|\bfigure(?:s)?\b|\bchart(?:s)?\b|\bgraph(?:s)?\b|\bdiagram(?:s)?\b|\bplots\b|\bplotting\b|\bplotly\b|\bvisualization\b)/i,
    probes: ["visualization", "plotting", "chart", "figure"],
    label: "图表可视化",
  },
  browser: {
    test: /(浏览器|网页|页面|元素|交互|点击|playwright|browser|automation|website|web page|page|element|interaction|click through|click|inspect|web testing|ui checks)/i,
    probes: ["browser automation", "playwright", "page interaction"],
    label: "浏览器自动化",
  },
  slides: {
    test: /(幻灯片|演示|slides|presentation|deck|powerpoint|ppt|reveal)/i,
    probes: ["slides", "presentation"],
    label: "演示文稿",
  },
  pdf: {
    test: /(pdf|导出|打印|markdown to pdf|docx export)/i,
    probes: ["pdf export", "markdown pdf"],
    label: "文档导出",
  },
  docs: {
    test: /(文档|document|documents|documentation|docs|api guide|technical docs)/i,
    probes: ["technical docs", "documentation"],
    label: "技术文档",
  },
  update: {
    test: /(更新|同步|刷新|update|updater|refresh|sync|maintenance)/i,
    probes: ["skill updater", "auto updater"],
    label: "更新维护",
  },
  meta: {
    test: /(技能|skill|skills|插件|plugin|plugins|marketplace|find skills|discover skills|install skills)/i,
    probes: ["find skills", "skill discovery", "install skills"],
    label: "技能发现",
  },
  code: {
    test: /(代码|重构|格式化|lint|refactor|code|coding|devtool)/i,
    probes: ["code tools", "refactor"],
    label: "代码处理",
  },
  media: {
    test: /(视频|音频|字幕|多媒体|video|audio|subtitle|caption|multimedia)/i,
    probes: ["video editing", "subtitle"],
    label: "多媒体处理",
  },
} as const

function mark(input: string) {
  return Object.entries(cue).reduce((out, [key, value]) => {
    if (value.test.test(input)) out.add(key)
    return out
  }, new Set<string>())
}

function meta(tags: Set<string>) {
  if (tags.has("update") && ![...tags].some((item) => !["meta", "update"].includes(item))) return true
  if (tags.has("meta") && ![...tags].some((item) => item !== "meta")) return true
  return false
}

function infer(query: string): SearchPlan {
  const tags = mark(query)
  const english = /(英文|english)/i.test(query)
  const wantMeta = meta(tags)
  const kept = [...tags].filter((item) => wantMeta || item !== "meta")
  const direct = [
    ...(latin(query) ? [clean(query)] : []),
    ...(tags.has("manuscript") && tags.has("polish")
      ? [
          "paper polish",
          "proofread manuscript",
          "proofread paper",
          "professional proofreader",
          ...(english ? ["english proofreading"] : []),
        ]
      : []),
    ...(tags.has("academic") && tags.has("visualization")
      ? ["scientific visualization", "scientific plotting", "figure generation"]
      : []),
    ...(tags.has("translate") && tags.has("manuscript")
      ? [
          "paper translation",
          "paper translator",
          "manuscript translation",
          "manuscript translator",
          "academic translation",
          "academic translator",
        ]
      : []),
    ...(tags.has("translate") && tags.has("docs")
      ? [
          "technical docs translation",
          "docs translation",
          "document translation",
          "documentation translation",
          "documentation localization",
          "technical translator",
        ]
      : []),
    ...(tags.has("human") && tags.has("academic") ? ["academic writing humanizer"] : []),
    ...(tags.has("browser") ? ["browser automation", "playwright"] : []),
    ...(tags.has("slides") && tags.has("academic") ? ["scientific slides", "research presentation"] : []),
    ...(tags.has("pdf") ? ["pdf export", "markdown pdf"] : []),
    ...(wantMeta ? (tags.has("update") ? ["auto updater", "skill updater"] : ["find skills", "skill discovery"]) : []),
  ].filter(Boolean)
  const supporting = [
    ...(tags.has("human") ? ["humanize writing", "natural writing"] : []),
    ...(tags.has("docs") ? ["technical docs", "documentation"] : []),
    ...(tags.has("slides") && !tags.has("academic") ? ["presentation skills"] : []),
    ...kept.flatMap((item) => {
      if (["academic", "manuscript", "translate"].includes(item)) return []
      if (item === "polish" && tags.has("manuscript")) return []
      if (wantMeta && ["meta", "update"].includes(item)) return []
      return cue[item as keyof typeof cue]?.probes ?? []
    }),
  ].filter(Boolean)
  const broad = kept.flatMap((item) => {
    if (!["academic", "manuscript", "translate"].includes(item)) return []
    return cue[item as keyof typeof cue]?.probes ?? []
  })
  const probes = [...direct, ...supporting, ...broad].filter((item, idx, arr) => item && arr.indexOf(item) === idx)
  return {
    goal: query,
    domain: tags.has("academic") ? "academic" : tags.has("docs") ? "documentation" : "general",
    action: tags.has("translate")
      ? tags.has("academic") && tags.has("manuscript") && tags.has("polish")
        ? "polish"
        : "translate"
      : tags.has("convert")
        ? "convert"
        : tags.has("polish")
        ? "polish"
        : tags.has("human")
          ? "humanize"
          : tags.has("visualization")
            ? "visualize"
            : tags.has("browser")
              ? "automate"
              : tags.has("slides")
                ? "present"
                : tags.has("pdf")
                  ? "export"
                  : tags.has("update")
                    ? "update"
                    : wantMeta
                      ? "discover"
                      : "",
    artifact: tags.has("manuscript")
      ? "manuscript"
      : tags.has("visualization")
        ? "figures"
        : tags.has("slides")
          ? "slides"
          : tags.has("pdf")
            ? "documents"
            : tags.has("browser")
              ? "browser"
              : tags.has("docs")
                ? "documentation"
                : wantMeta
                  ? "skills"
                  : "",
    tags: kept.filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 8),
    native: latin(query) ? [] : [query.trim()].filter(Boolean).slice(0, 6),
    direct: direct.filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 6),
    supporting: supporting.filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 6),
    broad: broad.filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 6),
    probes: probes.filter((item, idx, arr) => item && arr.indexOf(item) === idx).slice(0, 6),
    avoid: wantMeta ? [] : ["meta"],
    meta: wantMeta,
  }
}

function score(query: string, text: string) {
  const q = clean(query)
  const t = clean(text)
  if (!q || !t) return undefined
  if (t === q) return "exact" as const
  if (t.includes(q)) return "exact" as const
  return tokens(q).every((part) => t.includes(part)) ? ("semantic" as const) : undefined
}

function hit(query: string, text: string, extra: string[]) {
  return [query, ...extra]
    .flatMap((term, idx) => {
      const rank = score(term, text)
      if (!rank) return []
      return [{
        term,
        rank,
        idx,
        size: tokens(term).filter(useful).length,
      }]
    })
    .toSorted((a, b) => {
      const left = (a.rank === "exact" ? 100 : 0) + a.size * 10 - a.idx
      const right = (b.rank === "exact" ? 100 : 0) + b.size * 10 - b.idx
      return right - left
    })[0]
}

function useful(input: string) {
  const skip = new Set(["skill", "skills", "find", "install", "plugin", "plugins", "marketplace", "tool", "tools"])
  return tokens(input).some((item) => !skip.has(item))
}

function latin(input: string) {
  return /^[\x00-\x7f\s-]+$/.test(input) && /[a-z]/i.test(input)
}

function arrange(
  input: string,
  extra: {
    phrases?: string[]
    keywords?: string[]
    probes?: string[]
    native?: string[]
    direct?: string[]
    supporting?: string[]
    broad?: string[]
  },
  full = false,
) {
  const fallback = infer(input)
  const native = extra.native ?? fallback.native
  const direct = extra.direct ?? fallback.direct
  const supporting = extra.supporting ?? ("probes" in extra ? extra.probes ?? [] : [...(extra.phrases ?? []), ...(extra.keywords ?? [])])
  const broad = extra.broad ?? fallback.broad
  const list = [
    { text: input, source: "input" as const, band: "direct" as const },
    ...native.map((item) => ({ text: item, source: "probe" as const, band: "native" as const })),
    ...direct.map((item) => ({ text: item, source: "probe" as const, band: "direct" as const })),
    ...supporting.map((item) => ({ text: item, source: "probe" as const, band: "supporting" as const })),
    ...broad.map((item) => ({ text: item, source: "probe" as const, band: "broad" as const })),
  ]
    .flatMap((item) => {
      const raw = item.text.trim()
      const norm = clean(item.text)
      return [
        ...(latin(raw) && /[-_./@]/.test(raw) ? [{ ...item, text: raw }] : []),
        ...(norm ? [{ ...item, text: norm }] : []),
      ]
    })
    .filter((item) => item.text)
    .filter((item) => item.source === "probe" || useful(item.text))
  const hasLatin = list.some((item) => latin(item.text))
  const rows = hasLatin ? list.filter((item) => latin(item.text) || item.band === "native" || item.source === "input") : list
  const wide = rows.some((item) => item.text.includes(" "))
  const kept = rows
    .filter((item) => {
      if (!wide || item.text.includes(" ") || item.source === "probe") return true
      return !rows.some((other) => other.text.includes(" ") && clean(other.text).includes(item.text))
    })
    .filter((item, idx, arr) => arr.findIndex((other) => other.text === item.text) === idx)
  return kept
    .toSorted((a, b) => {
      const base = tokens(input).filter(useful)
      const leftMatch = tokens(a.text).filter((item) => base.includes(item)).length
      const rightMatch = tokens(b.text).filter((item) => base.includes(item)).length
      const leftUseful = tokens(a.text).filter(useful).length
      const rightUseful = tokens(b.text).filter(useful).length
      const leftBand = a.band === "direct" ? 40 : a.band === "native" ? 34 : a.band === "supporting" ? 10 : -30
      const rightBand = b.band === "direct" ? 40 : b.band === "native" ? 34 : b.band === "supporting" ? 10 : -30
      const left = (clean(a.text) === clean(input) ? 100 : 0) +
        (a.source === "input" ? 10 : 0) +
        (latin(a.text) && /[-_./@]/.test(a.text) ? 12 : 0) +
        leftBand +
        leftMatch * 20 +
        leftUseful * 8 -
        (tokens(a.text).length - leftUseful) * 6 +
        Math.min(a.text.length, 24)
      const right = (clean(b.text) === clean(input) ? 100 : 0) +
        (b.source === "input" ? 10 : 0) +
        (latin(b.text) && /[-_./@]/.test(b.text) ? 12 : 0) +
        rightBand +
        rightMatch * 20 +
        rightUseful * 8 -
        (tokens(b.text).length - rightUseful) * 6 +
        Math.min(b.text.length, 24)
      if (left !== right) return right - left
      return a.text.localeCompare(b.text)
    })
    .filter((item, idx, arr) => full || item.band !== "broad" || arr.filter((next) => next.band !== "broad").length < 3)
    .map((item) => item.text)
    .slice(0, 6)
}

export function queries(
  input: string,
  extra: {
    phrases?: string[]
    keywords?: string[]
    probes?: string[]
    native?: string[]
    direct?: string[]
    supporting?: string[]
    broad?: string[]
  },
) {
  return arrange(input, extra)
}

function allQueries(
  input: string,
  extra: {
    phrases?: string[]
    keywords?: string[]
    probes?: string[]
    native?: string[]
    direct?: string[]
    supporting?: string[]
    broad?: string[]
  },
) {
  return arrange(input, extra, true)
}

async function discover(query: string, plan: SearchPlan, st: Awaited<ReturnType<typeof state>>, searches: string[], extra: string[]) {
  const runs = await Promise.all(searches.map(async (item) => ({ probe: item, out: await find(item, FIND_MS) })))
  const found = fold(runs.map((item) => item.out))
  const items = runs
    .flatMap((run) => run.out.items.map((item) => ({ item, probe: run.probe })))
    .map(({ item, probe }) => externalResult(query, item, st, [...extra, ...searches], probe))
    .filter((item): item is SearchResult => !!item)
  return { found, items }
}

async function discoverWeb(query: string, plan: SearchPlan, st: Awaited<ReturnType<typeof state>>, searches: string[], extra: string[]) {
  const runs = await Promise.all(searches.map(async (item) => ({ probe: item, out: await webFind(item, WEB_MS) })))
  const found = fold(runs.map((item) => item.out))
  const items = runs
    .flatMap((run) => run.out.items.map((item) => ({ item, probe: run.probe })))
    .map(({ item, probe }) => externalResult(query, item, st, [...extra, ...searches], probe))
    .filter((item): item is SearchResult => !!item)
    .filter((item) => {
      const next = role(query, plan, item)
      if (next === "direct" || next === "supporting") return true
      return next === "meta" && plan.meta
    })
  return { found, items }
}

function blend(query: string, next: SearchPlan) {
  const base = infer(query)
  return {
    ...next,
    goal: next.goal || base.goal,
    domain: next.domain && next.domain !== "general" ? next.domain : base.domain,
    action: next.action || base.action,
    artifact: next.artifact || base.artifact,
    tags: [...next.tags, ...base.tags].filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 8),
    native: [...next.native, ...base.native].filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 6),
    direct: [...next.direct, ...base.direct].filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 6),
    supporting: [...next.supporting, ...base.supporting]
      .filter((item, idx, arr) => arr.indexOf(item) === idx)
      .slice(0, 6),
    broad: [...next.broad, ...base.broad].filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 6),
    probes: [...next.probes, ...next.native, ...next.direct, ...next.supporting, ...next.broad, ...base.probes, ...base.native, ...base.direct, ...base.supporting, ...base.broad]
      .filter((item, idx, arr) => arr.indexOf(item) === idx)
      .slice(0, 6),
    avoid: [...next.avoid, ...base.avoid].filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 6),
    meta: next.meta || base.meta,
  } satisfies SearchPlan
}

function same(plan: SearchPlan, item: SearchResult, body?: string) {
  const hit = match(plan, item, body)
  return hit.tags
}

function profile(item: SearchResult, body?: string) {
  return infer(
    [
      item.name,
      item.description,
      clip((body ?? "").replace(/\s+/g, " ").trim(), 320),
    ]
      .filter(Boolean)
      .join(" "),
  )
}

function match(plan: SearchPlan, item: SearchResult, body?: string) {
  const next = profile(item, body)
  return {
    next,
    tags: plan.tags.filter((tag) => next.tags.includes(tag)),
    domain: !!plan.domain && plan.domain !== "general" && plan.domain === next.domain,
    action: !!plan.action && plan.action === next.action,
    artifact: !!plan.artifact && plan.artifact === next.artifact,
  }
}

function target(plan: SearchPlan) {
  if (plan.action === "translate" && plan.artifact === "manuscript") return "论文翻译"
  if (plan.action === "translate" && plan.artifact === "documentation") return "文档翻译"
  if (plan.action === "translate") return "翻译转换"
  if (plan.action === "visualize" || plan.artifact === "figures") return "图表可视化"
  if (plan.action === "polish" || plan.artifact === "manuscript") return "论文处理"
  if (plan.action === "humanize") return "自然改写"
  if (plan.action === "automate" || plan.artifact === "browser") return "浏览器自动化"
  if (plan.action === "present" || plan.artifact === "slides") return "演示文稿"
  if (plan.action === "export" || plan.artifact === "documents") return "文档导出"
  if (plan.meta) return "技能发现"
  return "当前任务"
}

function translateDirect(item: SearchResult) {
  const text = [item.name, item.package, item.source].filter(Boolean).join(" ")
  return /(translate|translator|translation|locali[sz]ation|i18n|l10n|bilingual|multilingual)/i.test(text)
}

function reviewHelper(item: SearchResult) {
  const text = [item.name, item.package, item.source].filter(Boolean).join(" ")
  return /(review|proofread|proof[- ]?read|polish|editing?|editor|audit)/i.test(text)
}

function polishDirect(item: SearchResult, body?: string) {
  const text = [item.name, item.package, item.source].filter(Boolean).join(" ")
  return /(proofread|proof[- ]?read|proofreader|polish|copy[- ]?edit|editing|grammar|refiner)/i.test(text)
}

function polishSupport(item: SearchResult, body?: string) {
  const text = [item.name, item.package, item.source, item.description, body].filter(Boolean).join(" ")
  return /(review|manuscript|paper|submission|journal|research|academic)/i.test(text)
}

function translateKeep(item: SearchResult) {
  const text = clean([item.name, item.package, item.source].filter(Boolean).join(" "))
  if (["translation", "translator"].includes(text)) return false
  return !/(guide|review|provenance)/i.test(text)
}

function translateCue(plan: SearchPlan, item: SearchResult, body?: string) {
  const text = [item.name, item.package, item.source, item.description, body, item.probe].filter(Boolean).join(" ")
  if (plan.artifact === "manuscript") return /(academic|paper|manuscript|article|arxiv)/i.test(text)
  if (plan.artifact === "documentation") return /(doc|document|documentation|locali[sz]ation|i18n|l10n)/i.test(text)
  return /(translate|translation|translator)/i.test(text)
}

function translateSignal(plan: SearchPlan, item: SearchResult, body?: string) {
  if (!translateDirect(item) || !translateKeep(item)) return false
  const fit = match(plan, item, body)
  if (fit.action && fit.artifact) return true
  if (!item.probe) return false
  const probe = infer(item.probe)
  if (probe.action !== "translate") return false
  if (plan.artifact && probe.artifact === plan.artifact) return true
  if (translateCue(plan, item, body)) return true
  if (!plan.artifact && fit.action) return true
  return !!plan.domain && probe.domain === plan.domain && (!!fit.action || probe.artifact === plan.artifact)
}

function proofreadQuery(query: string) {
  return /(校对|proofread|proofreading|proofreader|grammar)/i.test(query)
}

function proofTool(item: SearchResult) {
  const text = [item.name, item.package, item.source].filter(Boolean).join(" ")
  return /(proofread|proof[- ]?read|proofreader|grammar)/i.test(text)
}

function role(query: string, plan: SearchPlan, item: SearchResult, body?: string): z.infer<typeof Role> {
  if (direct(query, item)) return "direct"
  const fit = match(plan, item, body)
  if (!plan.meta && (fit.next.meta || fit.next.tags.includes("update") || fit.next.tags.includes("meta")) && !fit.action && !fit.artifact) {
    return "meta"
  }
  const strict = !!plan.domain && plan.domain !== "general"
  if (
    plan.action === "polish" &&
    item.rank === "exact" &&
    proofTool(item) &&
    (plan.artifact === "manuscript" || proofreadQuery(query) || /(英文|english)/i.test(query))
  ) return "direct"
  if (plan.action === "polish" && proofreadQuery(query) && item.rank === "exact" && polishDirect(item, body)) return "direct"
  if (plan.action === "polish" && polishDirect(item, body) && !fit.artifact && !fit.domain) return same(plan, item, body).length >= 1 ? "supporting" : "unrelated"
  if (plan.action === "polish" && polishSupport(item, body) && !polishDirect(item, body)) return fit.artifact || fit.domain ? "supporting" : "unrelated"
  if (plan.action === "polish" && polishDirect(item, body) && (fit.artifact || fit.domain)) return "direct"
  if (plan.action === "translate" && reviewHelper(item) && !translateDirect(item)) return fit.artifact || fit.domain ? "supporting" : "unrelated"
  if (plan.action === "translate" && translateSignal(plan, item, body)) return "direct"
  if (plan.action === "translate" && fit.action && fit.artifact) return "direct"
  if (fit.action && fit.artifact && (!strict || fit.domain)) return "direct"
  if (fit.action && !plan.artifact && (fit.domain || (!strict && fit.tags.length >= 1))) return "direct"
  if (fit.artifact && !plan.action && (fit.domain || (!strict && fit.tags.length >= 1))) return "direct"
  if (fit.artifact && fit.domain && fit.tags.length >= 2) return "supporting"
  if (fit.action || fit.artifact) return "supporting"
  if (fit.domain && fit.tags.length >= 2) return "supporting"
  return fit.next.meta || fit.next.tags.includes("update") || fit.next.tags.includes("meta") ? "meta" : "unrelated"
}

function reason(query: string, plan: SearchPlan, item: SearchResult, body?: string, next?: z.infer<typeof Role>) {
  if (direct(query, item)) return "直接匹配当前搜索目标。"
  const roleName = next ?? role(query, plan, item, body)
  if (roleName === "meta") {
    if (plan.meta) return "直接面向技能搜索、安装或更新流程。"
    return "更像技能发现或安装工具，不是直接完成当前任务的技能。"
  }
  if (roleName === "supporting") {
    const fit = match(plan, item, body)
    const head = item.installed ? "已安装，且" : ""
    if (fit.action && fit.artifact) return `${head}与${target(plan)}高度相关，但更偏相邻工作流。`
    if (fit.action || fit.artifact) return `${head}与${target(plan)}相关，但更偏相邻工作流。`
    if (fit.domain) return `${head}与当前领域相关，但更偏相邻工作流。`
    return item.installed ? "已安装，可辅助当前目标。" : "与当前目标相关，但更偏辅助流程。"
  }
  const fit = match(plan, item, body)
  const head = item.installed ? "已安装，且" : ""
  if (fit.action && fit.artifact) return `${head}直接匹配${target(plan)}目标。`
  if (fit.action) return `${head}动作上贴合${target(plan)}目标。`
  if (fit.artifact) return `${head}产物上贴合${target(plan)}目标。`
  if (fit.domain) return `${head}与当前领域相关，但更偏相邻工作流。`
  return item.installed ? "已安装，可直接用于当前目标。" : "与当前目标相关。"
}

function relate(query: string, plan: SearchPlan, item: SearchResult, body?: string): z.infer<typeof Relevance> {
  const kind = role(query, plan, item, body)
  if (kind === "direct") return "high"
  if (kind === "supporting") return "medium"
  if (kind === "meta" && plan.meta) return item.rank === "exact" ? "high" : "medium"
  if (item.rank === "exact") return "medium"
  return "low"
}

function level(
  query: string,
  plan: SearchPlan,
  item: SearchResult,
  body?: string,
  review?: z.infer<typeof Relevance>,
): z.infer<typeof Relevance> {
  const base = relate(query, plan, item, body)
  if (!review) return base
  if (base === "high") return "high"
  if (base === "low") return "low"
  return review === "low" ? "low" : "medium"
}

export function split(query: string, item: SearchResult, body?: string, relevance?: z.infer<typeof Relevance>) {
  const plan = infer(query)
  const kind = role(query, plan, item, body)
  if (kind === "unrelated") return
  if (kind === "meta" && !plan.meta) return
  const rank = relevance ?? item.relevance ?? relate(query, plan, item, body)
  if (item.provider === "external" && !body && kind !== "direct") return item.rank === "exact" ? ("more" as const) : undefined
  if (kind === "direct") return "main" as const
  if (kind === "supporting") return "more" as const
  if (kind === "meta") return rank === "high" ? ("main" as const) : ("more" as const)
  if (rank === "high") return "main" as const
  if (rank === "medium") return "more" as const
}

async function refine(
  query: string,
  plan: SearchPlan,
  coarse: SearchResult[],
  pages: Array<{ item: SearchResult; page?: Page }>,
  model?: SearchModel,
  start = Date.now(),
) {
  const order = new Set(merge(query, coarse))
  const body = new Map(pages.map((item) => [item.item.id, item.page]))
  const rated = await review(query, plan, pages.filter((entry) => entry.page || entry.item.provider === "external"), model)
  const map = new Map(rated.map((item) => [item.id, item]))
  const refined = coarse.reduce<SearchResult[]>((acc, item) => {
    if (item.provider === "registry") {
      const relevance = item.rank === "exact" ? "high" : "medium"
      const tier = split(query, item, item.description, relevance)
      if (!tier) return acc
      acc.push({
        ...item,
        relevance,
        why_recommended: reason(query, plan, item, item.description),
        tier,
      })
      return acc
    }
    const page = body.get(item.id)
    const next = map.get(item.id)
    const relevance = level(query, plan, item, page?.text, next?.relevance)
    const tier = split(query, item, page?.text, relevance)
    if (!tier) return acc
    acc.push({
      ...item,
      relevance,
      summary_zh: next?.summary_zh,
      summary_source: page?.source,
      why_recommended: next?.why_recommended ?? reason(query, plan, item, page?.text, next?.role),
      tier,
    })
    return acc
  }, [])
  const sorted = refined.toSorted((a, b) => {
    const left = a.relevance === "high" ? 2 : a.relevance === "medium" ? 1 : 0
    const right = b.relevance === "high" ? 2 : b.relevance === "medium" ? 1 : 0
    if (left !== right) return right - left
    const leftDirect = direct(query, a) ? 1 : 0
    const rightDirect = direct(query, b) ? 1 : 0
    if (leftDirect !== rightDirect) return rightDirect - leftDirect
    if (plan.tags.length > 0 || plan.meta) {
      const leftCover = cover(query, a)
      const rightCover = cover(query, b)
      if (leftCover !== rightCover) return rightCover - leftCover
      const leftFresh = a.provider === "external" && !a.installed ? 1 : 0
      const rightFresh = b.provider === "external" && !b.installed ? 1 : 0
      if (leftFresh !== rightFresh) return rightFresh - leftFresh
    }
    return [...order].indexOf(a.id) - [...order].indexOf(b.id)
  })
  const precise = sorted.some((item) => named(query, item))
  const main = sorted
    .filter((item) => item.tier === "main")
    .filter((item) => !precise || named(query, item))
  const more = sorted
    .filter((item) => item.tier === "more" || (precise && item.tier === "main" && !named(query, item)))
  const edge = main
    .filter((item) => item.provider === "external" && !item.installed)
    .flatMap((item) => (item.probe_index === undefined ? [] : [item.probe_index]))
    .sort((a, b) => a - b)[0]
  const parked = edge === undefined || plan.artifact !== "manuscript"
    ? []
    : main.filter(
        (item) =>
          item.installed &&
          !named(query, item) &&
          item.probe_index !== undefined &&
          item.probe_index > edge,
      )
  const lead = edge === undefined ? main : main.filter((item) => !parked.includes(item))
  const seen = new Set<string>()
  const keep = (item: SearchResult) => {
    const key = clean(item.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  const rise = plan.action !== "translate" || lead.some((item) => translateSignal(plan, item, body.get(item.id)?.text))
    ? undefined
    : more.find((item) => item.provider === "external" && !item.installed && translateSignal(plan, item, body.get(item.id)?.text))
  return {
    main: (rise ? [rise, ...lead.filter((item) => item.id !== rise.id)] : lead).filter(keep),
    more: (rise ? [...parked, ...more.filter((item) => item.id !== rise.id)] : [...parked, ...more]).filter(keep),
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

function named(query: string, item: SearchResult) {
  return clean(item.name) === clean(query)
}

function direct(query: string, item: SearchResult) {
  return named(query, item)
}

function width(plan: SearchPlan) {
  if (plan.action === "polish" && plan.artifact === "manuscript") return 4
  return 3
}

function primary(query: string, plan: SearchPlan) {
  const list = queries(query, plan)
  if (latin(query) || plan.native.length === 0) return list.slice(0, width(plan))
  return [...queries(query, { native: plan.native, direct: [], supporting: [], broad: [] }), ...list]
    .filter((item, idx, arr) => arr.indexOf(item) === idx)
    .slice(0, Math.min(width(plan) + 1, 6))
}

function cover(query: string, item: SearchResult) {
  const text = clean([item.name, item.package, item.source, item.registry, item.description].filter(Boolean).join(" "))
  return allQueries(query, infer(query)).reduce((best, probe) => {
    const next = tokens(probe).filter((part) => text.includes(part)).length
    return next > best ? next : best
  }, 0)
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
  const fallback = infer(query)
  return limit(1200, fallback, async () =>
    {
      const resolved = await language(model)
      if (!resolved.language) return fallback

      return generateObject({
        model: resolved.language,
        temperature: 0.2,
        schema: Plan,
        messages: [
          {
            role: "system",
            content:
              "You are planning a goal-directed skill search. Extract the user's goal, action, artifact, and domain. Then produce a bilingual retrieval plan: native probes in the user's language or wording, direct English discovery probes for the exact task, supporting probes for adjacent workflow language, and broad probes only for fallback recall. Native probes should preserve the user's original intent phrasing instead of translating everything away. Also return 0-6 tags that describe the real task, plus whether the user explicitly wants meta tools for finding or installing skills. Prefer direct-task skills over meta tools unless the user is clearly asking for skill discovery, installation, or updating.",
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

async function find(query: string, ms = CLI_MS): Promise<FindOutput> {
  const cached = findMemo.get(query)
  if (cached && Date.now() - cached.at < SEARCH_TTL) return cached.result
  const inflight = findPending.get(query)
  if (inflight) return inflight

  const run = exec(["npx", "-y", "skills", "find", query], ms)
    .then((out) => {
      const text = out.text.trim()
      const message = out.stderr.toString().trim() || text || undefined
      if ((text || message)?.includes("No skills found")) {
        return {
          status: "success" as const,
          items: [],
        }
      }
      if (out.code === 0) {
        return {
          status: "success" as const,
          items: parseFind(text),
        }
      }
      return {
        status: message?.includes("aborted") ? ("timeout" as const) : ("error" as const),
        items: [],
        message,
      }
    })
    .finally(() => findPending.delete(query))

  findPending.set(query, run)
  const result = await run
  findMemo.set(query, { at: Date.now(), result })
  return result
}

async function webFind(query: string, ms = WEB_MS): Promise<FindOutput> {
  const cached = webMemo.get(query)
  if (cached && Date.now() - cached.at < SEARCH_TTL) return cached.result
  const inflight = webPending.get(query)
  if (inflight) return inflight
  const url = new URL("https://search.brave.com/search")
  url.searchParams.set("q", `site:skills.sh ${query}`)
  const run = fetch(url, {
    headers: {
      "user-agent": UA,
    },
    signal: AbortSignal.timeout(ms),
  })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`Failed to fetch ${url}`))))
    .then((text) => ({
      status: "success" as const,
      items: parseWeb(text),
    }))
    .catch((err: Error) => ({
      status: err.name === "TimeoutError" || err.name === "AbortError" ? ("timeout" as const) : ("error" as const),
      items: [],
      message: err.message,
    }))
    .finally(() => webPending.delete(query))
  webPending.set(query, run)
  const result = await run
  webMemo.set(query, { at: Date.now(), result })
  return result
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

function registryResult(
  query: string,
  item: RegistryItem,
  st: Awaited<ReturnType<typeof state>>,
  extra: string[],
): SearchResult | undefined {
  const text = entryText(item)
  const matched = hit(query, text, extra)
  if (!matched) return
  const installed = !!st.lock.skills[item.name]
  return {
    id: `${item.registry}#${item.name}`,
    provider: "registry",
    rank: matched.rank,
    name: item.name,
    description: item.description,
    registry: item.registry,
    version: item.version,
    probe: matched.term,
    probe_index: matched.idx,
    installed,
    scope: installed ? "project" : undefined,
  }
}

function localText(item: Installed, info?: LocalInfo) {
  return [item.name, item.source, item.registry, item.package, info?.description].filter(Boolean).join(" ")
}

function localResult(
  query: string,
  item: Installed,
  info: LocalInfo | undefined,
  extra: string[],
  semantic = false,
): SearchResult | undefined {
  const text = localText(item, info)
  const matched = hit(query, text, extra.filter(useful))
  let rank: SearchResult["rank"] | undefined = matched?.rank
  if (!rank && semantic) {
    const plan = infer(query)
    const preview = {
      ...item,
      rank: "semantic" as const,
      description: item.description ?? info?.description,
    }
    rank = relate(query, plan, preview, info?.description) === "low" ? undefined : "semantic"
  }
  if (!rank) return
  return {
    ...item,
    rank,
    probe: matched?.term,
    probe_index: matched?.idx,
    description: item.description ?? info?.description,
  }
}

function externalResult(
  query: string,
  item: FindResult,
  st: Awaited<ReturnType<typeof state>>,
  extra: string[],
  probe?: string,
): SearchResult | undefined {
  const text = [item.name, item.source].join(" ")
  const matched = hit(query, text, extra) ??
    (probe
      ? {
          term: probe,
          rank: "semantic" as const,
          idx: Math.max(0, extra.indexOf(probe)),
        }
      : undefined)
  if (!matched) return
  const project = st.ext?.skills[item.name]
  const global = st.global.has(item.name)
  return {
    id: item.package,
    provider: "external",
    rank: matched.rank,
    name: item.name,
    installs: item.installs,
    package: item.package,
    source: item.source,
    probe: matched.term,
    probe_index: matched.idx,
    url: item.url,
    installed: !!project || global,
    scope: project ? "project" : global ? "global" : undefined,
  }
}

function fold(list: FindOutput[]) {
  const items = list
    .flatMap((item) => item.items)
    .reduce((acc, item) => acc.set(item.package, item), new Map<string, FindResult>())
  const hit = list.some((item) => item.status === "success")
  if (hit) {
    return {
      status: "success" as const,
      items: [...items.values()],
    }
  }
  const timeout = list.find((item) => item.status === "timeout")
  if (timeout) {
    return {
      status: "timeout" as const,
      items: [],
      message: timeout.message,
    }
  }
  const error = list.find((item) => item.status === "error")
  return {
    status: error ? ("error" as const) : ("success" as const),
    items: [],
    message: error?.message,
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
  const all = [input.name, input.source, input.registry, input.description, body].filter(Boolean).join(" ")
  const tags = mark(all)
  const plan = infer([input.name, input.description, clip((body ?? "").replace(/\s+/g, " ").trim(), 320)].filter(Boolean).join(" "))
  const manuscript =
    plan.artifact === "manuscript" || /(学术|academic|paper|manuscript|论文|稿件|摘要|arxiv)/i.test(all)
  const docs = plan.artifact === "documentation" || /(docs|document|documentation|文档|本地化|api)/i.test(all)
  const translated = plan.action === "translate" || (tags.has("translate") && !tags.has("polish") && !tags.has("convert"))
  const guess =
    (tags.has("media") && "这个 skill 主要用于视频或多媒体内容的编辑与处理。") ||
    ((plan.action === "visualize" || plan.artifact === "figures") && "这个 skill 主要用于科研图表与科学可视化的生成。") ||
    (translated &&
      manuscript &&
      "这个 skill 主要用于学术论文的翻译与术语保真。") ||
    (plan.domain === "academic" &&
      plan.artifact === "manuscript" &&
      plan.action === "convert" &&
      "这个 skill 主要用于学术论文内容的转换、整理或审阅辅助。") ||
    (plan.domain === "academic" &&
      plan.artifact === "manuscript" &&
      plan.action === "polish" &&
      "这个 skill 主要用于学术论文或 LaTeX 文稿的润色、修改和校对。") ||
    (plan.domain === "academic" &&
      plan.artifact === "manuscript" &&
      "这个 skill 主要用于学术论文内容的转换、整理或审阅辅助。") ||
    (plan.action === "polish" && "这个 skill 主要用于英文文本的校对、语法修改和措辞润色。") ||
    (plan.action === "humanize" && "这个 skill 主要用于把文本改写得更自然、更像真人表达。") ||
    (translated && docs && "这个 skill 主要用于技术文档的翻译与本地化。") ||
    (plan.action === "convert" && "这个 skill 主要用于文档内容的转换、整理与导出。") ||
    (plan.action === "automate" && "这个 skill 主要用于浏览器自动化、页面检查与交互测试。") ||
    (plan.action === "present" && "这个 skill 主要用于演示文稿或幻灯片内容的生成。") ||
    (plan.action === "export" && "这个 skill 主要用于文档导出或 PDF 生成。") ||
    (plan.meta && plan.action !== "visualize" && plan.domain !== "academic" && "这个 skill 主要用于搜索、发现并安装其他技能。") ||
    (tags.has("code") && "这个 skill 主要用于代码整理、优化或修订。")
  const line = clip((body ?? input.description ?? "").replace(/\s+/g, " ").trim(), 120)
  if (guess) return guess.startsWith("这个 skill") ? guess : `这个 skill 主要${guess}。`
  if (line) return `这个 skill 主要围绕 ${line}`
  if (input.source) return `这是 ${input.source} 提供的 ${input.name} skill。当前只拿到了基础信息，建议先点开详情后再决定。`
  return `这是一个名为 ${input.name} 的 skill。当前只拿到了基础信息，建议先看详情。`
}

async function review(query: string, plan: SearchPlan, list: Array<{ item: SearchResult; page?: Page }>, model?: SearchModel) {
  const fallback = list.map((entry) => ({
    id: entry.item.id,
    relevance: relate(query, plan, entry.item, entry.page?.text),
    role: role(query, plan, entry.item, entry.page?.text),
    why_recommended: reason(query, plan, entry.item, entry.page?.text),
    summary_zh: entry.page?.text || entry.item.description || entry.item.probe
      ? brief(entry.item, entry.page?.text ?? entry.item.description ?? entry.item.probe)
      : undefined,
    summary_source: entry.page?.source,
  })) satisfies Reviewed[]

  if (list.length === 0) return fallback
  if (list.every((entry) => !entry.page?.text && !entry.item.description && !entry.item.probe)) return fallback

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
            "你是一个技能市场检索重排器。给定用户查询和若干 skill 的真实内容，请为每个 skill 输出 high/medium/low 相关度，并用简体中文写一句不超过 40 字的简介。只能依据提供材料，不要猜测没有出现的功能。额外要求：同时判断该 skill 是 direct（直接完成任务）、supporting（支持工作流）、meta（搜索/安装/更新其他技能的元工具）还是 unrelated。除非用户明确在找技能发现或更新工具，否则 meta 不应排在 direct 前面。再输出一句中文 why_recommended，说明它为什么适合或不适合当前目标。",
        },
        {
          role: "user",
          content: [
            `查询：${query}`,
            `目标：${plan.goal}`,
            `动作：${plan.action}`,
            `产物：${plan.artifact}`,
            `领域：${plan.domain}`,
            `标签：${plan.tags.join(", ")}`,
            `允许元工具：${plan.meta ? "yes" : "no"}`,
            ...list.map((entry) =>
              [
                `ID: ${entry.item.id}`,
                `Name: ${entry.item.name}`,
                `Source: ${entry.item.source ?? entry.item.registry ?? "unknown"}`,
                `Probe: ${entry.item.probe ?? ""}`,
                `Description: ${entry.item.description ?? ""}`,
                `Material: ${entry.page?.text ?? ""}`,
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
        role: next.role,
        why_recommended: next.why_recommended || item.why_recommended,
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

export function parseWeb(input: string) {
  const out: FindResult[] = []
  const seen = new Set<string>()
  const list = [...stripAnsi(input).matchAll(/https:\/\/skills\.sh\/[^\s"'<>]+/g)].map((item) => item[0]!)
  for (const raw of list) {
    const url = raw.replace(/[),.\]]+$/, "")
    const parts = new URL(url).pathname.split("/").filter(Boolean)
    if (parts.length < 2) continue
    if (["trending", "new", "top", "search", "f"].includes(parts[0]!)) continue
    const name = parts.at(-1)!
    const source = parts.slice(0, -1).join("/")
    if (!name || !source) continue
    const pkg = `${source}@${name}`
    if (seen.has(pkg)) continue
    seen.add(pkg)
    out.push({
      package: pkg,
      source,
      name,
      url,
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

  async function localInstalled(query: string, extra: string[], semantic = false) {
    const [list, info] = await Promise.all([current(), Skill.all()])
    const map = new Map(info.map((item) => [item.name, item]))
    const rows = list.reduce<Array<{ item: SearchResult; page?: Page }>>((acc, item) => {
        const skill = map.get(item.name)
        const next = localResult(query, item, skill, extra, semantic)
        if (!next) return acc
        acc.push({
          item: next,
          page: skill?.description || skill?.content
            ? ({
                text: skill.description ?? skill.content,
                source: "skill_md",
              } satisfies Page)
            : undefined,
        })
        return acc
      }, [])
    return {
      items: rows.map((item) => item.item),
      pages: rows,
    }
  }

  export async function search(input: z.input<typeof SearchInput>, model?: SearchModel) {
    const start = Date.now()
    const params = SearchInput.parse(input)
    const query = params.query.trim()
    const current = await pick(model)
    if (!query) {
      return {
        main: [],
        more: [],
        meta: {
          model: printModel(current),
          latency_ms: Date.now() - start,
          local: { status: "success", count: 0 },
          external: { status: "pending", count: 0 },
        },
      } satisfies SearchOutput
    }

    const plan = params.semantic === false ? infer(query) : blend(query, await semantic(query, current))
    const extra = queries(query, plan).filter((item) => clean(item) !== clean(query))
    const st = await state()
    const local = await localInstalled(query, extra, params.semantic !== false)
    const remote = await registry().then((items) =>
      items
        .map((item) => registryResult(query, item, st, extra))
        .filter((item): item is SearchResult => !!item),
    )
    const exact = [...local.items, ...remote].some((item) => direct(query, item))
    if (params.semantic === false) {
      const all = [...local.items, ...remote]
      const order = new Set(merge(query, all))
      const coarse = all.toSorted((a, b) => [...order].indexOf(a.id) - [...order].indexOf(b.id))
      const result = await refine(query, plan, coarse, local.pages, undefined, start)
      return {
        ...result,
        meta: {
          model: printModel(current),
          latency_ms: Date.now() - start,
          local: { status: "success", count: local.items.length },
          external: { status: "pending", count: remote.length },
        },
      } satisfies SearchOutput
    }
    if (exact) {
      const result = await refine(query, plan, [...local.items, ...remote], local.pages, current, start)
      return {
        ...result,
        meta: {
          ...result.meta,
          local: { status: "success", count: local.items.length },
          external: { status: "success", count: remote.length },
        },
      } satisfies SearchOutput
    }

    const searches = primary(query, plan)
    const first = await discover(query, plan, st, searches, extra)
    const fallback = allQueries(query, plan)
      .filter((item) => !searches.includes(item))
      .filter((item, idx, arr) => arr.indexOf(item) === idx)
      .slice(0, 3)
    const weak = first.items.length === 0 ||
      first.items.every((item) => {
        const next = role(query, plan, item)
        if (next === "direct" || next === "supporting") return false
        if (next === "meta" && plan.meta) return false
        return true
      })
    const second = weak && fallback.length > 0 ? await discover(query, plan, st, fallback, [...extra, ...searches]) : undefined
    const webSearches = [...searches, ...fallback].filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, 4)
    const found = fold([first.found, ...(second ? [second.found] : [])])
    const extraResults = [...first.items, ...(second?.items ?? [])]
    const needWeb = extraResults.length === 0 ||
      extraResults.every((item) => {
        const next = role(query, plan, item)
        if (next === "direct" || next === "supporting") return false
        return next !== "meta" || !plan.meta
      })
    const web = needWeb && webSearches.length > 0 ? await discoverWeb(query, plan, st, webSearches, [...extra, ...searches, ...fallback]) : undefined
    const merged = fold([first.found, ...(second ? [second.found] : []), ...(web ? [web.found] : [])])

    const all = [...local.items, ...remote, ...extraResults, ...(web?.items ?? [])]
    const order = new Set(merge(query, all))
    const coarse = all.toSorted((a, b) => [...order].indexOf(a.id) - [...order].indexOf(b.id))
    const picked = coarse.filter((item) => item.provider === "external" && !!item.url).slice(0, 12)
    const pages = [
      ...local.pages,
      ...(await Promise.all(
        picked.map(async (item) => ({
          item,
          page: await page(item.url ?? item.id, item.url),
        })),
      )),
    ]
    const result = await refine(query, plan, coarse, pages, current, start)
    return {
      ...result,
      meta: {
        ...result.meta,
        local: { status: "success", count: local.items.length },
        external: {
          status: merged.status,
          count: remote.length + extraResults.length + (web?.items.length ?? 0),
          message: merged.message,
        },
      },
    } satisfies SearchOutput
  }

  export async function bench(input: z.input<typeof BenchInput>, model?: SearchModel) {
    const start = Date.now()
    const params = BenchInput.parse(input)
    const current = await pick(model)
    const plan = await semantic(params.query, current)
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
    return refine(params.query, plan, coarse, pages, current, start)
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
