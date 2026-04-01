import { describe, expect, test } from "bun:test"
import { discardFileDiff } from "./review-discard"
import type { FileDiff } from "@opencode-ai/sdk/v2"

/**
 * Tests for the per-file discard logic used in the review panel.
 *
 * The discard action restores a file to its pre-AI state using the `before`
 * content from the FileDiff. For "added" files it deletes the file; for
 * "deleted" or "modified" files it writes the original content back.
 */

const diffs: FileDiff[] = [
  {
    file: "src/foo.ts",
    before: "original foo",
    after: "modified foo",
    additions: 1,
    deletions: 1,
    status: "modified",
  },
  {
    file: "src/bar.ts",
    before: "",
    after: "new file content",
    additions: 5,
    deletions: 0,
    status: "added",
  },
  {
    file: "src/baz.ts",
    before: "original baz content",
    after: "",
    additions: 0,
    deletions: 3,
    status: "deleted",
  },
]

describe("discardFileDiff", () => {
  test("discards a modified file (write action with before content)", () => {
    const result = discardFileDiff(diffs, "src/foo.ts")
    expect(result.action).toBe("write")
    expect(result.content).toBe("original foo")
    expect(result.remaining).toHaveLength(2)
    expect(result.remaining.map((d) => d.file)).not.toContain("src/foo.ts")
  })

  test("discards an added file (delete action)", () => {
    const result = discardFileDiff(diffs, "src/bar.ts")
    expect(result.action).toBe("delete")
    expect(result.content).toBeUndefined()
    expect(result.remaining).toHaveLength(2)
    expect(result.remaining.map((d) => d.file)).not.toContain("src/bar.ts")
  })

  test("discards a deleted file (write action with before content)", () => {
    const result = discardFileDiff(diffs, "src/baz.ts")
    expect(result.action).toBe("write")
    expect(result.content).toBe("original baz content")
    expect(result.remaining).toHaveLength(2)
    expect(result.remaining.map((d) => d.file)).not.toContain("src/baz.ts")
  })

  test("returns none when file path does not exist in diffs", () => {
    const result = discardFileDiff(diffs, "src/nonexistent.ts")
    expect(result.action).toBe("none")
    expect(result.remaining).toHaveLength(3)
  })

  test("handles empty diffs array", () => {
    const result = discardFileDiff([], "src/foo.ts")
    expect(result.action).toBe("none")
    expect(result.remaining).toHaveLength(0)
  })

  test("treats file with empty before as added (delete action)", () => {
    const noStatusDiffs: FileDiff[] = [
      {
        file: "new.ts",
        before: "",
        after: "content",
        additions: 1,
        deletions: 0,
      },
    ]
    const result = discardFileDiff(noStatusDiffs, "new.ts")
    expect(result.action).toBe("delete")
  })
})
