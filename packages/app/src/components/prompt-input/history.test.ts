import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import type { Reference } from "@/utils/ask-reference"
import {
  canNavigateHistoryAtCursor,
  clonePromptParts,
  migratePromptHistory,
  normalizePromptHistoryEntry,
  navigatePromptHistory,
  prependHistoryEntry,
  promptLength,
  type PromptHistoryComment,
  type PromptHistoryStoredEntry,
} from "./history"

const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

const text = (value: string): Prompt => [{ type: "text", content: value, start: 0, end: value.length }]
const image = (id: string): Prompt[number] => ({
  type: "image",
  id,
  filename: `${id}.pdf`,
  mime: "application/pdf",
  dataUrl: `data:application/pdf;base64,${id}`,
})
const comment = (id: string, value = "note"): PromptHistoryComment => ({
  id,
  path: "src/a.ts",
  selection: { start: 2, end: 4 },
  comment: value,
  time: 1,
  origin: "review",
  preview: "const a = 1",
})
const reference = (): Extract<Reference, { kind: "pdf" }> => ({
  id: "ref",
  version: 2,
  kind: "pdf",
  question: "Why is this important?",
  text: "The finding",
  summary: "The finding",
  path: "/papers/paper.pdf",
  filename: "paper.pdf",
  mode: "classic",
  sourceSession: "source",
  startPage: 2,
  endPage: 3,
  selection: "pages:2,3",
  content: "text",
  settings: { questionPrompt: "Explain", contextPageRange: 1 },
})
const scope = { dir: "workspace", id: "session" }

describe("prompt-input history", () => {
  test("prependHistoryEntry skips empty prompt and deduplicates consecutive entries", () => {
    const first = prependHistoryEntry([], DEFAULT_PROMPT)
    expect(first).toEqual([])

    const commentsOnly = prependHistoryEntry([], DEFAULT_PROMPT, [comment("c1")])
    expect(commentsOnly).toHaveLength(1)

    const withOne = prependHistoryEntry([], text("hello"))
    expect(withOne).toHaveLength(1)

    const deduped = prependHistoryEntry(withOne, text("hello"))
    expect(deduped).toBe(withOne)

    const dedupedComments = prependHistoryEntry(commentsOnly, DEFAULT_PROMPT, [comment("c1")])
    expect(dedupedComments).toBe(commentsOnly)
  })

  test("prependHistoryEntry persists prompt content without attachments", () => {
    const entries = prependHistoryEntry([], [...text("summarize this"), image("large")])
    expect(entries).toHaveLength(1)
    expect(normalizePromptHistoryEntry(entries[0]!).prompt).toEqual(text("summarize this"))
    expect(JSON.stringify(entries)).not.toContain("data:application/pdf")

    expect(prependHistoryEntry([], [image("attachment-only")])).toEqual([])

    const deduped = prependHistoryEntry(entries, [...text("summarize this"), image("different")])
    expect(deduped).toBe(entries)
  })

  test("migratePromptHistory removes legacy attachments and drops attachment-only entries", () => {
    const migrated = migratePromptHistory({
      entries: [
        { prompt: [...text("keep me"), image("remove")], comments: [comment("c1")] },
        [image("drop")],
        { prompt: [image("commented")], comments: [comment("c2")] },
        { prompt: [...text("canonical"), null] },
      ],
    }) as { entries: PromptHistoryStoredEntry[] }

    expect(migrated.entries).toHaveLength(3)
    expect(normalizePromptHistoryEntry(migrated.entries[0]!).prompt).toEqual(text("keep me"))
    expect(normalizePromptHistoryEntry(migrated.entries[0]!).comments).toEqual([comment("c1")])
    expect(normalizePromptHistoryEntry(migrated.entries[1]!).prompt).toEqual(DEFAULT_PROMPT)
    expect(normalizePromptHistoryEntry(migrated.entries[1]!).comments).toEqual([comment("c2")])
    expect(normalizePromptHistoryEntry(migrated.entries[2]!).prompt).toEqual(text("canonical"))
    expect(normalizePromptHistoryEntry(migrated.entries[2]!).comments).toEqual([])
    expect(JSON.stringify(migrated)).not.toContain("data:application/pdf")
    expect(migratePromptHistory(null)).toEqual({ entries: [] })
    expect(migratePromptHistory({ entries: null })).toEqual({ entries: [] })
  })

  test("navigatePromptHistory restores saved prompt when moving down from newest", () => {
    const entries = [text("third"), text("second"), text("first")]
    const up = navigatePromptHistory({
      direction: "up",
      entries,
      historyIndex: -1,
      currentPrompt: [...text("draft"), image("draft")],
      currentComments: [comment("draft")],
      savedPrompt: null,
    })
    expect(up.handled).toBe(true)
    if (!up.handled) throw new Error("expected handled")
    expect(up.historyIndex).toBe(0)
    expect(up.cursor).toBe("start")
    expect(up.entry.comments).toEqual([])

    const down = navigatePromptHistory({
      direction: "down",
      entries,
      historyIndex: up.historyIndex,
      currentPrompt: text("ignored"),
      currentComments: [],
      savedPrompt: up.savedPrompt,
    })
    expect(down.handled).toBe(true)
    if (!down.handled) throw new Error("expected handled")
    expect(down.historyIndex).toBe(-1)
    expect(down.entry.prompt[0]?.type === "text" ? down.entry.prompt[0].content : "").toBe("draft")
    expect(down.entry.prompt[1]).toEqual(image("draft"))
    expect(down.entry.comments).toEqual([comment("draft")])
  })

  test("navigatePromptHistory keeps entry comments when moving through history", () => {
    const entries = [
      {
        prompt: text("with comment"),
        comments: [comment("c1")],
      },
    ]

    const up = navigatePromptHistory({
      direction: "up",
      entries,
      historyIndex: -1,
      currentPrompt: text("draft"),
      currentComments: [],
      savedPrompt: null,
    })

    expect(up.handled).toBe(true)
    if (!up.handled) throw new Error("expected handled")
    expect(up.entry.prompt[0]?.type === "text" ? up.entry.prompt[0].content : "").toBe("with comment")
    expect(up.entry.comments).toEqual([comment("c1")])
  })

  test("normalizePromptHistoryEntry supports legacy prompt arrays", () => {
    const entry = normalizePromptHistoryEntry(text("legacy"))
    expect(entry.prompt[0]?.type === "text" ? entry.prompt[0].content : "").toBe("legacy")
    expect(entry.comments).toEqual([])
  })

  test("helpers clone prompt and count text content length", () => {
    const original: Prompt = [
      { type: "text", content: "one", start: 0, end: 3 },
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 3,
        end: 12,
        selection: { startLine: 1, startChar: 1, endLine: 2, endChar: 1 },
      },
      { type: "image", id: "1", filename: "img.png", mime: "image/png", dataUrl: "data:image/png;base64,abc" },
    ]
    const copy = clonePromptParts(original)
    expect(copy).not.toBe(original)
    expect(promptLength(copy)).toBe(12)
    if (copy[1]?.type !== "file") throw new Error("expected file")
    copy[1].selection!.startLine = 9
    if (original[1]?.type !== "file") throw new Error("expected file")
    expect(original[1].selection?.startLine).toBe(1)
  })

  test("canNavigateHistoryAtCursor only allows prompt boundaries", () => {
    const value = "a\nb\nc"

    expect(canNavigateHistoryAtCursor("up", value, 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 0)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 2)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 2)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 5)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 5)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 3)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", "", 0)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "", 0)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1, true)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1, true)).toBe(false)
  })

  test("stores reference-only questions with their scope and deduplicates without depending on ID or version", () => {
    const ref = reference()
    const entries = prependHistoryEntry([], DEFAULT_PROMPT, [], undefined, [ref], scope)
    expect(entries).toHaveLength(1)
    const entry = normalizePromptHistoryEntry(entries[0]!)
    expect(entry.references).toEqual([ref])
    expect(entry.scope).toEqual(scope)
    expect(
      prependHistoryEntry(entries, DEFAULT_PROMPT, [], undefined, [{ ...ref, id: "new", version: 4 }], scope),
    ).toBe(entries)
    expect(
      prependHistoryEntry(entries, DEFAULT_PROMPT, [], undefined, [{ ...ref, question: "Another question" }], scope),
    ).toHaveLength(2)
    expect(prependHistoryEntry(entries, DEFAULT_PROMPT, [], undefined, [ref], { ...scope, id: "other" })).toHaveLength(
      2,
    )
  })

  test("restores source metadata only to the same scope and skips foreign reference-only entries", () => {
    const refs = [reference()]
    const entries = prependHistoryEntry([text("older")], DEFAULT_PROMPT, [], undefined, refs, scope)
    const input = {
      direction: "up" as const,
      entries,
      historyIndex: -1,
      currentPrompt: DEFAULT_PROMPT,
      currentComments: [],
      savedPrompt: null,
    }
    const same = navigatePromptHistory({ ...input, scope })
    if (!same.handled) throw new Error("expected history entry")
    expect(same.entry.references).toEqual(refs)
    const other = navigatePromptHistory({ ...input, scope: { ...scope, id: "other" } })
    if (!other.handled) throw new Error("expected older entry")
    expect(other.entry.prompt).toEqual(text("older"))
    expect(other.entry.references).toEqual([])
    const mixed = navigatePromptHistory({
      ...input,
      entries: prependHistoryEntry([], text("Explain these"), [], undefined, refs, scope),
      scope: { dir: "another", id: scope.id },
    })
    if (!mixed.handled) throw new Error("expected text entry")
    expect(mixed.entry.prompt).toEqual(text("Explain these"))
    expect(mixed.entry.references).toEqual([])
  })

  test("keeps live screenshot drafts when navigating back but omits their data from stored history", () => {
    const ref = { ...reference(), content: "image" as const, image: "data:image/png;base64,large" }
    const entries = prependHistoryEntry([], text("Previous"), [], undefined, [ref], scope)
    expect(JSON.stringify(entries)).not.toContain("base64")
    const up = navigatePromptHistory({
      direction: "up",
      entries,
      historyIndex: -1,
      currentPrompt: DEFAULT_PROMPT,
      currentComments: [],
      currentReferences: [ref],
      scope,
      savedPrompt: null,
    })
    if (!up.handled) throw new Error("expected history entry")
    expect(up.entry.references[0]).toEqual({ ...ref, image: undefined })
    ref.settings.contextPageRange = 2
    const down = navigatePromptHistory({
      direction: "down",
      entries,
      historyIndex: up.historyIndex,
      currentPrompt: DEFAULT_PROMPT,
      currentComments: [],
      scope,
      savedPrompt: up.savedPrompt,
    })
    if (!down.handled) throw new Error("expected draft")
    expect(down.entry.references[0]).toEqual({ ...ref, settings: { ...ref.settings, contextPageRange: 1 } })
    const other = navigatePromptHistory({
      direction: "down",
      entries,
      historyIndex: up.historyIndex,
      currentPrompt: DEFAULT_PROMPT,
      currentComments: [],
      scope: { ...scope, id: "other" },
      savedPrompt: up.savedPrompt,
    })
    if (!other.handled) throw new Error("expected draft")
    expect(other.entry.references).toEqual([])
  })

  test("migrates reference history without persisting screenshot data or losing source bindings", () => {
    const ref = { ...reference(), content: "image" as const, image: "data:image/png;base64,large" }
    const migrated = migratePromptHistory({
      entries: [{ prompt: DEFAULT_PROMPT, comments: [], references: [ref], scope }, text("legacy")],
    }) as { entries: PromptHistoryStoredEntry[] }
    expect(migrated.entries).toHaveLength(2)
    const entry = normalizePromptHistoryEntry(migrated.entries[0]!)
    expect(entry.scope).toEqual(scope)
    expect(entry.references).toEqual([{ ...ref, image: undefined }])
    expect(normalizePromptHistoryEntry(migrated.entries[1]!).references).toEqual([])
    expect(JSON.stringify(migrated)).not.toContain("base64")
  })
})
