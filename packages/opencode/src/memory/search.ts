import type { MemoryBlock, MemoryDocument, MemoryType } from "./markdown"

export type MemorySearchInput = {
  query: string
  types?: MemoryType[]
  limit?: number
  currentProjectID?: string
}

export type MemorySearchResult = MemoryBlock & {
  score: number
  markdown: string
  ranking_note: string
}

const SPLIT_RE = /[\s,，;；、|/\\]+/g

export function splitSearchTerms(query: string) {
  return query
    .split(SPLIT_RE)
    .map((term) => term.trim())
    .filter(Boolean)
}

function normalizeEnglish(input: string) {
  return input.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
}

function hasCjk(input: string) {
  return /[\u3400-\u9fff]/.test(input)
}

function ngrams(input: string, size: number) {
  const chars = Array.from(input.replace(/\s/g, ""))
  const out = new Set<string>()
  for (let i = 0; i <= chars.length - size; i++) out.add(chars.slice(i, i + size).join(""))
  return out
}

function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0
  let hits = 0
  for (const item of a) if (b.has(item)) hits++
  return hits / Math.max(a.size, b.size)
}

function textScore(term: string, target: string) {
  const lowerTerm = normalizeEnglish(term)
  const lowerTarget = normalizeEnglish(target)
  let score = 0
  if (lowerTarget.includes(lowerTerm)) score = Math.max(score, 1)
  const tokens = lowerTarget.split(/\s+/).filter(Boolean)
  if (tokens.some((token) => token === lowerTerm)) score = Math.max(score, 1)
  if (tokens.some((token) => token.startsWith(lowerTerm))) score = Math.max(score, 0.75)

  if (hasCjk(term)) {
    if (target.includes(term)) score = Math.max(score, 1)
    score = Math.max(score, overlap(ngrams(term, 2), ngrams(target, 2)) * 0.85)
    score = Math.max(score, overlap(ngrams(term, 3), ngrams(target, 3)))
  }
  return score
}

function scopeRelevance(scope: string, currentProjectID?: string) {
  if (scope === "global") return 0.65
  if (currentProjectID && scope === `project:${currentProjectID}`) return 1
  return 0.2
}

function recencyScore(updatedAt: string) {
  const time = Date.parse(updatedAt)
  if (!Number.isFinite(time)) return 0.4
  const ageDays = Math.max(0, (Date.now() - time) / 86_400_000)
  return Math.max(0.1, 1 - ageDays / 365)
}

function renderSnippet(memory: MemoryBlock) {
  return [
    `### ${memory.id}`,
    `- type: ${memory.type}`,
    `- scope: ${memory.scope}`,
    `- memory: ${memory.memory}`,
    `- confidence: ${memory.confidence}`,
    `- weight: ${memory.weight}`,
    `- evidence: ${memory.evidence}`,
    `- updated_at: ${memory.updated_at}`,
    `- status: ${memory.status}`,
  ].join("\n")
}

export function searchMemoryDocument(doc: MemoryDocument, input: MemorySearchInput): MemorySearchResult[] {
  const limit = Math.max(0, input.limit ?? 5)
  if (limit <= 0) return []
  const terms = splitSearchTerms(input.query)
  if (!terms.length) return []
  const allowed = input.types ? new Set(input.types) : undefined
  const shortcutTargets = new Map<string, number>()
  for (const shortcut of doc.shortcuts) {
    const haystack = [shortcut.shortcut, ...shortcut.triggers, shortcut.instruction].join(" ")
    const matched = terms.some((term) => textScore(term, haystack) > 0)
    if (!matched) continue
    for (const id of shortcut.target_ids) shortcutTargets.set(id, Math.max(shortcutTargets.get(id) ?? 0, shortcut.weight || 0.8))
  }

  return doc.memories
    .filter((memory) => memory.status === "active")
    .filter((memory) => !allowed || allowed.has(memory.type))
    .map((memory) => {
      const haystack = [memory.id, memory.type, memory.scope, memory.memory, memory.evidence].join(" ")
      const match = Math.max(...terms.map((term) => textScore(term, haystack)), 0)
      const shortcut = shortcutTargets.get(memory.id) ?? 0
      const scope = scopeRelevance(memory.scope, input.currentProjectID)
      const recency = recencyScore(memory.updated_at)
      const score = match * 0.45 + shortcut * 0.25 + memory.weight * 0.2 + recency * 0.05 + scope * 0.05
      return {
        ...memory,
        matched: match > 0 || shortcut > 0,
        score,
        markdown: renderSnippet(memory),
        ranking_note: "结果按相关度、scope、权重和新近程度综合排序。",
      }
    })
    .filter((memory) => memory.matched)
    .filter((memory) => memory.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ matched, ...memory }) => memory)
}
