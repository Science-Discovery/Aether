import { describe, expect, test } from "bun:test"
import { fromList, isExternal, merge, withTarget, type Batch } from "./upload"

const withPath = (file: File, path: string) => {
  Object.defineProperty(file, "webkitRelativePath", {
    value: path,
    configurable: true,
  })
  return file as File & { webkitRelativePath: string }
}

describe("session upload helpers", () => {
  test("fromList keeps folder structure from picker input", () => {
    const a = withPath(new File(["a"], "a.txt"), "docs/a.txt")
    const b = withPath(new File(["b"], "b.txt"), "docs/nested/b.txt")
    const out = fromList([a, b])

    expect(out.dirs).toEqual([])
    expect(out.files.map((item) => item.path)).toEqual(["docs/a.txt", "docs/nested/b.txt"])
  })

  test("fromList ignores invalid traversal paths", () => {
    const good = withPath(new File(["ok"], "ok.txt"), "safe/ok.txt")
    const bad = withPath(new File(["bad"], "bad.txt"), "../bad.txt")
    const out = fromList([good, bad])

    expect(out.files.map((item) => item.path)).toEqual(["safe/ok.txt"])
  })

  test("isExternal checks native file drags", () => {
    expect(isExternal({ types: ["Files"] } as unknown as DataTransfer)).toBe(true)
    expect(isExternal({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false)
    expect(isExternal(null)).toBe(false)
  })

  test("merge deduplicates files by path", () => {
    const a: Batch = { dirs: ["src"], files: [{ path: "a.txt", file: new File(["a"], "a.txt") }] }
    const b: Batch = { dirs: ["lib"], files: [{ path: "a.txt", file: new File(["a2"], "a.txt") }] }
    const out = merge(a, b)
    expect(out.files.length).toBe(1)
    expect(out.dirs).toEqual(["src", "lib"])
  })

  test("withTarget rewrites batch paths under a directory", () => {
    const batch: Batch = {
      dirs: ["docs"],
      files: [
        { path: "docs/a.txt", file: new File(["a"], "a.txt") },
        { path: "readme.md", file: new File(["r"], "readme.md") },
      ],
    }
    const out = withTarget(batch, "subdir")
    expect(out.files.map((f) => f.path)).toEqual(["subdir/docs/a.txt", "subdir/readme.md"])
    expect(out.dirs).toEqual(["subdir/docs"])
  })

  test("withTarget with empty target returns batch unchanged", () => {
    const batch: Batch = {
      dirs: ["docs"],
      files: [{ path: "docs/a.txt", file: new File(["a"], "a.txt") }],
    }
    const out = withTarget(batch, "")
    expect(out.files.map((f) => f.path)).toEqual(["docs/a.txt"])
    expect(out.dirs).toEqual(["docs"])
  })

  test("batch size tracks total files and dirs", () => {
    const batch: Batch = {
      dirs: ["src", "lib"],
      files: [
        { path: "a.txt", file: new File(["a"], "a.txt") },
        { path: "b.txt", file: new File(["b"], "b.txt") },
      ],
    }
    expect(batch.files.length).toBe(2)
    expect(batch.dirs.length).toBe(2)
  })
})
