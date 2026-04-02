import { describe, expect, test } from "bun:test"
import { fromList, isExternal, merge, send, type Batch } from "./upload"

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

  test("send keeps target separate from relative upload paths", async () => {
    const batch: Batch = {
      dirs: ["docs"],
      files: [
        { path: "docs/a.txt", file: new File(["a"], "a.txt") },
        { path: "readme.md", file: new File(["r"], "readme.md") },
      ],
    }
    let body: FormData | undefined
    const req = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        body = args[1]?.body as FormData
        return new Response(JSON.stringify({ ok: true, dirs: 1, created: 2, updated: 0, failed: [] }))
      },
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch
    await send({
      url: "http://localhost:3000",
      dir: "repo",
      target: "subdir",
      batch,
      fetch: req,
    })
    expect(body?.get("target")).toBe("subdir")
    expect(JSON.parse(body?.get("dirs") as string)).toEqual(["docs"])
    expect(JSON.parse(body?.get("paths") as string)).toEqual(["docs/a.txt", "readme.md"])
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
