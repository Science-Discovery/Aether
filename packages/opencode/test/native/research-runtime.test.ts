import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Storage } from "../../src/knowledge/storage"
import { NativeSession } from "../../src/native/session"
import { NativeRuntime } from "../../src/native/runtime"
import { NativeResearch } from "../../src/native/research"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { getKnowledgeConfig, setKnowledgeConfig } from "../../src/tool/knowledge"
import { tmpdir } from "../fixture/fixture"

test("native JSONL research tools register only on start, execute real project lookups, and preserve selected knowledge on resume", async () => {
  await using dir = await tmpdir({ git: true })
  await using cfg = await tmpdir()
  await using kb = await tmpdir()
  const file = path.join(cfg.path, process.platform === "win32" ? "codex.cmd" : "codex")
  const fixture = path.join(import.meta.dir, "research-runtime-fixture.ts")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
  )
  if (process.platform !== "win32") await fs.chmod(file, 0o755)
  await Bun.write(
    path.join(cfg.path, "aether.integrations.jsonc"),
    JSON.stringify({ native: { codex: { path: file } } }),
  )
  const previous = Global.Path.config
  Global.Path.config = cfg.path
  Config.global.reset()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const root = await Session.create({ engine: { type: "codex", permission: "user" } })
        const corpus = await Session.create({ title: "Corpus evidence" })
        await Storage.init(kb.path, {
          id: "selected",
          name: "Selected",
          embeddingProvider: "local",
          embeddingModel: "fixture-never-loaded",
          embeddingDimensions: 2,
          chunkSize: 512,
          chunkOverlap: 0,
        })
        const prompt = async (text: string, extra: { noReply?: boolean; knowledgeBase?: { paths: string[] } } = {}) => {
          const result = await NativeSession.prompt(
            { sessionID: root.id, parts: [{ type: "text", text }], ...extra },
            await Session.get(root.id),
            new AbortController().signal,
          )
          if (!extra.noReply) {
            expect(result.info.role).toBe("assistant")
            expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
          }
          return result
        }
        try {
          await prompt("Selected reading context", { noReply: true, knowledgeBase: { paths: [kb.path] } })
          expect((await Session.get(root.id)).engine?.thread).toBeUndefined()
          await prompt("Use research tools")
          expect((await Session.get(root.id)).engine?.research).toBe(true)
          expect(getKnowledgeConfig(root.id)?.paths).toEqual([kb.path])
          await prompt("Extra queued context", { noReply: true })
          expect(getKnowledgeConfig(root.id)?.paths).toEqual([kb.path])
          await NativeRuntime.remove(root.id)
          await prompt("Resume and use tools again")
          expect(getKnowledgeConfig(root.id)?.paths).toEqual([kb.path])
          await prompt("Clear selected knowledge", { knowledgeBase: { paths: [] } })
          expect(getKnowledgeConfig(root.id)?.paths).toEqual([])
          const calls = (await Bun.file(path.join(dir.path, "research-calls.jsonl")).text())
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  id?: string | number
                  method?: string
                  params?: Record<string, unknown>
                  result?: { success?: boolean; contentItems?: { type: string; text: string }[] }
                },
            )
          const starts = calls.filter((call) => call.method === "thread/start")
          expect(starts).toHaveLength(1)
          expect(starts[0].params?.dynamicTools).toEqual(NativeResearch.tools)
          const resumes = calls.filter((call) => call.method === "thread/resume")
          expect(resumes).toHaveLength(1)
          expect(resumes[0].params).not.toHaveProperty("dynamicTools")
          expect(
            calls
              .filter((call) => call.method === "turn/start")
              .every((call) => !Object.hasOwn(call.params ?? {}, "dynamicTools")),
          ).toBe(true)
          const searches = calls.filter(
            (call) => typeof call.id === "string" && call.id.startsWith("aether_session_search-") && !call.method,
          )
          expect(searches).toHaveLength(3)
          for (const call of searches) {
            expect(call.result?.success).toBe(true)
            expect(JSON.parse(call.result!.contentItems![0].text).sessions).toContainEqual(
              expect.objectContaining({ id: corpus.id, title: "Corpus evidence" }),
            )
          }
          const knowledge = calls.filter(
            (call) => typeof call.id === "string" && call.id.startsWith("aether_knowledge_search-") && !call.method,
          )
          expect(knowledge.every((call) => call.result?.success)).toBe(true)
          expect(knowledge.map((call) => JSON.parse(call.result!.contentItems![0].text).configured)).toEqual([
            true,
            true,
            false,
          ])
        } finally {
          setKnowledgeConfig(null, root.id)
          await NativeRuntime.remove(root.id)
        }
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    Global.Path.config = previous
    Config.global.reset()
  }
}, 30_000)
