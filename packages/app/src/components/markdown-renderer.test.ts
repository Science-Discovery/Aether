import { describe, expect, test } from "bun:test"

describe("markdown language extension", () => {
  test("getLanguageExtension is exported and returns markdown extension for .md files", async () => {
    const { getLanguageExtension } = await import("./code-editor")
    const ext = getLanguageExtension("test.md")
    expect(ext).not.toBeNull()
    expect(ext).not.toBeUndefined()
  })

  test("getLanguageExtension returns extension for .mdx files", async () => {
    const { getLanguageExtension } = await import("./code-editor")
    const ext = getLanguageExtension("doc.mdx")
    expect(ext).not.toBeNull()
  })

  test("getLanguageExtension returns extension for .markdown files", async () => {
    const { getLanguageExtension } = await import("./code-editor")
    const ext = getLanguageExtension("README.markdown")
    expect(ext).not.toBeNull()
  })

  test("getLanguageExtension returns null for unknown extensions", async () => {
    const { getLanguageExtension } = await import("./code-editor")
    const ext = getLanguageExtension("file.xyz")
    expect(ext).toBeNull()
  })

  test("getLanguageExtension returns extension for .py files", async () => {
    const { getLanguageExtension } = await import("./code-editor")
    const ext = getLanguageExtension("script.py")
    expect(ext).not.toBeNull()
  })

  test("getLanguageExtension returns extension for .ts files", async () => {
    const { getLanguageExtension } = await import("./code-editor")
    const ext = getLanguageExtension("index.ts")
    expect(ext).not.toBeNull()
  })

  test("getLanguageExtension returns extension for .json files", async () => {
    const { getLanguageExtension } = await import("./code-editor")
    const ext = getLanguageExtension("package.json")
    expect(ext).not.toBeNull()
  })
})
