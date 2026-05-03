import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory"
import { Session } from "../../src/session"
import { Filesystem } from "../../src/util/filesystem"
import type { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import {
  assertNotMemoryStoragePath,
  isMemoryStoragePath,
  memoryStorageRoot,
  memoryStorageExcludeGlobs,
} from "../../src/tool/memory-file-guard"
import path from "path"
import { ReadTool } from "../../src/tool/read"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { BashTool } from "../../src/tool/bash"
import { MemoryListTool, MemoryReadTool, MemorySearchTool } from "../../src/tool/memory"

function todayKey() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}

function toolContext(input: { userText?: string } = {}) {
  return {
    sessionID: "ses_memory_guard",
    messageID: "msg_memory_guard",
    callID: "call_memory_guard",
    abort: new AbortController().signal,
    extra: {},
    agent: "build",
    messages: input.userText
      ? [
          {
            info: { id: "msg_user_memory_guard", sessionID: "ses_memory_guard", role: "user" },
            parts: [
              {
                id: "part_user_memory_guard",
                sessionID: "ses_memory_guard",
                messageID: "msg_user_memory_guard",
                type: "text",
                text: input.userText,
              },
            ],
          },
        ]
      : [],
    metadata: async () => undefined,
    ask: async () => undefined,
  } as any
}

describe("memory + user profile backend", () => {
  test("generic file tools are guarded from Aether memory storage", async () => {
    const memoryFile = path.join(Global.Path.data, "memory", "user", "USER.md")
    expect(isMemoryStoragePath(memoryFile)).toBe(true)
    expect(() => assertNotMemoryStoragePath("read", memoryFile)).toThrow("Use memory_search")
    expect(memoryStorageExcludeGlobs(Global.Path.data)).toContain("!memory/**")

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect((await ReadTool.init()).execute({ filePath: memoryFile }, toolContext())).rejects.toThrow(
          "Use memory_search",
        )
        await expect(
          (await GlobTool.init()).execute({ pattern: "**/MEMORY.md", path: memoryStorageRoot() }, toolContext()),
        ).rejects.toThrow("Use memory_search")
        await expect(
          (await GrepTool.init()).execute({ pattern: "anything", path: memoryStorageRoot() }, toolContext()),
        ).rejects.toThrow("Use memory_search")
        await expect(
          (await BashTool.init()).execute({ command: `stat "${memoryFile}"`, description: "Stats memory file" }, toolContext()),
        ).rejects.toThrow("Use memory_search")
        await expect(
          (await BashTool.init()).execute(
            { command: "find ~/.local/share/aether -name '*.md'", description: "Find Aether markdown" },
            toolContext(),
          ),
        ).rejects.toThrow("Use memory_search")
      },
    })
  })

  test("memory listing tools are gated to explicit management requests", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await MemoryListTool.init()
        const recall = await tool.execute({}, toolContext({ userText: "What do I remember about cron?" }))
        expect(recall.metadata.blocked).toBe(true)
        expect(recall.output).toContain("Use memory_search")

        const management = await tool.execute({}, toolContext({ userText: "Please list all memory entries." }))
        expect(management.title).toBe("Memory stores")

        const readTool = await MemoryReadTool.init()
        const blockedRead = await readTool.execute(
          { store: "memory" },
          toolContext({ userText: "Do I remember anything about cron?" }),
        )
        expect(blockedRead.metadata.blocked).toBe(true)
        const allowedRead = await readTool.execute(
          { store: "memory" },
          toolContext({ userText: "Please display the memory store." }),
        )
        expect(allowedRead.title).toBe("Memory store")
      },
    })
  })

  test("current_scope reflection ignores short-term memory from other projects", async () => {
    await using left = await tmpdir()
    await using right = await tmpdir()

    await Instance.provide({
      directory: left.path,
      fn: async () => {
        const session = await Session.create({ title: "Left memory source" })
        const written = await Memory.write({
          session_id: session.id,
          store: "memory",
          action: "add",
          value: "Left-only short-term memory should not be reflected from right project.",
          reason: "manual",
        })
        expect(written.ok).toBe(true)
      },
    })

    await Instance.provide({
      directory: right.path,
      fn: async () => {
        const result = await Memory.reflect({ scope: "current_scope", dry_run: true })
        expect(result.status).toBe("skipped")
        expect(result.summary).toBe("No short-term memory files to reflect")
      },
    })
  })

  test("memory_write records natural-language notes in short-term session memory", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "short_term_profile_note"
        const ok = await Memory.write({
          session_id: sessionID,
          store: "user",
          action: "add",
          value: "用户希望长期记住：默认用中文回答，先结论后展开。",
          reason: "manual",
        })
        expect(ok.ok).toBe(true)
        if (!ok.ok) throw new Error("expected memory write to succeed")
        expect(ok.session.entries).toContain("用户希望长期记住：默认用中文回答，先结论后展开。")

        const prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(prompt.prompt).toContain("用户希望长期记住：默认用中文回答，先结论后展开。")
      },
    })
  })

  test("durable-looking USER writes are immediately searchable from another session before reflection", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const written = await Memory.write({
          session_id: "inbox_source_session",
          store: "user",
          action: "add",
          value: "用户希望长期记住：默认称呼她为 Alice。",
          reason: "manual",
        })
        expect(written.ok).toBe(true)

        await Memory.start({ session_id: "inbox_other_session" })
        const hits = await Memory.search({ session_id: "inbox_other_session", query: "Alice" })
        expect(hits.some((hit) => hit.text.includes("Alice"))).toBe(true)
      },
    })
  })

  test("replace and remove update pending inbox entries before reflection", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Memory.write({
          session_id: "inbox_edit_source",
          store: "user",
          action: "add",
          value: "用户希望长期记住：inbox-edit-old-marker",
          reason: "manual",
        })
        await Memory.write({
          session_id: "inbox_edit_source",
          store: "user",
          action: "replace",
          index: 1,
          value: "用户希望长期记住：inbox-edit-new-marker",
          reason: "manual",
        })

        await Memory.start({ session_id: "inbox_edit_other_after_replace" })
        const oldAfterReplace = await Memory.search({
          session_id: "inbox_edit_other_after_replace",
          query: "inbox-edit-old-marker",
        })
        const newAfterReplace = await Memory.search({
          session_id: "inbox_edit_other_after_replace",
          query: "inbox-edit-new-marker",
        })
        expect(oldAfterReplace).toEqual([])
        expect(newAfterReplace.some((hit) => hit.text.includes("inbox-edit-new-marker"))).toBe(true)

        await Memory.write({
          session_id: "inbox_edit_source",
          store: "user",
          action: "remove",
          index: 1,
          reason: "manual",
        })

        await Memory.start({ session_id: "inbox_edit_other_after_remove" })
        const newAfterRemove = await Memory.search({
          session_id: "inbox_edit_other_after_remove",
          query: "inbox-edit-new-marker",
        })
        expect(newAfterRemove).toEqual([])
      },
    })
  })

  test("concurrent durable-looking writes keep all mirrored inbox entries", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const total = 24
        await Promise.all(
          Array.from({ length: total }, (_, index) =>
            Memory.write({
              session_id: "concurrent_inbox_source",
              store: "user",
              action: "add",
              value: `用户希望长期记住：concurrent-inbox-marker-${index}`,
              reason: "manual",
            }),
          ),
        )

        const stores = await Memory.list()
        const hits = stores.inbox.entries.filter((entry) => entry.includes("concurrent-inbox-marker-"))
        expect(hits).toHaveLength(total)
        for (let i = 0; i < total; i++) {
          expect(hits.some((entry) => entry.includes(`concurrent-inbox-marker-${i}`))).toBe(true)
        }
      },
    })
  })

  test("scoped USER entries are visible only in matching project memory pools", async () => {
    await using left = await tmpdir({ git: true })
    await using right = await tmpdir({ git: true })

    let leftProjectScope = ""
    let userFile = ""

    try {
      await Instance.provide({
        directory: left.path,
        fn: async () => {
          leftProjectScope = `project-${Instance.project.id}`
          userFile = (await Memory.read("user")).file
          await Filesystem.write(
            userFile,
            [
              "# USER",
              "- preference[explicit]: global-visible-marker should be visible everywhere.",
              `- preference[explicit]: scope(${leftProjectScope}): project-scoped-marker should only appear on the left project.`,
            ].join("\n"),
          )

          await Memory.start({ session_id: "left_scoped_session" })
          const scopedHits = await Memory.search({ session_id: "left_scoped_session", query: "project-scoped-marker" })
          expect(scopedHits.some((hit) => hit.text.includes("project-scoped-marker"))).toBe(true)
        },
      })

      await Instance.provide({
        directory: right.path,
        fn: async () => {
          expect(`project-${Instance.project.id}`).not.toBe(leftProjectScope)
          await Memory.start({ session_id: "right_scoped_session" })
          const globalHits = await Memory.search({ session_id: "right_scoped_session", query: "global-visible-marker" })
          expect(globalHits.some((hit) => hit.text.includes("global-visible-marker"))).toBe(true)

          const scopedHits = await Memory.search({ session_id: "right_scoped_session", query: "project-scoped-marker" })
          expect(scopedHits).toEqual([])
        },
      })
    } finally {
      if (userFile) await Filesystem.write(userFile, "# USER\n")
    }
  })

  test("disables memory stores and writes when memory.enabled=false", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: false,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userStore = await Memory.read("user")
        expect(userStore.enabled).toBe(false)
        expect(userStore.entries).toEqual([])

        await Memory.start({ session_id: "disabled_old_active" })
        const activeBefore = await Memory.activePrompt({ session_id: "disabled_old_active" })
        expect(activeBefore.prompt).toBe("")

        const blocked = await Memory.write({
          session_id: "user_disabled",
          store: "user",
          action: "add",
          value: "preference[explicit]: 中文",
          reason: "manual",
        })
        expect(blocked.ok).toBe(false)
        expect(blocked.events[0]?.reason).toBe("memory_disabled")

        const memoryWrite = await Memory.write({
          session_id: "memory_still_on",
          store: "memory",
          action: "add",
          value: "Run tests from packages/opencode.",
          reason: "manual",
        })
        expect(memoryWrite.ok).toBe(false)

        await Memory.start({ session_id: "snapshot_user_off" })
        const prompt = await Memory.activePrompt({ session_id: "snapshot_user_off" })
        expect(prompt.prompt).toBe("")
      },
    })
  })

  test("direct USER writes accept natural-language paragraphs as short-term notes", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await Memory.write({
          session_id: "direct_user_no_synthesis",
          store: "user",
          action: "add",
          value: "默认用中文回答，先给结论再展开。开始改动前先和我逐项确认设计细节。对于统计物理相关内容，我更需要物理直觉和图像化解释。",
          reason: "manual",
        })

        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error("expected memory write to succeed")
        expect(result.session.entries[0]).toContain("默认用中文回答")
      },
    })
  })

  test("applies short-term item limits without writing durable stores directly", async () => {
    await using tmp = await tmpdir({
      git: true,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const longUser = await Memory.write({
          session_id: "long_user",
          store: "user",
          action: "add",
          value: `preference[explicit]: ${"a".repeat(500)}`,
          reason: "manual",
        })
        expect(longUser.ok).toBe(true)
        if (!longUser.ok) throw new Error("expected user write to succeed")
        expect(longUser.session.entries[0]!.length).toBeLessThanOrEqual(2000)
        const userStore = await Memory.read("user")
        expect(userStore.entries).toEqual([])

        const longMemory = await Memory.write({
          session_id: "long_memory",
          store: "memory",
          action: "add",
          value: `memory line ${"b".repeat(500)}`,
          reason: "manual",
        })
        expect(longMemory.ok).toBe(true)
        if (!longMemory.ok) throw new Error("expected memory write to succeed")
        expect(longMemory.session.entries[0]!.length).toBeLessThanOrEqual(2000)
        const memoryStoreAfterLong = await Memory.read("memory")
        expect(memoryStoreAfterLong.entries).toEqual([])
      },
    })
  })

  test("startup only prepares the session memory pool and does not mutate USER.md", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          ["# USER", "- 用户偏好中文回答", "- fact[explicit]: 先结论后展开"].join(
            "\n",
          ),
        )

        await Memory.start({ session_id: "startup_reflect" })
        const events = Memory.flush("startup_reflect")
        expect(events.length).toBe(0)

        const userStore = await Memory.read("user")
        expect(userStore.entries).toEqual(["fact[explicit]: 先结论后展开"])
        expect(userStore.invalid_entries ?? 0).toBe(1)
      },
    })
  })

  test("explicit reflection skips without short-term session memory", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(userFile, ["# USER", "- 用户偏好中文回答"].join("\n"))

        const result = await Memory.reflect({
          session_id: "explicit_reflect_when_disabled",
          scope: "current_session",
        })

        expect(result.status).toBe("skipped")
        expect(result.events.length).toBe(0)

        const userStore = await Memory.read("user")
        expect(userStore.entries).toEqual([])
        expect(userStore.invalid_entries ?? 0).toBe(1)
      },
    })
  })

  test("memory_reflect builds object generation input with messages for provider compatibility", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "reflect compatibility" })
        const written = await Memory.write({
          session_id: session.id,
          store: "memory",
          action: "add",
          value: "User explicitly prefers Chinese replies.",
          reason: "manual",
        })
        expect(written.ok).toBe(true)

        let captured: Record<string, unknown> | undefined
        Memory.setReflectionObjectGeneratorForTest(async (params) => {
          captured = params as Record<string, unknown>
          return {
            object: {
              daily_memory: [],
              user_patches: [],
              summary: "ok",
            },
          }
        })

        try {
          const result = await Memory.reflect({
            session_id: session.id,
            scope: "current_session",
            dry_run: true,
          })
          if (result.status !== "success") {
            throw new Error(`memory_reflect failed in test: ${result.summary}`)
          }
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        expect(captured).toBeDefined()
        expect(Array.isArray(captured?.messages)).toBe(true)
        expect(captured?.system).toBeUndefined()
        expect(captured?.prompt).toBeUndefined()
      },
    })
  })

  test("global reflection reads pending inbox memory and clears it after success", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const written = await Memory.write({
          session_id: "reflect_inbox_source",
          store: "user",
          action: "add",
          value: "用户希望长期记住：inbox-reflection-marker",
          reason: "manual",
        })
        expect(written.ok).toBe(true)

        let prompt = ""
        Memory.setReflectionObjectGeneratorForTest(async (params) => {
          const messages = (params as { messages?: Array<{ content?: string }> }).messages ?? []
          prompt = messages.map((message) => message.content ?? "").join("\n")
          return {
            object: {
              daily_memory: [],
              user_patches: [],
              summary: "inbox reflected",
            },
          }
        })

        try {
          const result = await Memory.reflect({
            scope: "global",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        expect(prompt).toContain("Pending inbox memory")
        expect(prompt).toContain("inbox-reflection-marker")

        await Memory.start({ session_id: "reflect_inbox_other" })
        const hits = await Memory.search({ session_id: "reflect_inbox_other", query: "inbox-reflection-marker" })
        expect(hits).toEqual([])
      },
    })
  })

  test("global reflection removes cleared inbox entries from existing L1 active memory", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const marker = "inbox-active-stale-marker"
        const searchSession = "reflect_inbox_active_existing_session"
        const written = await Memory.write({
          session_id: "reflect_inbox_active_source",
          store: "user",
          action: "add",
          value: `用户希望长期记住：${marker}`,
          reason: "manual",
        })
        expect(written.ok).toBe(true)

        await Memory.start({ session_id: searchSession })
        await Memory.search({ session_id: searchSession, query: marker })
        let prompt = await Memory.activePrompt({ session_id: searchSession })
        expect(prompt.prompt).toContain(marker)

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [],
            user_patches: [],
            summary: "inbox reflected and active pruned",
          },
        }))

        try {
          const result = await Memory.reflect({
            scope: "global",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        prompt = await Memory.activePrompt({ session_id: searchSession })
        expect(prompt.prompt).not.toContain(marker)
        expect(prompt.active.some((entry) => entry.source === "inbox" && entry.text.includes(marker))).toBe(false)
      },
    })
  })

  test("current_session reflection does not consume same-text unscoped or global inbox entries from another session", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "reflect_current_session_no_cross_session_inbox_cleanup"
        const unscopedMarker = "reflect-current-session-unscoped-other-marker"
        const globalMarker = "reflect-current-session-global-other-marker"

        const unscopedWrite = await Memory.write({
          session_id: "reflect_current_session_unscoped_other",
          store: "user",
          action: "add",
          value: `用户希望长期记住：${unscopedMarker}`,
          reason: "manual",
        })
        expect(unscopedWrite.ok).toBe(true)
        const globalWrite = await Memory.write({
          session_id: "reflect_current_session_global_other",
          store: "user",
          action: "add",
          value: `scope(global): 用户希望长期记住：${globalMarker}`,
          reason: "manual",
        })
        expect(globalWrite.ok).toBe(true)

        await Memory.write({
          session_id: sessionID,
          store: "user",
          action: "add",
          value: `用户希望长期记住：${unscopedMarker}`,
          reason: "manual",
        })
        await Memory.write({
          session_id: sessionID,
          store: "user",
          action: "add",
          value: `scope(global): 用户希望长期记住：${globalMarker}`,
          reason: "manual",
        })

        const before = await Memory.list()
        expect(before.inbox.entries.some((entry) => entry.includes(unscopedMarker))).toBe(true)
        expect(before.inbox.entries.some((entry) => entry.includes(globalMarker))).toBe(true)

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [],
            user_patches: [],
            summary: "current session skipped cross-session inbox",
          },
        }))

        try {
          const result = await Memory.reflect({
            session_id: sessionID,
            scope: "current_session",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        const after = await Memory.list()
        expect(after.inbox.entries.some((entry) => entry.includes(unscopedMarker))).toBe(true)
        expect(after.inbox.entries.some((entry) => entry.includes(globalMarker))).toBe(true)
      },
    })
  })

  test("current_session reflection consumes explicitly session-scoped inbox entries", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "reflect_current_session_scoped_inbox"
        const marker = "reflect-current-session-scoped-marker"
        const writeResult = await Memory.write({
          session_id: sessionID,
          store: "user",
          action: "add",
          value: `scope(session-${sessionID}): 用户希望长期记住：${marker}`,
          reason: "manual",
        })
        expect(writeResult.ok).toBe(true)

        const before = await Memory.list()
        expect(before.inbox.entries.some((entry) => entry.includes(marker))).toBe(true)

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [],
            user_patches: [],
            summary: "current session scoped inbox consumed",
          },
        }))

        try {
          const result = await Memory.reflect({
            session_id: sessionID,
            scope: "current_session",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        const after = await Memory.list()
        expect(after.inbox.entries.some((entry) => entry.includes(marker))).toBe(false)
      },
    })
  })

  test("memory_reflect asks LLM to resolve conflicts and deduplicates equivalent USER patches", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          [
            "# USER",
            "- preference[inferred]: 用户默认希望中文回答。",
            "- preference[explicit]: 默认用英文回答。",
          ].join("\n"),
        )

        await Memory.write({
          session_id: "reflect_conflict_session",
          store: "user",
          action: "add",
          value: "用户明确纠正：默认用中文回答，不要默认英文回答。",
          reason: "manual",
        })

        let system = ""
        Memory.setReflectionObjectGeneratorForTest(async (params) => {
          const messages = (params as { messages?: Array<{ role?: string; content?: string }> }).messages ?? []
          system = messages
            .filter((message) => message.role === "system")
            .map((message) => message.content ?? "")
            .join("\n")
          return {
            object: {
              daily_memory: [],
              user_patches: [
                {
                  op: "add",
                  kind: "preference",
                  source: "explicit",
                  content: "用户默认希望中文回答。",
                },
                {
                  op: "replace",
                  match: "默认用英文回答",
                  kind: "preference",
                  source: "explicit",
                  content: "默认用中文回答。",
                },
              ],
              summary: "resolved conflict",
            },
          }
        })

        try {
          const result = await Memory.reflect({
            session_id: "reflect_conflict_session",
            scope: "current_session",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        expect(system).toContain("Resolve duplicates and conflicts before writing")
        expect(system).toContain("replace or remove")

        const user = await Memory.read("user")
        expect(user.entries.filter((entry) => entry.includes("用户默认希望中文回答"))).toEqual([
          "preference[explicit]: 用户默认希望中文回答。",
        ])
        expect(user.entries.some((entry) => entry.includes("默认用英文回答"))).toBe(false)
      },
    })
  })

  test("memory_reflect deduplicates equivalent daily memory entries", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Memory.write({
          session_id: "reflect_daily_duplicate_session",
          store: "memory",
          action: "add",
          value: "Aether 使用 cron 进行反思。",
          reason: "manual",
        })

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [
              {
                kind: "fact",
                content: "Aether 使用 cron 进行反思。",
              },
              {
                kind: "fact",
                content: "Aether使用cron进行反思",
              },
            ],
            user_patches: [],
            summary: "deduped daily",
          },
        }))

        try {
          const result = await Memory.reflect({
            session_id: "reflect_daily_duplicate_session",
            scope: "current_session",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        const memory = await Memory.read("memory")
        expect(memory.entries.filter((entry) => entry.includes("cron"))).toHaveLength(1)
      },
    })
  })

  test("memory_reflect keeps equivalent daily entries when scopes differ", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memoryFile = `${(await Memory.read("memory")).file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(memoryFile, ["# MEMORY", "- fact[explicit]: aether reflection marker"].join("\n"))
        await Memory.write({
          session_id: "reflect_daily_scope_session",
          store: "memory",
          action: "add",
          value: "trigger reflection input for scoped daily dedupe test",
          reason: "manual",
        })

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [
              {
                kind: "fact",
                content: "scope(project-dedup-test): aether reflection marker",
              },
            ],
            user_patches: [],
            summary: "keep scoped daily",
          },
        }))

        try {
          const result = await Memory.reflect({
            session_id: "reflect_daily_scope_session",
            scope: "current_session",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        const memory = await Memory.read("memory")
        const hits = memory.entries.filter((entry) => entry.includes("aether reflection marker"))
        expect(hits).toHaveLength(2)
        expect(hits.some((entry) => entry.includes("scope(project-dedup-test):"))).toBe(true)
        expect(hits.some((entry) => entry === "fact[explicit]: aether reflection marker")).toBe(true)
      },
    })
  })

  test("memory_reflect USER patch dedupe is scope-aware while keeping explicit-over-inferred upgrade within same scope", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          [
            "# USER",
            "- preference[inferred]: scope(project-alpha): use chinese",
            "- preference[inferred]: scope(project-beta): use chinese",
          ].join("\n"),
        )

        await Memory.write({
          session_id: "reflect_user_scope_session",
          store: "memory",
          action: "add",
          value: "scope(project-alpha): trigger reflection input",
          reason: "manual",
        })

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [],
            user_patches: [
              {
                op: "add",
                kind: "preference",
                source: "explicit",
                content: "scope(project-alpha): use chinese",
              },
            ],
            summary: "scope aware user dedupe",
          },
        }))

        try {
          const result = await Memory.reflect({
            session_id: "reflect_user_scope_session",
            scope: "current_session",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        const user = await Memory.read("user")
        expect(user.entries).toContain("preference[explicit]: scope(project-alpha): use chinese")
        expect(user.entries).toContain("preference[inferred]: scope(project-beta): use chinese")
        expect(user.entries.some((entry) => entry === "preference[inferred]: scope(project-alpha): use chinese")).toBe(false)
      },
    })
  })

  test("memory_reflect final USER dedupe keeps explicit when same scope-aware key also has inferred", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "opencode/gpt-5-nano",
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          [
            "# USER",
            "- preference[inferred]: scope(project-alpha): use chinese",
            "- preference[explicit]: scope(project-alpha): use chinese",
            "- preference[inferred]: scope(project-beta): use chinese",
          ].join("\n"),
        )

        await Memory.write({
          session_id: "reflect_user_explicit_wins_session",
          store: "memory",
          action: "add",
          value: "scope(project-alpha): trigger explicit-vs-inferred-final-dedupe",
          reason: "manual",
        })

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [],
            user_patches: [],
            summary: "explicit wins in final user dedupe",
          },
        }))

        try {
          const result = await Memory.reflect({
            session_id: "reflect_user_explicit_wins_session",
            scope: "current_session",
          })
          expect(result.status).toBe("success")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        const user = await Memory.read("user")
        expect(user.entries).toContain("preference[explicit]: scope(project-alpha): use chinese")
        expect(user.entries).toContain("preference[inferred]: scope(project-beta): use chinese")
        expect(user.entries.some((entry) => entry === "preference[inferred]: scope(project-alpha): use chinese")).toBe(false)
      },
    })
  })

  test("memory_reflect uses OpenAI instructions provider option for responses API compatibility", () => {
    const params = Memory.buildReflectionObjectParamsForTest({
      providerID: "openai",
      system: "system instructions",
      prompt: "user prompt",
    }) as Record<string, any>

    expect(params.providerOptions?.openai?.instructions).toBe("system instructions")
    expect(params.providerOptions?.openai?.store).toBe(false)
    expect(params.maxOutputTokens).toBeUndefined()
    expect(Array.isArray(params.messages)).toBe(true)
    expect(params.messages).toHaveLength(1)
    expect(params.messages[0]).toMatchObject({
      role: "user",
      content: "user prompt",
    })
  })

  test("keeps inferred USER entries in the prepared pool", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          ["# USER", "- preference[explicit]: 中文，先结论后展开", "- fact[inferred]: 从近期互动看，用户熟悉量子场论"].join(
            "\n",
          ),
        )

        const userStore = await Memory.read("user")
        expect(userStore.entries.some((entry) => entry.startsWith("fact[inferred]:"))).toBe(true)

        await Memory.start({ session_id: "snapshot_no_inferred" })
        await Memory.search({ session_id: "snapshot_no_inferred", query: "中文" })
        await Memory.search({ session_id: "snapshot_no_inferred", query: "量子场论" })
        const prompt = await Memory.activePrompt({ session_id: "snapshot_no_inferred" })
        expect(prompt.prompt.includes("Priority order: current user instruction")).toBe(true)
        expect(prompt.prompt.includes("preference[explicit]: 中文，先结论后展开")).toBe(true)
        expect(prompt.prompt.includes("fact[inferred]: 从近期互动看，用户熟悉量子场论")).toBe(true)
      },
    })
  })

  test("memory_search pins prepared pool hits into active memory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memoryFile = `${(await Memory.read("memory")).file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(
          memoryFile,
          ["# MEMORY", "- fact[explicit]: Phoenix scheduler design uses JSON cron files"].join("\n"),
        )

        const sessionID = "search_pins_active"
        await Memory.start({ session_id: sessionID })
        let prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(prompt.prompt).toContain("Use memory_search")
        expect(prompt.prompt).toContain("Do not use read, glob, grep, bash")
        expect(prompt.prompt).not.toContain("Phoenix scheduler")

        const hits = await Memory.search({ session_id: sessionID, query: "Phoenix" })
        expect(hits.length).toBe(1)

        prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(prompt.prompt).toContain("Phoenix scheduler design uses JSON cron files")
      },
    })
  })

  test("USER profile baseline is injected without keyword search", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          ["# USER", "- preference[explicit]: 默认用中文回答；先给结论，再展开必要细节。"].join("\n"),
        )

        const memoryFile = `${(await Memory.read("memory")).file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(
          memoryFile,
          ["# MEMORY", "- fact[explicit]: Daily-only marker should wait for search"].join("\n"),
        )

        const sessionID = "user_profile_baseline"
        await Memory.start({ session_id: sessionID })
        const prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(prompt.prompt).toContain("<user_profile>")
        expect(prompt.prompt).toContain("默认用中文回答")
        expect(prompt.prompt).not.toContain("Daily-only marker")
      },
    })
  })

  test("memory_search uses prepared memory without external file permission", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memoryFile = `${(await Memory.read("memory")).file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(
          memoryFile,
          ["# MEMORY", "- fact[explicit]: Permission-safe memory search marker"].join("\n"),
        )

        const tool = await MemorySearchTool.init()
        const result = await tool.execute(
          { query: "Permission-safe" },
          {
            ...toolContext(),
            sessionID: "memory_search_permission_safe",
            ask: async () => {
              throw new Error("memory_search should not request file permissions")
            },
          },
        )

        expect(result.output).toContain("Permission-safe memory search marker")
      },
    })
  })

  test("memory_reload rebuilds pool and clears active memory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memoryStore = await Memory.read("memory")
        const memoryFile = `${memoryStore.file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(memoryFile, ["# MEMORY", "- fact[explicit]: Old alpha memory"].join("\n"))

        const sessionID = "reload_refreshes_pool"
        await Memory.start({ session_id: sessionID })
        await Memory.search({ session_id: sessionID, query: "alpha" })
        let prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(prompt.prompt).toContain("Old alpha memory")

        await Filesystem.write(memoryFile, ["# MEMORY", "- fact[explicit]: New beta memory"].join("\n"))
        const reloaded = await Memory.reload({ session_id: sessionID })
        expect(reloaded.snapshot.entries.some((entry) => entry.text.includes("New beta memory"))).toBe(true)

        prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(prompt.prompt).not.toContain("Old alpha memory")
        expect(prompt.prompt).not.toContain("New beta memory")

        await Memory.search({ session_id: sessionID, query: "beta" })
        prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(prompt.prompt).toContain("New beta memory")
      },
    })
  })

  test("memory_start reuses prepared pool until explicit reload", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const memoryStore = await Memory.read("memory")
        const memoryFile = `${memoryStore.file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(memoryFile, ["# MEMORY", "- fact[explicit]: Cached alpha memory"].join("\n"))

        const sessionID = "start_reuses_pool"
        const first = await Memory.start({ session_id: sessionID })
        expect(first.entries.some((entry) => entry.text.includes("Cached alpha memory"))).toBe(true)

        await Filesystem.write(memoryFile, ["# MEMORY", "- fact[explicit]: Later beta memory"].join("\n"))
        const second = await Memory.start({ session_id: sessionID })
        expect(second.entries.some((entry) => entry.text.includes("Cached alpha memory"))).toBe(true)
        expect(second.entries.some((entry) => entry.text.includes("Later beta memory"))).toBe(false)

        const reloaded = await Memory.reload({ session_id: sessionID })
        expect(reloaded.snapshot.entries.some((entry) => entry.text.includes("Later beta memory"))).toBe(true)
      },
    })
  })

  test("active memory policy guides direct memory tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Memory.write({
          session_id: "snapshot_policy_direct_tools",
          store: "memory",
          action: "add",
          value: "Policy marker",
          reason: "manual",
        })
        const prompt = await Memory.activePrompt({ session_id: "snapshot_policy_direct_tools" })
        expect(prompt.prompt.includes("memory_route")).toBe(false)
        expect(prompt.prompt.includes("Use memory_write")).toBe(true)
        expect(prompt.prompt.includes("Use memory_search")).toBe(true)
        expect(prompt.prompt.includes("Use memory_reflect")).toBe(true)
        expect(prompt.prompt.includes("Priority order: current user instruction")).toBe(true)
      },
    })
  })

  test("formats receipts with success/failure sections and per-section caps", () => {
    const events: Memory.Event[] = []
    for (let i = 0; i < 7; i++) {
      events.push({
        store: "memory",
        action: "add",
        reason: "manual",
        summary: `success-${i}`,
      })
    }
    for (let i = 0; i < 6; i++) {
      events.push({
        store: "user",
        action: "block",
        reason: "capacity_limit",
        summary: `failure-${i}`,
        blocked: true,
      })
    }

    const text = Memory.format(events)
    expect(text.includes("Memory updates:")).toBe(true)
    expect(text.includes("Memory failures:")).toBe(true)
    expect(text.includes("... and 2 more memory updates")).toBe(true)
    expect(text.includes("... and 1 more memory failures")).toBe(true)
  })

})
