import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { ManagedMinerU } from "../../src/mineru/managed"
import { Instance } from "../../src/project/instance"
import { MineruConvertTool, MineruStartTool, MineruStatusTool, MineruToolTest } from "../../src/tool/mineru"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: SessionID.make("ses_mineru_tool"),
  messageID: MessageID.make("msg_mineru_tool"),
  callID: "call_mineru_tool",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

beforeEach(() => ManagedMinerU.Test.reset())
afterEach(async () => {
  await ManagedMinerU.Test.reset()
  await Instance.disposeAll()
})

describe("MinerU AI tools", () => {
  test("reports status but blocks start and conversion before managed setup is ready", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            experimental: { attachment_text_extraction: { mineru: { mode: "managed" } } },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const status = await MineruStatusTool.init()
        const start = await MineruStartTool.init()
        const convert = await MineruConvertTool.init()
        const result = await status.execute({}, ctx)
        expect(JSON.parse(result.output)).toMatchObject({
          configured: false,
          mode: "managed",
          ai_conversion_available: false,
        })
        await expect(start.execute({}, ctx)).rejects.toThrow("has not been configured")
        await expect(convert.execute({ input: "paper.pdf" }, ctx)).rejects.toThrow("has not been configured")
      },
    })
  })

  test("detects a custom service without contacting it and refuses AI file transfer", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "paper.pdf"), "%PDF")
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            experimental: {
              attachment_text_extraction: {
                mineru: { mode: "external", base_url: "https://mineru.example.invalid" },
              },
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const status = await MineruStatusTool.init()
        const convert = await MineruConvertTool.init()
        expect(JSON.parse((await status.execute({}, ctx)).output)).toMatchObject({
          configured: true,
          mode: "external",
          ai_conversion_available: false,
        })
        await expect(convert.execute({ input: "paper.pdf" }, ctx)).rejects.toThrow("cannot send files")
      },
    })
  })

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
})
