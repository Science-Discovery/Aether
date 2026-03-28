import { describe, expect, test } from "bun:test"
import { chatRanges } from "./chat-find"

describe("chatRanges", () => {
  test("finds repeated matches in message text", () => {
    const root = document.createElement("div")
    root.innerHTML = `<div>foo bar foo</div>`
    const hits = chatRanges(root, "foo")
    expect(hits).toHaveLength(2)
  })

  test("matches case-insensitively", () => {
    const root = document.createElement("div")
    root.innerHTML = `<div>Agent Output</div>`
    const hits = chatRanges(root, "output")
    expect(hits).toHaveLength(1)
  })

  test("skips editable nodes", () => {
    const root = document.createElement("div")
    root.innerHTML = `<input value="foo" /><div>foo</div>`
    const hits = chatRanges(root, "foo")
    expect(hits).toHaveLength(1)
  })

  test("skips ignored subtree", () => {
    const root = document.createElement("div")
    root.innerHTML = `<div data-chat-find-ignore>foo</div><div>foo</div>`
    const hits = chatRanges(root, "foo")
    expect(hits).toHaveLength(1)
  })
})
