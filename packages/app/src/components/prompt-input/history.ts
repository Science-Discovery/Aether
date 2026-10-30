import type { Prompt, PromptScope } from "@/context/prompt"
import type { SelectedLineRange } from "@/context/file"
import { sanitizePrompt } from "@/context/prompt-persist"
import { cloneReferences, sanitizeReferences, type Reference } from "@/utils/ask-reference"

const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

export const MAX_HISTORY = 100

export type PromptHistoryComment = {
  id: string
  path: string
  selection: SelectedLineRange
  comment: string
  time: number
  origin?: "review" | "file"
  preview?: string
}

export type PromptHistoryEntry = {
  prompt: Prompt
  comments: PromptHistoryComment[]
  references: Reference[]
  scope?: PromptScope
}

export type PromptHistoryStoredEntry = Prompt | (Omit<PromptHistoryEntry, "references"> & { references?: Reference[] })

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function content(prompt: unknown[]) {
  return prompt.some((part) => record(part) && typeof part.content === "string" && !!part.content.trim())
}

function scope(value: unknown): PromptScope | undefined {
  if (!record(value) || typeof value.dir !== "string" || !value.dir) return
  if (value.id !== undefined && typeof value.id !== "string") return
  return { dir: value.dir, ...(typeof value.id === "string" ? { id: value.id } : {}) }
}

function scoped(a?: PromptScope, b?: PromptScope) {
  return !!a && !!b && a.dir === b.dir && a.id === b.id
}

function selection(value: unknown): SelectedLineRange | undefined {
  if (!record(value)) return
  if (typeof value.start !== "number" || typeof value.end !== "number") return
  const side = value.side === "additions" || value.side === "deletions" ? value.side : undefined
  const endSide = value.endSide === "additions" || value.endSide === "deletions" ? value.endSide : undefined
  return { start: value.start, end: value.end, ...(side ? { side } : {}), ...(endSide ? { endSide } : {}) }
}

function comments(value: unknown): PromptHistoryComment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((comment): PromptHistoryComment[] => {
    if (!record(comment)) return []
    if (typeof comment.id !== "string") return []
    if (typeof comment.path !== "string") return []
    if (typeof comment.comment !== "string") return []
    if (typeof comment.time !== "number") return []
    const range = selection(comment.selection)
    if (!range) return []
    const origin = comment.origin === "review" || comment.origin === "file" ? comment.origin : undefined
    return [
      {
        id: comment.id,
        path: comment.path,
        selection: range,
        comment: comment.comment,
        time: comment.time,
        ...(origin ? { origin } : {}),
        ...(typeof comment.preview === "string" ? { preview: comment.preview } : {}),
      },
    ]
  })
}

function clean(prompt: Prompt) {
  return sanitizePrompt(prompt)
}

export function migratePromptHistory(value: unknown) {
  if (!record(value)) return { entries: [] }
  if (!Array.isArray(value.entries)) return { ...value, entries: [] }

  const entries = value.entries.flatMap((entry) => {
    const legacy = Array.isArray(entry)
    const prompt = legacy ? entry : record(entry) && Array.isArray(entry.prompt) ? entry.prompt : undefined
    if (!prompt) return []

    const next = sanitizePrompt(prompt)
    const notes = !legacy && record(entry) ? comments(entry.comments) : []
    const refs = !legacy && record(entry) ? sanitizeReferences(entry.references) : []
    const target = !legacy && record(entry) ? scope(entry.scope) : undefined
    if (!content(next) && !notes.some((comment) => !!comment.comment.trim()) && !refs.length) return []

    return [
      {
        prompt: next.length ? next : clonePromptParts(DEFAULT_PROMPT),
        comments: notes,
        references: refs,
        ...(target ? { scope: target } : {}),
      } satisfies PromptHistoryEntry,
    ]
  })

  const unique = entries.filter((entry, index) => index === 0 || !isPromptEqual(entries[index - 1]!, entry))
  return { ...value, entries: unique.slice(0, MAX_HISTORY) }
}

export function canNavigateHistoryAtCursor(direction: "up" | "down", text: string, cursor: number, inHistory = false) {
  const position = Math.max(0, Math.min(cursor, text.length))
  const atStart = position === 0
  const atEnd = position === text.length
  if (inHistory) return atStart || atEnd
  if (direction === "up") return position === 0 && text.length === 0
  return position === text.length
}

export function clonePromptParts(prompt: Prompt): Prompt {
  return prompt.map((part) => {
    if (part.type === "text") return { ...part }
    if (part.type === "image") return { ...part }
    if (part.type === "agent") return { ...part }
    return {
      ...part,
      selection: part.selection ? { ...part.selection } : undefined,
    }
  })
}

function cloneSelection(selection: SelectedLineRange): SelectedLineRange {
  return {
    start: selection.start,
    end: selection.end,
    ...(selection.side ? { side: selection.side } : {}),
    ...(selection.endSide ? { endSide: selection.endSide } : {}),
  }
}

export function clonePromptHistoryComments(comments: PromptHistoryComment[]) {
  return comments.map((comment) => ({
    ...comment,
    selection: cloneSelection(comment.selection),
  }))
}

export function normalizePromptHistoryEntry(entry: PromptHistoryStoredEntry): PromptHistoryEntry {
  if (Array.isArray(entry)) {
    const prompt = clean(entry)
    return {
      prompt: prompt.length ? prompt : clonePromptParts(DEFAULT_PROMPT),
      comments: [],
      references: [],
    }
  }
  const prompt = clean(entry.prompt)
  return {
    prompt: prompt.length ? prompt : clonePromptParts(DEFAULT_PROMPT),
    comments: clonePromptHistoryComments(entry.comments),
    references: sanitizeReferences(entry.references),
    ...(entry.scope ? { scope: { ...entry.scope } } : {}),
  }
}

export function promptLength(prompt: Prompt) {
  return prompt.reduce((len, part) => len + ("content" in part ? part.content.length : 0), 0)
}

export function prependHistoryEntry(
  entries: PromptHistoryStoredEntry[],
  prompt: Prompt,
  comments: PromptHistoryComment[] = [],
  max = MAX_HISTORY,
  references: readonly Reference[] = [],
  scope?: PromptScope,
) {
  const stored = clean(prompt)
  const text = stored
    .map((part) => ("content" in part ? part.content : ""))
    .join("")
    .trim()
  const hasComments = comments.some((comment) => !!comment.comment.trim())
  const refs = sanitizeReferences(references)
  if (!text && !hasComments && !refs.length) return entries

  const entry = {
    prompt: stored.length ? stored : clonePromptParts(DEFAULT_PROMPT),
    comments: clonePromptHistoryComments(comments),
    references: refs,
    ...(scope ? { scope: { ...scope } } : {}),
  } satisfies PromptHistoryEntry
  const last = entries[0]
  if (last && isPromptEqual(last, entry)) return entries
  return [entry, ...entries].slice(0, max)
}

function isCommentEqual(commentA: PromptHistoryComment, commentB: PromptHistoryComment) {
  return (
    commentA.path === commentB.path &&
    commentA.comment === commentB.comment &&
    commentA.origin === commentB.origin &&
    commentA.preview === commentB.preview &&
    commentA.selection.start === commentB.selection.start &&
    commentA.selection.end === commentB.selection.end &&
    commentA.selection.side === commentB.selection.side &&
    commentA.selection.endSide === commentB.selection.endSide
  )
}

function isPromptEqual(promptA: PromptHistoryStoredEntry, promptB: PromptHistoryStoredEntry) {
  const entryA = normalizePromptHistoryEntry(promptA)
  const entryB = normalizePromptHistoryEntry(promptB)
  if (entryA.references.length !== entryB.references.length) return false
  if (entryA.references.length) {
    if (!scoped(entryA.scope, entryB.scope)) return false
    const refs = (entry: PromptHistoryEntry) =>
      JSON.stringify(entry.references.map((ref) => ({ ...ref, id: undefined, version: undefined })))
    if (refs(entryA) !== refs(entryB)) return false
  }
  if (entryA.prompt.length !== entryB.prompt.length) return false
  for (let i = 0; i < entryA.prompt.length; i++) {
    const partA = entryA.prompt[i]
    const partB = entryB.prompt[i]
    if (partA.type !== partB.type) return false
    if (partA.type === "text" && partA.content !== (partB.type === "text" ? partB.content : "")) return false
    if (partA.type === "file") {
      if (partA.path !== (partB.type === "file" ? partB.path : "")) return false
      const a = partA.selection
      const b = partB.type === "file" ? partB.selection : undefined
      const sameSelection =
        (!a && !b) ||
        (!!a &&
          !!b &&
          a.startLine === b.startLine &&
          a.startChar === b.startChar &&
          a.endLine === b.endLine &&
          a.endChar === b.endChar)
      if (!sameSelection) return false
    }
    if (partA.type === "agent" && partA.name !== (partB.type === "agent" ? partB.name : "")) return false
    if (partA.type === "image" && partA.id !== (partB.type === "image" ? partB.id : "")) return false
  }
  if (entryA.comments.length !== entryB.comments.length) return false
  for (let i = 0; i < entryA.comments.length; i++) {
    const commentA = entryA.comments[i]
    const commentB = entryB.comments[i]
    if (!commentA || !commentB || !isCommentEqual(commentA, commentB)) return false
  }
  return true
}

type HistoryNavInput = {
  direction: "up" | "down"
  entries: PromptHistoryStoredEntry[]
  historyIndex: number
  currentPrompt: Prompt
  currentComments: PromptHistoryComment[]
  currentReferences?: readonly Reference[]
  scope?: PromptScope
  savedPrompt: PromptHistoryEntry | null
}

type HistoryNavResult =
  | {
      handled: false
      historyIndex: number
      savedPrompt: PromptHistoryEntry | null
    }
  | {
      handled: true
      historyIndex: number
      savedPrompt: PromptHistoryEntry | null
      entry: PromptHistoryEntry
      cursor: "start" | "end"
    }

export function navigatePromptHistory(input: HistoryNavInput): HistoryNavResult {
  const entries = input.entries
    .map(normalizePromptHistoryEntry)
    .filter(
      (entry) =>
        !entry.references.length ||
        scoped(entry.scope, input.scope) ||
        content(entry.prompt) ||
        entry.comments.some((comment) => !!comment.comment.trim()),
    )
    .map((entry) => ({ ...entry, references: scoped(entry.scope, input.scope) ? entry.references : [] }))
  if (input.direction === "up") {
    if (entries.length === 0) {
      return {
        handled: false,
        historyIndex: input.historyIndex,
        savedPrompt: input.savedPrompt,
      }
    }

    if (input.historyIndex === -1) {
      const entry = entries[0]!
      return {
        handled: true,
        historyIndex: 0,
        savedPrompt: {
          prompt: clonePromptParts(input.currentPrompt),
          comments: clonePromptHistoryComments(input.currentComments),
          references: cloneReferences(input.currentReferences ?? []),
          ...(input.scope ? { scope: { ...input.scope } } : {}),
        },
        entry,
        cursor: "start",
      }
    }

    if (input.historyIndex < entries.length - 1) {
      const next = input.historyIndex + 1
      const entry = entries[next]!
      return {
        handled: true,
        historyIndex: next,
        savedPrompt: input.savedPrompt,
        entry,
        cursor: "start",
      }
    }

    return {
      handled: false,
      historyIndex: input.historyIndex,
      savedPrompt: input.savedPrompt,
    }
  }

  if (input.historyIndex > 0) {
    const next = input.historyIndex - 1
    const entry = entries[next]
    if (!entry) return { handled: false, historyIndex: input.historyIndex, savedPrompt: input.savedPrompt }
    return {
      handled: true,
      historyIndex: next,
      savedPrompt: input.savedPrompt,
      entry,
      cursor: "end",
    }
  }

  if (input.historyIndex === 0) {
    if (input.savedPrompt) {
      return {
        handled: true,
        historyIndex: -1,
        savedPrompt: null,
        entry: {
          ...input.savedPrompt,
          prompt: clonePromptParts(input.savedPrompt.prompt),
          comments: clonePromptHistoryComments(input.savedPrompt.comments),
          references: scoped(input.savedPrompt.scope, input.scope) ? cloneReferences(input.savedPrompt.references) : [],
        },
        cursor: "end",
      }
    }

    return {
      handled: true,
      historyIndex: -1,
      savedPrompt: null,
      entry: {
        prompt: DEFAULT_PROMPT,
        comments: [],
        references: [],
      },
      cursor: "end",
    }
  }

  return {
    handled: false,
    historyIndex: input.historyIndex,
    savedPrompt: input.savedPrompt,
  }
}
