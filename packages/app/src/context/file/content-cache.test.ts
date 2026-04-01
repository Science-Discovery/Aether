import { afterEach, describe, expect, test } from "bun:test"
import {
  buildEvictionKeepSet,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
} from "./content-cache"

describe("content-cache eviction with open files", () => {
  afterEach(() => {
    resetFileContentLru()
  })

  test("preserves all files in keep set when evicting", () => {
    // Fill the LRU beyond capacity (MAX_FILE_CONTENT_ENTRIES = 40)
    for (const i of Array.from({ length: 50 }, (_, n) => n)) {
      setFileContentBytes(`f-${i}`, 1)
    }
    expect(getFileContentEntryCount()).toBe(50)

    // Simulate: user has 3 files open in tabs
    const openFiles = new Set(["f-47", "f-48", "f-49"])

    // Track which files got evicted
    const evicted: string[] = []
    evictContentLru(openFiles, (path) => evicted.push(path))

    // All open files should still be tracked in the LRU
    for (const f of openFiles) {
      expect(hasFileContent(f)).toBe(true)
    }

    // The evicted files should NOT include any open file
    for (const evictedPath of evicted) {
      expect(openFiles.has(evictedPath)).toBe(false)
    }

    // Entry count should be at or below max
    expect(getFileContentEntryCount()).toBeLessThanOrEqual(40)
  })

  test("does not evict a file that is currently being edited", () => {
    // Fill to capacity
    for (const i of Array.from({ length: 40 }, (_, n) => n)) {
      setFileContentBytes(`f-${i}`, 1)
    }

    // Add one more file (the one being edited) - now we're at 41, over capacity
    setFileContentBytes("editing-file", 1)
    expect(getFileContentEntryCount()).toBe(41)

    // Evict while protecting the editing file
    const evicted: string[] = []
    evictContentLru(new Set(["editing-file"]), (path) => evicted.push(path))

    // The editing file must NOT be evicted
    expect(hasFileContent("editing-file")).toBe(true)
    expect(evicted).not.toContain("editing-file")

    // Something should have been evicted to get back to capacity
    expect(evicted.length).toBeGreaterThan(0)
    expect(getFileContentEntryCount()).toBeLessThanOrEqual(40)
  })

  test("evicts oldest files first, skipping keep set entries", () => {
    // Add files in order: a, b, c, d (well under capacity, but force eviction via bytes)
    const chunk = 6 * 1024 * 1024 // 6MB each, 4 = 24MB > 20MB limit
    setFileContentBytes("a", chunk)
    setFileContentBytes("b", chunk)
    setFileContentBytes("c", chunk)
    setFileContentBytes("d", chunk)

    // Protect "a" (oldest) and "b" (second oldest) -- simulating open tabs
    const keep = new Set(["a", "b"])
    const evicted: string[] = []
    evictContentLru(keep, (path) => evicted.push(path))

    // "a" and "b" must survive because they're in the keep set
    expect(hasFileContent("a")).toBe(true)
    expect(hasFileContent("b")).toBe(true)
    // "c" should be evicted (oldest unprotected)
    expect(evicted).toContain("c")
  })
})

describe("buildEvictionKeepSet", () => {
  test("includes loaded file path", () => {
    const result = buildEvictionKeepSet("src/main.ts", [])
    expect(result.has("src/main.ts")).toBe(true)
  })

  test("includes all open tab file paths", () => {
    const openTabs = [
      { tab: "file://src/a.ts", path: "src/a.ts" },
      { tab: "file://src/b.ts", path: "src/b.ts" },
      { tab: "file://src/c.ts", path: "src/c.ts" },
    ]
    const result = buildEvictionKeepSet("src/new.ts", openTabs)
    expect(result.has("src/new.ts")).toBe(true)
    expect(result.has("src/a.ts")).toBe(true)
    expect(result.has("src/b.ts")).toBe(true)
    expect(result.has("src/c.ts")).toBe(true)
  })

  test("deduplicates loaded file with open tab", () => {
    const openTabs = [{ tab: "file://src/main.ts", path: "src/main.ts" }]
    const result = buildEvictionKeepSet("src/main.ts", openTabs)
    expect(result.size).toBe(1)
    expect(result.has("src/main.ts")).toBe(true)
  })

  test("handles empty open tabs list", () => {
    const result = buildEvictionKeepSet("src/only.ts", [])
    expect(result.size).toBe(1)
    expect(result.has("src/only.ts")).toBe(true)
  })

  test("skips tabs with undefined path", () => {
    const openTabs = [
      { tab: "file://src/a.ts", path: "src/a.ts" },
      { tab: "context", path: undefined },
      { tab: "file://src/b.ts", path: "src/b.ts" },
    ]
    const result = buildEvictionKeepSet("src/new.ts", openTabs)
    expect(result.size).toBe(3) // new + a + b (no undefined entry)
    expect(result.has("src/new.ts")).toBe(true)
    expect(result.has("src/a.ts")).toBe(true)
    expect(result.has("src/b.ts")).toBe(true)
  })
})
