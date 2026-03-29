import { describe, expect, test } from "bun:test"
import { fromList, isExternal } from "./upload"

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
})
