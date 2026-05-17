import { describe, expect, test } from "bun:test"
import { checksum } from "@opencode-ai/util/encode"
import { canRestoreEditor, draftState, editorValue, wrapValue } from "./file-tab-state"

describe("file tab editor restore", () => {
  test("restores only after text content is ready", () => {
    expect(canRestoreEditor({ ready: false, loaded: false, text: true, editing: true })).toBe(false)
    expect(canRestoreEditor({ ready: true, loaded: false, text: true, editing: true })).toBe(false)
    expect(canRestoreEditor({ ready: true, loaded: true, text: false, editing: true })).toBe(false)
    expect(canRestoreEditor({ ready: true, loaded: true, text: true, editing: false })).toBe(false)
    expect(canRestoreEditor({ ready: true, loaded: true, text: true, editing: true })).toBe(true)
  })

  test("prefers saved draft over file content", () => {
    expect(editorValue({ draft: "draft body", content: "saved body" })).toBe("draft body")
    expect(editorValue({ content: "saved body" })).toBe("saved body")
  })

  test("defaults markdown files to wrapped source view", () => {
    expect(wrapValue({ markdown: true })).toBe(true)
    expect(wrapValue({ markdown: false })).toBe(false)
  })

  test("prefers saved wrap state over markdown default", () => {
    expect(wrapValue({ saved: false, markdown: true })).toBe(false)
    expect(wrapValue({ saved: true, markdown: false })).toBe(true)
  })

  test("treats persisted drafts without base as stale", () => {
    expect(
      draftState({
        ready: true,
        loaded: true,
        text: true,
        editing: true,
        draft: "draft body",
        content: "saved body",
      }),
    ).toBe("stale")
  })

  test("treats drafts with mismatched base as stale", () => {
    expect(
      draftState({
        ready: true,
        loaded: true,
        text: true,
        editing: true,
        draft: "draft body",
        draftBase: "old-base",
        content: "saved body",
      }),
    ).toBe("stale")
  })

  test("restores draft when base still matches current file", () => {
    expect(
      draftState({
        ready: true,
        loaded: true,
        text: true,
        editing: true,
        draft: "draft body",
        draftBase: checksum("saved body") ?? "",
        content: "saved body",
      }),
    ).toBe("fresh")
  })
})
