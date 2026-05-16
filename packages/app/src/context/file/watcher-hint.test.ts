import { describe, expect, test } from "bun:test"
import { buildWatcherHint, watcherHintKey } from "./watcher-hint"

describe("watcher hint", () => {
  test("derives sorted unique files from file tabs and ignores non-file tabs", () => {
    const result = buildWatcherHint({
      tabs: ["context", "file://src/b.ts", "file://src/a.ts", "review", "file://src/a.ts"],
      expanded: ["docs", "src", "docs", ""],
      pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
    })

    expect(result).toEqual({
      files: ["src/a.ts", "src/b.ts"],
      dirs: ["docs", "src"],
    })
  })

  test("produces a stable dedupe key", () => {
    const a = watcherHintKey({
      directory: "/tmp/app",
      files: ["src/a.ts", "src/b.ts"],
      dirs: ["docs", "src"],
    })
    const b = watcherHintKey({
      directory: "/tmp/app",
      files: ["src/a.ts", "src/b.ts"],
      dirs: ["docs", "src"],
    })

    expect(a).toBe(b)
  })
})
