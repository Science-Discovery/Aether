import { describe, expect, test } from "bun:test"
import {
  addReference,
  canAsk,
  clearReferences,
  cloneReferences,
  missingImages,
  referenceKey,
  restoreReferences,
  sanitizeReferences,
  updateReference,
  type Reference,
} from "./ask-reference"

const pdf = (id = "pdf"): Extract<Reference, { kind: "pdf" }> => ({
  id,
  version: 1,
  kind: "pdf",
  question: "解释这个结论\n给出例子",
  text: "Selected text",
  summary: "Selected text",
  path: "/papers/a.pdf",
  filename: "a.pdf",
  mode: "classic",
  sourceSession: "source",
  startPage: 2,
  endPage: 3,
  selection: "[[2,10,20],[3,20,30]]",
  content: "text",
  settings: { questionPrompt: "Explain {selectedText}", contextPageRange: 2 },
  totalPages: 10,
})

const conversation = (): Extract<Reference, { kind: "conversation" }> => ({
  id: "conversation",
  version: 1,
  kind: "conversation",
  question: "",
  text: "Selected text",
  summary: "Selected text",
  messageID: "message",
  start: 2,
  end: 15,
})

describe("Ask references", () => {
  test("keys identify positions independently of questions and source text", () => {
    const first = conversation()
    expect(referenceKey(first)).toBe(referenceKey({ ...first, id: "new", text: "changed", question: "Why?" }))
    expect(referenceKey(first)).not.toBe(referenceKey({ ...first, start: 3 }))
    const item = pdf()
    if (item.kind !== "pdf") throw new Error("expected PDF")
    expect(referenceKey(item)).not.toBe(referenceKey({ ...item, path: "/papers/b.pdf" }))
    expect(referenceKey(item)).not.toBe(referenceKey({ ...item, selection: "[[2,20,30]]" }))
  })

  test("reselecting a reference updates its content without reordering or changing its identity", () => {
    const first = pdf()
    const refs = [conversation(), first]
    const changed = addReference(refs, { ...first, id: "replacement", question: "New question" })
    expect(changed.map((ref) => ref.id)).toEqual(["conversation", "pdf"])
    expect(changed[1]?.version).toBe(2)
    expect(changed[1]?.question).toBe("New question")
    expect(refs[1]?.question).toBe("解释这个结论\n给出例子")
    expect(addReference(refs, { ...conversation(), id: "another", start: 20, end: 33 })).toHaveLength(3)
  })

  test("snapshots freeze nested PDF settings and clear only the versions that were sent", () => {
    const refs = [pdf(), conversation()]
    const snapshot = cloneReferences(refs)
    const first = snapshot[0]
    if (first?.kind !== "pdf") throw new Error("expected PDF")
    first.settings.contextPageRange = 0
    expect(refs[0]?.kind === "pdf" && refs[0].settings.contextPageRange).toBe(2)
    const edited = updateReference(refs, "pdf", "Edited while sending")
    const added = addReference(edited, { ...conversation(), id: "later", start: 30, end: 43 })
    const remaining = clearReferences(added, snapshot)
    expect(remaining.map((ref) => ref.id)).toEqual(["pdf", "later"])
    expect(remaining[0]?.question).toBe("Edited while sending")
    expect(clearReferences(refs, snapshot)).toEqual([])
  })

  test("restoring a draft creates new identities that an older pending send cannot clear", () => {
    const snapshot = [pdf(), conversation()]
    const restored = restoreReferences(snapshot)
    expect(restored.map(referenceKey)).toEqual(snapshot.map(referenceKey))
    expect(restored.map((ref) => ref.question)).toEqual(snapshot.map((ref) => ref.question))
    expect(restored.every((ref, index) => ref.id !== snapshot[index]?.id && ref.version === 1)).toBe(true)
    expect(clearReferences(restored, snapshot)).toEqual(restored)
    const first = restored[0]
    if (first?.kind !== "pdf") throw new Error("expected PDF")
    first.settings.questionPrompt = "New settings"
    expect(snapshot[0]?.kind === "pdf" && snapshot[0].settings.questionPrompt).toBe("Explain {selectedText}")
  })

  test("persistence retains image source and question but never image data or unknown fields", () => {
    const ref = pdf()
    if (ref.kind !== "pdf") throw new Error("expected PDF")
    const input = { ...ref, content: "image", image: "data:image/png;base64,secret", token: "private" }
    const output = sanitizeReferences([input, conversation()])
    expect(output).toHaveLength(2)
    expect(output[0]).toEqual({ ...ref, content: "image" })
    expect(missingImages(output)).toBe(true)
    expect(JSON.stringify(output)).not.toContain("secret")
    expect(JSON.stringify(output)).not.toContain("private")
    expect(input.image).toContain("secret")
    expect(output[0]?.question).toBe("解释这个结论\n给出例子")
  })

  test("persistence rejects malformed references and deduplicates repeated identities or positions", () => {
    const ref = pdf()
    expect(sanitizeReferences(null)).toEqual([])
    expect(sanitizeReferences([null, {}, { ...ref, version: Infinity }, { ...ref, startPage: 0 }])).toEqual([])
    expect(
      sanitizeReferences([
        { ...ref, settings: null },
        { ...conversation(), end: -1 },
      ]),
    ).toEqual([])
    expect(sanitizeReferences([ref, { ...ref, id: "duplicate" }, { ...conversation(), id: ref.id }])).toEqual([ref])
  })

  test("requires a question somewhere in the batch and detects missing image placeholders", () => {
    expect(canAsk("", [])).toBe(false)
    expect(canAsk(" \n ", [conversation()])).toBe(false)
    expect(canAsk("Compare these references", [conversation()])).toBe(true)
    expect(canAsk("", [conversation(), pdf()])).toBe(true)
    expect(missingImages([pdf(), conversation()])).toBe(false)
    const ref = pdf()
    if (ref.kind !== "pdf") throw new Error("expected PDF")
    expect(missingImages([{ ...ref, content: "image" }])).toBe(true)
    expect(missingImages([{ ...ref, content: "image", image: "data:image/png;base64,picture" }])).toBe(false)
  })
})
