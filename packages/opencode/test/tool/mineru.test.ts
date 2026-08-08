import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { MineruToolTest } from "../../src/tool/mineru"
import { MineruSetupTool } from "../../src/tool/mineru-setup"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("MinerU AI tools", () => {
  test("limits input and output to workspace files and never overwrites Markdown", async () => {
    await using outer = await tmpdir({ init: async (dir) => Bun.write(path.join(dir, "outside.pdf"), "%PDF") })
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "paper.pdf"), "%PDF")
        await Bun.write(path.join(dir, "notes.txt"), "text")
        await Bun.write(path.join(dir, "paper.mineru.md"), "existing")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await MineruToolTest.source("paper.pdf")).mime).toBe("application/pdf")
        await expect(MineruToolTest.source("notes.txt")).rejects.toThrow("only PDF and image")
        await expect(MineruToolTest.source(path.join(outer.path, "outside.pdf"))).rejects.toThrow("current workspace")
        expect(await MineruToolTest.target(undefined, path.join(tmp.path, "paper.pdf"))).toBe(
          path.join(tmp.path, "paper.mineru-2.md"),
        )
        await expect(MineruToolTest.target("paper.mineru.md", path.join(tmp.path, "paper.pdf"))).rejects.toThrow(
          "already exists",
        )
      },
    })
  })

  test("keeps MinerU tools out of ordinary conversations until managed extraction is enabled", () => {
    const tools = (input: unknown) => ToolRegistry.Test.mineru(Config.Info.parse(input), true).map((item) => item.id)

    expect(tools({})).toEqual([])
    expect(
      tools({ experimental: { attachment_text_extraction: { enabled: false, mineru: { mode: "managed" } } } }),
    ).toEqual([])
    expect(
      tools({ experimental: { attachment_text_extraction: { enabled: true, mineru: { mode: "external" } } } }),
    ).toEqual([])
    expect(
      tools({ experimental: { attachment_text_extraction: { enabled: true, mineru: { mode: "managed" } } } }),
    ).toEqual(["mineru_status", "mineru_start", "mineru_convert"])
  })

  test("deduplicates MinerU setup registration for its configuration conversation", () => {
    const id = "ses_mineru_setup"
    ToolRegistry.registerForSession(id, MineruSetupTool)
    ToolRegistry.registerForSession(id, MineruSetupTool)
    expect(ToolRegistry.getSessionTools(id).map((item) => item.id)).toEqual(["mineru_setup"])
    ToolRegistry.unregisterSession(id)
    expect(ToolRegistry.getSessionTools(id)).toEqual([])
  })
})
