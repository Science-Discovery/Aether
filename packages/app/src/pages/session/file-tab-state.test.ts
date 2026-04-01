import { describe, expect, test } from "bun:test"
import { canRestoreEditor, editorValue } from "./file-tab-state"

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
})
