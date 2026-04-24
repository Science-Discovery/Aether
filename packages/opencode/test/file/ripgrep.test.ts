import { describe, expect, test, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Readable } from "stream"
import { tmpdir } from "../fixture/fixture"
import { Ripgrep } from "../../src/file/ripgrep"
import * as ProcessModule from "../../src/util/process"

describe("file.ripgrep", () => {
  test("files tolerates clean-exit premature-close stream errors", async () => {
    await Ripgrep.filepath()
    const spawnSpy = spyOn(ProcessModule.Process, "spawn").mockImplementation(() => {
      const stdout = Readable.from(
        (async function* () {
          yield "one.txt\ntwo.txt\n"
          throw Object.assign(new Error("premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" })
        })(),
      )
      return {
        stdout,
        exited: Promise.resolve(0),
      } as any
    })

    try {
      const files = await Array.fromAsync(Ripgrep.files({ cwd: process.cwd() }))
      expect(files).toEqual(["one.txt", "two.txt"])
    } finally {
      spawnSpy.mockRestore()
    }
  })

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
