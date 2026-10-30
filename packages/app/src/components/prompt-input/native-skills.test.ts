import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { sanitizePrompt } from "@/context/prompt-persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { buildRequestParts } from "./build-request-parts"
import { clonePromptParts, prependHistoryEntry } from "./history"

const prompt: Prompt = [
  { type: "skill", name: "research", path: "C:/tools/research/SKILL.md", content: "$research", start: 0, end: 9 },
  { type: "text", content: " summarize this", start: 9, end: 24 },
]
function build(parts = prompt, extra = false) {
  return buildRequestParts({
    prompt: parts,
    context: [],
    images: [],
    text: "$research summarize this",
    ...(extra ? { extraTextParts: [{ text: "A reading question" }] } : {}),
    sessionID: "session",
    messageID: "message",
    sessionDirectory: "/project",
  })
}

describe("Codex skill prompt identity", () => {
  test("persists, clones and restores explicit skill paths with the visible prompt", () => {
    expect(sanitizePrompt(prompt)).toEqual(prompt)
    expect(clonePromptParts(prompt)).toEqual(prompt)
    const parts = build().optimisticParts
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "text",
        ignored: true,
        metadata: {
          nativeSkill: {
            name: "research",
            path: "C:/tools/research/SKILL.md",
            source: { value: "$research", start: 0, end: 9 },
          },
        },
      }),
    )
    expect(extractPromptFromParts(parts)).toEqual(prompt)
  })
  test("same-name skills at different paths remain different history entries", () => {
    const other = prompt.map((part) => (part.type === "skill" ? { ...part, path: "/other/SKILL.md" } : part))
    expect(prependHistoryEntry(prependHistoryEntry([], prompt), other)).toHaveLength(2)
  })
  test("reading-context replacement keeps the explicit skill even when its text moved", () => {
    const parts = build(prompt, true).optimisticParts
    expect(extractPromptFromParts(parts).filter((part) => part.type === "skill")).toEqual([
      expect.objectContaining({ name: "research", path: "C:/tools/research/SKILL.md" }),
    ])
  })
  test("native histories without Aether source spans preserve skill paths", () => {
    const parts = build().optimisticParts.map((part) =>
      part.type === "text" && part.metadata?.nativeSkill
        ? { ...part, metadata: { nativeSkill: { name: "research", path: "C:/tools/research/SKILL.md" } } }
        : part,
    )
    expect(extractPromptFromParts(parts)).toEqual(prompt)
  })
  test("explicit native skills without a textual mention are restored as appended pills", () => {
    const parts = build().optimisticParts.map((part) =>
      part.type === "text" && !part.ignored ? { ...part, text: "Read this" } : part,
    )
    const restored = extractPromptFromParts(parts)
    expect(restored.filter((part) => part.type === "skill")).toEqual([
      expect.objectContaining({ name: "research", path: "C:/tools/research/SKILL.md" }),
    ])
    expect(restored[0]).toMatchObject({ content: "Read this" })
  })
  test("invalid saved source spans cannot discard native skill identities", () => {
    const parts = build().optimisticParts.map((part) =>
      part.type === "text" && part.metadata?.nativeSkill
        ? {
            ...part,
            metadata: {
              nativeSkill: {
                name: "research",
                path: "C:/tools/research/SKILL.md",
                source: { value: "$research", start: -1, end: 8 },
              },
            },
          }
        : part,
    )
    expect(extractPromptFromParts(parts)).toEqual(prompt)
  })
})
