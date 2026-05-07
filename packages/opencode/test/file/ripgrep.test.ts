import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Ripgrep } from "../../src/file/ripgrep"

describe("file.ripgrep", () => {
  test("defaults to include hidden", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "visible.txt"), "hello")
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await Bun.write(path.join(dir, ".opencode", "thing.json"), "{}")
      },
    })

    const files = await Array.fromAsync(Ripgrep.files({ cwd: tmp.path }))
    const hasVisible = files.includes("visible.txt")
    const hasHidden = files.includes(path.join(".opencode", "thing.json"))
    expect(hasVisible).toBe(true)
    expect(hasHidden).toBe(true)
  })

  test("hidden false excludes hidden", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "visible.txt"), "hello")
        await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
        await Bun.write(path.join(dir, ".opencode", "thing.json"), "{}")
      },
    })

    const files = await Array.fromAsync(Ripgrep.files({ cwd: tmp.path, hidden: false }))
    const hasVisible = files.includes("visible.txt")
    const hasHidden = files.includes(path.join(".opencode", "thing.json"))
    expect(hasVisible).toBe(true)
    expect(hasHidden).toBe(false)
  })

  test("search returns empty when nothing matches", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "const value = 'other'\n")
      },
    })

    const hits = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "needle",
    })

    expect(hits).toEqual([])
  })

  test("search ignores binary matches", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "const note = 'te'\n")
        await Bun.write(path.join(dir, "match.bin"), new Uint8Array([0x74, 0x65, 0x00, 0x74, 0x65]))
      },
    })

    const hits = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "te",
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.path.text).toBe("match.ts")
    expect(hits[0]?.lines.text).toContain("te")
  })

  test("search supports fixed strings and case toggle", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "const note = 'Te.*st'\n")
      },
    })

    const exact = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "te.*st",
    })
    const strict = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "te.*st",
      case: true,
    })
    const regex = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "T.*st",
      case: true,
      regex: true,
    })

    expect(exact).toHaveLength(1)
    expect(strict).toEqual([])
    expect(regex).toHaveLength(1)
  })

  test("search supports include, exclude, and whole word", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "const cat = 'cat'\n")
        await Bun.write(path.join(dir, "match.md"), "cat catalog\n")
      },
    })

    const include = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "cat",
      include: ["*.ts"],
    })
    const exclude = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "cat",
      exclude: ["*.md"],
    })
    const word = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "cat",
      word: true,
    })

    expect(include.map((item) => item.path.text)).toEqual(["match.ts"])
    expect(exclude.map((item) => item.path.text)).toEqual(["match.ts"])
    expect(word).toHaveLength(2)
    expect(word.find((item) => item.path.text === "match.md")?.submatches).toHaveLength(1)
    expect(word.find((item) => item.path.text === "match.ts")?.submatches).toHaveLength(2)
    expect(word.flatMap((item) => item.submatches.map((part) => part.match.text))).toEqual(["cat", "cat", "cat"])
  })

  test("search returns empty when globs exclude every file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.txt"), "test\n")
      },
    })

    const hits = await Ripgrep.search({
      cwd: tmp.path,
      pattern: "test",
      include: ["*."],
    })

    expect(hits).toEqual([])
  })

  test("stream yields matches in batches", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "alpha\nbeta\nalpha\nbeta\n")
      },
    })

    const batches = await Array.fromAsync(
      Ripgrep.stream({
        cwd: tmp.path,
        pattern: "a",
        batch: 2,
      }),
    )

    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(2)
    expect(batches[1]).toHaveLength(2)
  })

  test("search aborts with signal", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const row = "needle " + "x".repeat(200) + "\n"
        await Bun.write(path.join(dir, "match.txt"), row.repeat(200_000))
      },
    })

    const ctl = new AbortController()
    const task = Ripgrep.search({
      cwd: tmp.path,
      pattern: "needle",
      regex: true,
      signal: ctl.signal,
    })
    ctl.abort()

    await expect(task).rejects.toMatchObject({ name: "AbortError" })
  })

  test("tree ignores .aether metadata directories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".aether"), { recursive: true })
        await Bun.write(path.join(dir, ".aether", "theme.json"), "{}")
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(path.join(dir, "src", "index.ts"), "export {}")
      },
    })

    const tree = await Ripgrep.tree({ cwd: tmp.path })
    expect(tree.includes(".aether")).toBe(false)
    expect(tree.includes("src")).toBe(true)
  })
})
