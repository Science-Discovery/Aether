import { describe, expect, test } from "bun:test"

describe("electron preload api", () => {
  test("does not expose native markdown parsing", async () => {
    const api = await Bun.file(new URL("./index.ts", import.meta.url)).text()
    const type = await Bun.file(new URL("./types.ts", import.meta.url)).text()

    expect(api).not.toContain("parseMarkdownCommand")
    expect(api).not.toContain("parse-markdown")
    expect(type).not.toContain("parseMarkdownCommand")
  })
})
