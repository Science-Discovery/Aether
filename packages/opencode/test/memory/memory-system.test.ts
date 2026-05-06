import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory"
import { InboxStore } from "../../src/memory/inbox"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { Filesystem } from "../../src/util/filesystem"
import { Config } from "../../src/config/config"
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
import { MemoryListTool, MemoryReadTool, MemorySearchTool, MemoryWriteTool } from "../../src/tool/memory"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Database, eq } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { WorkspaceID } from "../../src/control-plane/schema"

function todayKey() {
  const date = new Date()
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}

type Meta = Record<
  string,
  {
    selected_count?: number
    pin_count?: number
    last_selected_at?: number
    last_pin_at?: number
    updated_at?: number
    prompt_count?: number
    breadth?: number
  }
>

type Ledger = {
  versions: Record<string, { state: string; reason?: string }>
  runs: Record<string, { status: string; error?: string }>
  coverage: Record<string, Session.BackfillTurnMark>
  artifacts: Record<string, unknown>
}

function metaFile() {
  return path.join(Global.Path.data, "memory", "user", "user-meta.json")
}

async function writeMeta(meta: Meta) {
  await fs.rm(metaFile(), { force: true, recursive: true })
  await Filesystem.write(metaFile(), JSON.stringify(meta, null, 2))
}

async function readMeta() {
  return (await Bun.file(metaFile()).json()) as Meta
}

async function ledger(file: string) {
  return (await Bun.file(file).json()) as Ledger
}

function coverage(mark: Session.BackfillTurnMark) {
  const refs = mark.physical_refs.map((ref) => `${ref.session_id}:${ref.user_message_id}`).join("|")
  return `${mark.memory_version}:${mark.logical_fingerprint}:${refs}`
}

async function cleanMemory() {
  await fs.rm(path.join(Global.Path.data, "memory"), { recursive: true, force: true })
  await fs.rm(path.join(Global.Path.data, "storage", "memory"), { recursive: true, force: true })
}

function section(text: string, name: string) {
  return text.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`))?.[1] ?? ""
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

async function source(input: { session: Session.Info; text: string; time: number }) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID: input.session.id,
    role: "user",
    time: { created: input.time },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "build",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: id,
    sessionID: input.session.id,
    type: "text",
    text: input.text,
  })
  await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: input.session.id,
    role: "assistant",
    parentID: id,
    time: { created: input.time + 1, completed: input.time + 2 },
    providerID: "test",
    modelID: "test",
    mode: "build",
    agent: "assistant",
    path: { cwd: input.session.directory, root: input.session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return id
}

async function summarySource(input: { session: Session.Info; text: string; time: number }) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID: input.session.id,
    role: "user",
    time: { created: input.time },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "build",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: id,
    sessionID: input.session.id,
    type: "text",
    text: input.text,
    synthetic: true,
    metadata: {
      summary_only: true,
    },
  })
  await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: input.session.id,
    role: "assistant",
    parentID: id,
    time: { created: input.time + 1, completed: input.time + 2 },
    providerID: "test",
    modelID: "test",
    mode: "build",
    agent: "assistant",
    path: { cwd: input.session.directory, root: input.session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return id
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

  test("memory_write tool rejects legacy durable store arguments", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await MemoryWriteTool.init()

        await expect(
          tool.execute(
            {
              store: "user",
              action: "add",
              value: "Temporary scratch note for this session.",
            } as any,
            toolContext({ userText: "Please remember this globally." }),
          ),
        ).rejects.toThrow("invalid arguments")

        await expect(
          tool.execute(
            {
              store: "global",
              action: "add",
              value: "Temporary scratch note for this session.",
            } as any,
            toolContext({ userText: "Please write this to global memory." }),
          ),
        ).rejects.toThrow("invalid arguments")

        const legacyMemoryStore = await tool.execute(
          {
            store: "memory",
            action: "add",
            value: "Legacy compatible scratch note.",
          },
          toolContext({ userText: "Please remember this." }),
        )
        expect(legacyMemoryStore.metadata.blocked).toBe(false)
        expect(legacyMemoryStore.output).toContain("deprecated")
        expect((legacyMemoryStore.metadata as any).deprecated).toEqual(["store"])

        const result = await tool.execute(
          {
            action: "add",
            value: "Temporary scratch note for this session.",
          },
          toolContext({ userText: "Please remember this." }),
        )
        expect(result.metadata.blocked).toBe(false)
        expect((result.metadata as any).store).toBe("session")
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

  test("disables memory stores and writes when global memory.enabled=false", async () => {
    await Config.updateGlobal({ memory: { enabled: false } } as Partial<Config.Info>)
    await using tmp = await tmpdir({
      git: true,
    })

    try {
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
    } finally {
      await Config.updateGlobal({ memory: { enabled: true } } as Partial<Config.Info>)
    }
  })

  test("global memory disabled blocks memory even when project enables it", async () => {
    await cleanMemory()
    await Config.updateGlobal({ memory: { enabled: false } } as Partial<Config.Info>)
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: true,
        },
      } as Partial<Config.Info>,
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Memory.settings()).enabled).toBe(false)
          const blocked = await Memory.write({
            session_id: "global_disabled",
            store: "memory",
            action: "add",
            value: "This should not be written while global memory is disabled.",
            reason: "manual",
          })
          expect(blocked.ok).toBe(false)
          expect(blocked.events[0]?.reason).toBe("memory_disabled")
        },
      })
    } finally {
      await Config.updateGlobal({ memory: { enabled: true } } as Partial<Config.Info>)
      await cleanMemory()
    }
  })

  test("project memory.enabled=false does not disable global memory", async () => {
    await Config.updateGlobal({ memory: { enabled: true } } as Partial<Config.Info>)
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          enabled: false,
          memory_reflection_model: {
            providerID: "project-provider",
            modelID: "project-model",
          },
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Memory.settings()).enabled).toBe(true)
        expect((await Memory.settings()).memory_reflection_model).toBeUndefined()
        const written = await Memory.write({
          session_id: "project_disabled_ignored",
          store: "memory",
          action: "add",
          value: "Project memory enabled flag should not control the global memory switch.",
          reason: "manual",
        })
        expect(written.ok).toBe(true)
      },
    })
  })

  test("refresh status is pending until the current memory version is completed", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const status = await Memory.refreshStatus()
        expect(status.state).toBe("pending")
        expect(status.refresh_required).toBe(true)

        const app = Server.Default()
        const body = await (await app.request("/memory")).json()
        expect(body.refresh.state).toBe("pending")

        await Memory.markRefreshCompletedForTest()
        const done = await Memory.refreshDryRun({ scope: "current_project" })
        expect(done.status.noop).toBe(true)
        expect(done.status.state).toBe("completed")
        expect(done.run).toBeUndefined()
      },
    })
  })

  test("refresh dry-run reports inventory states and keeps ordinary search on old memory", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          ["# USER", "- fact[explicit]: Ancient user profile", "- invalid user line"].join("\n"),
        )

        const daily = (await Memory.read("memory")).file
        const file = path.join(daily, todayKey(), "MEMORY.md")
        await Filesystem.write(file, ["# MEMORY", "- fact[explicit]: Old durable zebra", "- invalid daily line"].join("\n"))
        await Filesystem.write(
          path.join(Global.Path.data, "memory", "session", "old_session", "MEMORY.md"),
          ["# SESSION MEMORY", "- Old session marker"].join("\n"),
        )
        await Filesystem.writeJson(path.join(Global.Path.data, "storage", "memory", "snapshot", "old.json"), {
          entries: [],
        })
        await Filesystem.writeJson(path.join(Global.Path.data, "storage", "memory", "active", "old.json"), {
          entries: [],
        })

        const before = await Memory.search({
          session_id: "old_search_session",
          query: "durable zebra",
          pin: false,
        })
        expect(before.some((hit) => hit.text.includes("Old durable zebra"))).toBe(true)

        const run = await Memory.refreshDryRun({ scope: "current_project" })
        expect(run.inventory?.old_memory).toBe(true)
        expect(run.inventory?.missing_metadata).toBe(true)
        expect(run.inventory?.mixed_format).toBe(true)
        expect(run.inventory?.old_snapshot_cache).toBe(true)
        expect(run.inventory?.old_active_cache).toBe(true)
        expect(run.inventory?.no_memory).toBe(false)
        expect(await Bun.file(run.status.ledger_file).exists()).toBe(true)

        const after = await Memory.search({
          session_id: "old_search_session",
          query: "durable zebra",
          pin: false,
        })
        expect(after.some((hit) => hit.text.includes("Old durable zebra"))).toBe(true)
      },
    })
    await cleanMemory()
  })

  test("refresh dry-run records blocked_by_disabled and resumes as pending when enabled", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await Config.updateGlobal({ memory: { enabled: false } } as Partial<Config.Info>)
    await using off = await tmpdir({
      git: true,
    })

    try {
      await Instance.provide({
        directory: off.path,
        fn: async () => {
          const blocked = await Memory.refreshDryRun({ scope: "current_project" })
          expect(blocked.status.state).toBe("blocked_by_disabled")
          expect(blocked.run?.status).toBe("blocked")
          expect(blocked.status.reason).toBe("memory_disabled")
        },
      })

      await Config.updateGlobal({ memory: { enabled: true } } as Partial<Config.Info>)
      await using on = await tmpdir({
        git: true,
      })

      await Instance.provide({
        directory: on.path,
        fn: async () => {
          const status = await Memory.refreshStatus()
          expect(status.state).toBe("pending")

          const resumed = await Memory.refreshDryRun({ scope: "current_project" })
          expect(resumed.status.state).toBe("pending")
          expect(resumed.run?.status).toBe("success")
        },
      })
    } finally {
      await Config.updateGlobal({ memory: { enabled: true } } as Partial<Config.Info>)
    }
  })

  test("refresh dry-run records failed status and can resume on the next run", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Memory.failNextRefreshDryRunForTest("test_refresh_failure")
        const failed = await Memory.refreshDryRun({ scope: "current_project" })
        expect(failed.status.state).toBe("failed")
        expect(failed.run?.status).toBe("failed")
        expect(failed.run?.error).toContain("test_refresh_failure")

        const saved = await ledger(failed.status.ledger_file)
        expect(saved.versions[failed.status.memory_version]?.state).toBe("failed")
        expect(saved.runs[failed.run!.run_id]?.status).toBe("failed")

        const resumed = await Memory.refreshDryRun({ scope: "current_project" })
        expect(resumed.status.state).toBe("pending")
        expect(resumed.run?.status).toBe("success")
      },
    })
  })

  test("refresh coverage keys are stable across state changes for the same source", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Coverage source" })
        await source({ session, text: "Coverage durable source", time: 10 })

        const first = await Memory.refreshDryRun({ scope: "current_project" })
        const saved = await ledger(first.status.ledger_file)
        const mark = Object.values(saved.coverage)[0]!
        const key = coverage(mark)

        saved.coverage = {
          [key]: {
            ...mark,
            state: "generated",
          },
        }
        await Filesystem.writeJson(first.status.ledger_file, saved)

        await Memory.refreshDryRun({ scope: "current_project" })
        const next = await ledger(first.status.ledger_file)
        expect(Object.keys(next.coverage)).toEqual([key])
      },
    })
  })

  test("refresh dry-run enumerates archived legacy fork sessions and proves chat DB read-only", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "Backfill root" })
        await source({ session: root, text: "Root durable source", time: 10 })
        const child = await Session.fork({ sessionID: root.id })
        await source({ session: child, text: "Child own durable source", time: 20 })

        const archived = await Session.create({ title: "Archived source" })
        await source({ session: archived, text: "Archived durable source", time: 30 })
        await Session.archive(archived.id)

        const legacy = await Session.create({ title: "Legacy source" })
        await source({ session: legacy, text: "Legacy durable source", time: 40 })
        Database.use((db) =>
          db.update(SessionTable).set({ tree_id: null }).where(eq(SessionTable.id, legacy.id)).run(),
        )

        const run = await Memory.refreshDryRun({ scope: "current_project" })
        expect(run.stats?.databases.some((item) => item.current && item.status === "reachable")).toBe(true)
        expect(run.stats?.tree_sessions).toBeGreaterThanOrEqual(3)
        expect(run.stats?.legacy_sessions).toBeGreaterThanOrEqual(1)
        expect(run.stats?.archived_sessions).toBeGreaterThanOrEqual(1)
        expect(run.stats?.by_state.covered_by_parent).toBeGreaterThanOrEqual(1)
        expect(run.stats?.by_state.legacy_isolated).toBeGreaterThanOrEqual(1)
        expect(run.stats?.readonly.unchanged).toBe(true)
      },
    })
  })

  test("refresh run stages unique turns, promotes historical memory, refreshes caches, and no-ops when completed", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const day = "2026-04-01"
        const session = await Session.create({ title: "Refresh source" })
        await source({
          session,
          text: "The user wants the promoted alpha marker remembered.",
          time: new Date(2026, 3, 1, 10).getTime(),
        })

        await Memory.start({ session_id: "refresh_cached_session" })
        let reflected = false
        let reflects = 0
        const seen: string[] = []
        Memory.setBackfillCandidateGeneratorForTest(async ({ turn }) => {
          seen.push(turn.user_text)
          return ["Backfill staging alpha candidate"]
        })
        Memory.setReflectionObjectGeneratorForTest(async (params) => {
          reflected = true
          reflects++
          const body = String(((params as Record<string, any>).messages?.at(-1)?.content as string | undefined) ?? "")
          expect(body).toContain("Trigger: backfill")
          expect(body).toContain("Backfill staging alpha candidate")
          if (reflects === 1) {
            const hits = await Memory.search({
              session_id: "refresh_cached_session",
              query: "staging alpha",
              pin: false,
            })
            expect(hits).toEqual([])
          }
          return {
            object: {
              daily_memory: [{ kind: "fact", content: "Promoted alpha daily memory" }],
              user_patches: [
                {
                  op: "add",
                  kind: "preference",
                  source: "explicit",
                  content: "Promoted alpha user profile",
                },
              ],
              summary: "backfilled alpha",
            },
          }
        })

        try {
          const run = await Memory.refreshRun({ scope: "current_project" })
          expect(run.status.state).toBe("completed")
          expect(run.run?.status).toBe("success")
          expect(run.run?.candidate_count).toBe(1)
          expect(run.run?.promoted_daily_count).toBe(1)
          expect(run.run?.promoted_user_count).toBe(1)
          expect(reflected).toBe(true)
          expect(seen).toEqual(["The user wants the promoted alpha marker remembered."])
          expect(run.stats?.readonly.unchanged).toBe(true)
          expect(run.run?.staging_path).toContain(path.join("memory", "system", "staging"))
          expect(run.run?.backup_path).toContain(path.join("memory", "system", "backup", "latest"))

          const staged = (await Bun.file(run.run!.staging_path!).json()) as Memory.BackfillStaging
          expect(staged.candidates[0]?.candidate_id).toBeDefined()
          expect(staged.candidates[0]?.text).toBeUndefined()
          expect(staged.candidates[0]?.text_hash).toBeDefined()

          const log = (await Bun.file(
            path.join(Global.Path.data, "memory", "reflection", "run", `${run.run!.run_id}-${day}.json`),
          ).json()) as { scope: string; refresh_scope?: string }
          expect(log.scope).toBe("current_scope")
          expect(log.refresh_scope).toBe("current_project")

          const app = Server.Default()
          const body = (await (await app.request("/memory")).json()) as { refresh: Memory.RefreshStatus }
          expect(body.refresh.scope).toBe("current_project")
          expect(body.refresh.stage).toBe("completed")
          expect(body.refresh.candidate_count).toBe(1)

          const index = (await Bun.file(path.join(Global.Path.data, "memory", "system", "artifact-index.json")).json()) as {
            durable_before: { user: { valid_count: number } }
            durable_after: { user: { valid_count: number }; daily: Array<{ day: string; valid_count: number }> }
          }
          expect(index.durable_before.user.valid_count).toBe(0)
          expect(index.durable_after.user.valid_count).toBe(1)
          expect(index.durable_after.daily.some((item) => item.day === day && item.valid_count === 1)).toBe(true)

          expect(await Bun.file(path.join(Global.Path.data, "memory", "session", session.id, "MEMORY.md")).exists()).toBe(
            false,
          )
          expect(await Bun.file(path.join(run.run!.backup_path!, "manifest.json")).exists()).toBe(true)

          const daily = await Bun.file(path.join(Global.Path.data, "memory", "daily", day, "MEMORY.md")).text()
          expect(daily).toContain("Promoted alpha daily memory")
          const today = path.join(Global.Path.data, "memory", "daily", todayKey(), "MEMORY.md")
          if (todayKey() !== day) expect(await Bun.file(today).exists()).toBe(false)

          const meta = await readMeta()
          const item = meta[Memory.metaKeyForTest("preference[explicit]: Promoted alpha user profile")]
          expect(item?.selected_count ?? 0).toBe(0)
          expect(item?.pin_count ?? 0).toBe(0)

          const hits = await Memory.search({
            session_id: "refresh_cached_session",
            query: "daily memory",
            pin: false,
          })
          expect(hits.some((hit) => hit.text.includes("Promoted alpha daily memory"))).toBe(true)

          const prompt = await Memory.activePrompt({ session_id: "refresh_cached_session" })
          expect(prompt.prompt).toContain("Promoted alpha user profile")

          const noop = await Memory.refreshRun({ scope: "current_project" })
          expect(noop.status.noop).toBe(true)
          expect(noop.run?.status).toBe("noop")
          expect(noop.run?.candidate_count).toBe(0)
          expect(seen).toEqual(["The user wants the promoted alpha marker remembered."])
          seen.length = 0
          reflected = false

          await source({
            session,
            text: "The user wants the promoted beta marker remembered.",
            time: new Date(2026, 3, 1, 11).getTime(),
          })
          const next = await Memory.refreshRun({ scope: "current_project" })
          expect(next.run?.error).toBeUndefined()
          expect(next.run?.status).toBe("success")
          expect(next.run?.candidate_count).toBe(1)
          expect(reflected).toBe(true)
          expect(seen).toEqual(["The user wants the promoted beta marker remembered."])
        } finally {
          Memory.resetBackfillCandidateGeneratorForTest()
          Memory.resetReflectionObjectGeneratorForTest()
          await cleanMemory()
          await Memory.resetRefreshLedgerForTest()
        }
      },
    })
  })

  test("refresh run blocks while memory is disabled and resumes when enabled", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await Config.updateGlobal({ memory: { enabled: false } } as Partial<Config.Info>)
    await using off = await tmpdir({
      git: true,
    })

    try {
      await Instance.provide({
        directory: off.path,
        fn: async () => {
          const blocked = await Memory.refreshRun({ scope: "current_project" })
          expect(blocked.status.state).toBe("blocked_by_disabled")
          expect(blocked.run?.status).toBe("blocked")
          expect(blocked.run?.stats).toBeUndefined()
        },
      })

      await Config.updateGlobal({ memory: { enabled: true } } as Partial<Config.Info>)
      await using on = await tmpdir({
        git: true,
      })

      await Instance.provide({
        directory: on.path,
        fn: async () => {
          const resumed = await Memory.refreshRun({ scope: "current_project" })
          expect(resumed.status.state).toBe("completed")
          expect(resumed.run?.status).toBe("noop")
          expect(resumed.run?.candidate_count).toBe(0)
        },
      })
    } finally {
      await Config.updateGlobal({ memory: { enabled: true } } as Partial<Config.Info>)
      await cleanMemory()
      await Memory.resetRefreshLedgerForTest()
    }
  })

  test("refresh run observes global memory config changes written outside current process cache", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using cfg = await tmpdir()
    const prev = Global.Path.config
    ;(Global.Path as { config: string }).config = cfg.path
    Config.global.reset()

    try {
      await Filesystem.write(path.join(cfg.path, "aether.json"), JSON.stringify({ memory: { enabled: false } }))
      await using off = await tmpdir({ git: true })
      await Instance.provide({
        directory: off.path,
        fn: async () => {
          const blocked = await Memory.refreshRun({ scope: "current_project" })
          expect(blocked.status.state).toBe("blocked_by_disabled")
          expect(blocked.run?.status).toBe("blocked")
        },
      })

      await Filesystem.write(path.join(cfg.path, "aether.json"), JSON.stringify({ memory: { enabled: true } }))
      await using on = await tmpdir({ git: true })
      await Instance.provide({
        directory: on.path,
        fn: async () => {
          const resumed = await Memory.refreshRun({ scope: "current_project" })
          expect(resumed.status.state).toBe("completed")
          expect(resumed.run?.status).toBe("noop")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = prev
      Config.global.reset()
      await cleanMemory()
      await Memory.resetRefreshLedgerForTest()
    }
  })

  test("refresh run skips fork copies, blocks risky sources, dedupes exact durable text, and keeps chat DB read-only", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const daily = (await Memory.read("memory")).file
        await Filesystem.write(
          path.join(daily, "2026-04-02", "MEMORY.md"),
          ["# MEMORY", "- fact[explicit]: Duplicate durable candidate"].join("\n"),
        )

        const root = await Session.create({ title: "Backfill tree root" })
        await source({ session: root, text: "Root unique candidate should only generate once.", time: 10 })
        await source({ session: root, text: "api_key sk-abcdefghijklmnopqrstuvwxyz should be blocked", time: 20 })
        const child = await Session.fork({ sessionID: root.id })
        await source({ session: child, text: "Child own candidate should promote.", time: 30 })
        const remote = await Session.create({ title: "Remote unavailable parent" })
        await source({ session: remote, text: "Remote unavailable own candidate should promote.", time: 40 })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ fork_parent_session_id: "missing_parent_for_backfill_test" as Session.Info["id"] })
            .where(eq(SessionTable.id, remote.id))
            .run(),
        )
        const summary = await Session.create({ title: "Summary-only source" })
        await summarySource({ session: summary, text: "Summary only candidate should stay low confidence.", time: 50 })
        const unsafe = await Session.create({ title: "Unsafe generated source" })
        await source({ session: unsafe, text: "Generator output risk source should be blocked after generation.", time: 60 })

        const seen: string[] = []
        Memory.setBackfillCandidateGeneratorForTest(async ({ turn }) => {
          seen.push(turn.user_text)
          if (turn.user_text.includes("Root unique")) return ["fact[explicit]: Duplicate durable candidate"]
          if (turn.user_text.includes("Remote unavailable")) return ["Remote generated candidate"]
          if (turn.user_text.includes("Generator output")) return ["api_key sk-abcdefghijklmnopqrstuvwxyz unsafe generated"]
          return ["Child generated candidate"]
        })
        Memory.setReflectionObjectGeneratorForTest(async (params) => {
          const body = String(((params as Record<string, any>).messages?.at(-1)?.content as string | undefined) ?? "")
          expect(body).toContain("Child generated candidate")
          expect(body).toContain("Remote generated candidate")
          expect(body).not.toContain("Summary generated candidate")
          expect(body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
          expect(body).not.toContain("Duplicate durable candidate")
          return {
            object: {
              daily_memory: [{ kind: "fact", content: "Child promoted candidate" }],
              user_patches: [],
              summary: "child only",
            },
          }
        })

        try {
          const run = await Memory.refreshRun({ scope: "current_project" })
          expect(run.status.state).toBe("completed")
          expect(seen.sort()).toEqual([
            "Child own candidate should promote.",
            "Generator output risk source should be blocked after generation.",
            "Remote unavailable own candidate should promote.",
            "Root unique candidate should only generate once.",
          ])
          expect(run.stats?.by_state.covered_by_parent).toBeGreaterThanOrEqual(2)
          expect(run.stats?.remote_unavailable).toBeGreaterThanOrEqual(1)
          expect(run.stats?.summary_only_turns).toBeGreaterThanOrEqual(1)
          expect(run.stats?.readonly.unchanged).toBe(true)
          expect(run.run?.blocked_count).toBe(3)
          expect(run.run?.deduped_count).toBe(1)
          expect(run.run?.candidate_count).toBe(2)

          const staged = (await Bun.file(run.run!.staging_path!).json()) as Memory.BackfillStaging
          expect(staged.candidates.some((candidate) => candidate.status === "blocked" && !candidate.text)).toBe(true)
          expect(staged.candidates.some((candidate) => candidate.status === "deduped_exact" && !candidate.text)).toBe(true)
          expect(staged.candidates.some((candidate) => candidate.status === "generated" && !candidate.text)).toBe(true)
          expect(
            staged.candidates.some(
              (candidate) =>
                candidate.status === "blocked" &&
                candidate.reason === "safety_secret" &&
                candidate.text_hash &&
                !candidate.text,
            ),
          ).toBe(true)
          expect(
            staged.candidates.some(
              (candidate) =>
                candidate.status === "blocked" &&
                candidate.reason === "summary_only_original_turns_unverified" &&
                candidate.source_state === "summary_only" &&
                !candidate.text &&
                !candidate.text_hash,
            ),
          ).toBe(true)
          expect(
            staged.candidates.some(
              (candidate) => candidate.source_state === "summary_only" && candidate.confidence === 0.35,
            ),
          ).toBe(true)

          const file = await Bun.file(path.join(Global.Path.data, "memory", "daily", "1970-01-01", "MEMORY.md")).text()
          expect(file).toContain("Child promoted candidate")
          expect(file.match(/Duplicate durable candidate/g)?.length ?? 0).toBe(0)
        } finally {
          Memory.resetBackfillCandidateGeneratorForTest()
          Memory.resetReflectionObjectGeneratorForTest()
          await cleanMemory()
          await Memory.resetRefreshLedgerForTest()
        }
      },
    })
  })

  test("refresh run records failures, API run can resume, and force keeps only the latest backup", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Failure resume" })
        await source({ session, text: "Resume refresh source", time: 10 })

        Memory.failNextRefreshRunForTest("refresh_run_failed_for_test")
        const failed = await Memory.refreshRun({ scope: "current_project" })
        expect(failed.status.state).toBe("failed")
        expect(failed.run?.status).toBe("failed")
        expect(failed.run?.error).toContain("refresh_run_failed_for_test")

        Memory.setBackfillCandidateGeneratorForTest(async () => ["Resume generated candidate"])
        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [{ kind: "fact", content: "Resume promoted memory" }],
            user_patches: [],
            summary: "resumed",
          },
        }))

        try {
          const app = Server.Default()
          const body = (await (
            await app.request("/memory/refresh/run?scope=global", { method: "POST" })
          ).json()) as Memory.RefreshRunResult
          expect(body.status.state).toBe("completed")
          expect(body.run?.status).toBe("success")
          const first = body.run!.run_id

          const forced = await Memory.refreshRun({ scope: "global", force: true })
          expect(forced.status.state).toBe("completed")
          expect(forced.run?.status).toBe("success")
          expect(forced.run?.run_id).not.toBe(first)

          const manifest = (await Bun.file(path.join(Global.Path.data, "memory", "system", "backup", "latest", "manifest.json")).json()) as {
            run_id: string
          }
          expect(manifest.run_id).toBe(forced.run!.run_id)
        } finally {
          Memory.resetBackfillCandidateGeneratorForTest()
          Memory.resetReflectionObjectGeneratorForTest()
          await cleanMemory()
          await Memory.resetRefreshLedgerForTest()
        }
      },
    })
  })

  test("refresh run rolls back durable writes when promote commit fails", async () => {
    await cleanMemory()
    await Memory.resetRefreshLedgerForTest()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const day = "1970-01-01"
        const daily = (await Memory.read("memory")).file
        const dailyFile = path.join(daily, day, "MEMORY.md")
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(dailyFile, ["# MEMORY", "- fact[explicit]: Old stable daily memory"].join("\n"))
        await Filesystem.write(userFile, ["# USER", "- fact[explicit]: Existing stable user"].join("\n"))

        const session = await Session.create({ title: "Rollback source" })
        await source({ session, text: "Rollback source should not leak partial durable writes.", time: 10 })

        Memory.setBackfillCandidateGeneratorForTest(async () => ["Rollback generated candidate"])
        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [{ kind: "fact", content: "New rollback daily memory" }],
            user_patches: [{ op: "add", kind: "fact", source: "explicit", content: "New rollback user" }],
            summary: "rollback",
          },
        }))

        try {
          Memory.failNextRefreshCommitForTest("promote_commit_failed_for_test")
          const failed = await Memory.refreshRun({ scope: "current_project" })
          expect(failed.status.state).toBe("failed")
          expect(failed.run?.status).toBe("failed")
          expect(failed.run?.error).toContain("promote_commit_failed_for_test")

          const afterDaily = await Bun.file(dailyFile).text()
          expect(afterDaily).toContain("Old stable daily memory")
          expect(afterDaily).not.toContain("New rollback daily memory")
          const afterUser = await Bun.file(userFile).text()
          expect(afterUser).toContain("Existing stable user")
          expect(afterUser).not.toContain("New rollback user")
          expect(await Bun.file(path.join(Global.Path.data, "memory", "system", "artifact-index.json")).exists()).toBe(false)
        } finally {
          Memory.resetBackfillCandidateGeneratorForTest()
          Memory.resetReflectionObjectGeneratorForTest()
          await cleanMemory()
          await Memory.resetRefreshLedgerForTest()
        }
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

  test("memory_search matches Chinese n-gram query terms", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = `${(await Memory.read("memory")).file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(
          file,
          ["# MEMORY", "- preference[explicit]: 默认使用中文回答，先给结论再展开必要细节。"].join("\n"),
        )

        const hits = await Memory.search({
          session_id: "search_chinese_ngrams",
          query: "中文回答先结论",
          pin: false,
        })

        expect(hits.some((hit) => hit.text.includes("先给结论"))).toBe(true)
      },
    })
  })

  test("memory_search ranks stronger relevance before weaker source priority", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "search_score_before_priority"
        const file = `${(await Memory.read("memory")).file}/${todayKey()}/MEMORY.md`
        await Filesystem.write(
          file,
          ["# MEMORY", "- fact[explicit]: Phoenix scheduler uses JSON cron plan routing."].join("\n"),
        )
        await Memory.write({
          session_id: sessionID,
          store: "memory",
          action: "add",
          value: "fact[explicit]: Phoenix short marker",
          reason: "manual",
        })

        const hits = await Memory.search({
          session_id: sessionID,
          query: "Phoenix scheduler JSON cron",
          pin: false,
        })

        expect(hits[0]?.text).toContain("scheduler uses JSON cron")
        expect(hits[1]?.text).toContain("Phoenix short marker")
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

  test("USER profile baseline keeps explicit then inferred file order without metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeMeta({})
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          [
            "# USER",
            "- preference[explicit]: first explicit baseline marker",
            "- fact[inferred]: inferred middle baseline marker",
            "- task[explicit]: second explicit baseline marker",
          ].join("\n"),
        )

        const prompt = await Memory.activePrompt({ session_id: "user_baseline_no_meta" })
        const profile = section(prompt.prompt, "user_profile")

        expect(profile.indexOf("first explicit")).toBeLessThan(profile.indexOf("second explicit"))
        expect(profile.indexOf("second explicit")).toBeLessThan(profile.indexOf("inferred middle"))
      },
    })
  })

  test("USER profile baseline ranks later explicit entries with higher metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: sapphire baseline preference should outrank file order"
        const entries = [
          ...Array.from(
            { length: 12 },
            (_, idx) => `preference[explicit]: filler baseline marker ${String(idx + 1).padStart(2, "0")}`,
          ),
          target,
        ]
        await Filesystem.write(userFile, ["# USER", ...entries.map((entry) => `- ${entry}`)].join("\n"))
        await writeMeta({
          [Memory.metaKeyForTest(target)]: {
            pin_count: 8,
            selected_count: 3,
            last_pin_at: Date.now(),
            updated_at: Date.now(),
          },
        })

        const prompt = await Memory.activePrompt({ session_id: "user_baseline_meta_rank" })
        const profile = section(prompt.prompt, "user_profile")

        expect(profile).toContain("sapphire baseline preference")
      },
    })
  })

  test("USER profile baseline refreshes in-memory snapshot metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeMeta({})
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: ruby refreshed in-memory baseline marker"
        const entries = [
          ...Array.from(
            { length: 12 },
            (_, idx) => `preference[explicit]: in-memory filler marker ${String(idx + 1).padStart(2, "0")}`,
          ),
          target,
        ]
        await Filesystem.write(userFile, ["# USER", ...entries.map((entry) => `- ${entry}`)].join("\n"))

        const sessionID = "user_baseline_meta_in_memory"
        let prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(section(prompt.prompt, "user_profile")).not.toContain("ruby refreshed")

        await writeMeta({
          [Memory.metaKeyForTest(target)]: {
            pin_count: 8,
            selected_count: 3,
            last_pin_at: Date.now(),
            updated_at: Date.now(),
          },
        })

        prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(section(prompt.prompt, "user_profile")).toContain("ruby refreshed")
      },
    })
  })

  test("memory_search pins USER hits and refreshes same-session baseline metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeMeta({})
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: emerald same-session preference should surface after search"
        const entries = [
          ...Array.from(
            { length: 12 },
            (_, idx) => `preference[explicit]: same-session filler marker ${String(idx + 1).padStart(2, "0")}`,
          ),
          target,
        ]
        await Filesystem.write(userFile, ["# USER", ...entries.map((entry) => `- ${entry}`)].join("\n"))

        const sessionID = "user_meta_search_pin"
        let prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(section(prompt.prompt, "user_profile")).not.toContain("emerald same-session")

        const hits = await Memory.search({ session_id: sessionID, query: "emerald same-session" })
        expect(hits[0]?.text).toBe(target)

        prompt = await Memory.activePrompt({ session_id: sessionID })
        expect(section(prompt.prompt, "user_profile")).toContain("emerald same-session")

        const meta = await readMeta()
        const item = meta[Memory.metaKeyForTest(target)]
        expect(item?.selected_count).toBe(1)
        expect(item?.pin_count).toBe(1)
        expect(typeof item?.last_selected_at).toBe("number")
        expect(typeof item?.last_pin_at).toBe("number")
      },
    })
  })

  test("memory_search with pin false selects USER hits without pin count", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeMeta({})
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: violet pin false preference marker"
        await Filesystem.write(userFile, ["# USER", `- ${target}`].join("\n"))

        const hits = await Memory.search({
          session_id: "user_meta_pin_false",
          query: "violet pin false",
          pin: false,
        })

        expect(hits[0]?.text).toBe(target)
        const item = (await readMeta())[Memory.metaKeyForTest(target)]
        expect(item?.selected_count).toBe(1)
        expect(item?.pin_count ?? 0).toBe(0)
        expect(typeof item?.last_selected_at).toBe("number")
        expect(item?.last_pin_at).toBeUndefined()
      },
    })
  })

  test("memory_search keeps USER hits when metadata write fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: cobalt metadata write failure marker"
        const entries = [
          ...Array.from(
            { length: 12 },
            (_, idx) => `preference[explicit]: write-failure filler marker ${String(idx + 1).padStart(2, "0")}`,
          ),
          target,
        ]
        await Filesystem.write(userFile, ["# USER", ...entries.map((entry) => `- ${entry}`)].join("\n"))
        await fs.rm(metaFile(), { force: true, recursive: true })
        await fs.mkdir(metaFile(), { recursive: true })

        const hits = await Memory.search({
          session_id: "user_meta_write_failure",
          query: "cobalt metadata",
        })

        expect(hits[0]?.text).toBe(target)
        const prompt = await Memory.activePrompt({ session_id: "user_meta_write_failure" })
        expect(prompt.prompt).toContain("cobalt metadata write failure")
      },
    })
  })

  test("USER metadata skips invalid entries without dropping valid ones", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: silver valid metadata survives sibling parse failure"
        const entries = [
          ...Array.from(
            { length: 12 },
            (_, idx) => `preference[explicit]: invalid-meta filler marker ${String(idx + 1).padStart(2, "0")}`,
          ),
          target,
        ]
        await Filesystem.write(userFile, ["# USER", ...entries.map((entry) => `- ${entry}`)].join("\n"))
        await fs.rm(metaFile(), { force: true, recursive: true })
        await Filesystem.write(
          metaFile(),
          JSON.stringify(
            {
              broken: { selected_count: "bad" },
              [Memory.metaKeyForTest(target)]: {
                selected_count: 3,
                pin_count: 4,
                last_pin_at: Date.now(),
                updated_at: Date.now(),
              },
            },
            null,
            2,
          ),
        )

        const prompt = await Memory.activePrompt({ session_id: "user_meta_partial_parse" })
        expect(section(prompt.prompt, "user_profile")).toContain("silver valid metadata")
      },
    })
  })

  test("concurrent USER metadata updates preserve selected count", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await writeMeta({})
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: indigo concurrent metadata marker"
        await Filesystem.write(userFile, ["# USER", `- ${target}`].join("\n"))

        await Promise.all(
          Array.from({ length: 4 }, (_, idx) =>
            Memory.search({
              session_id: `user_meta_concurrent_${idx}`,
              query: "indigo concurrent",
              pin: false,
            }),
          ),
        )

        const item = (await readMeta())[Memory.metaKeyForTest(target)]
        expect(item?.selected_count).toBe(4)
      },
    })
  })

  test("repeated activePrompt calls do not mutate USER metadata prompt count", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        const target = "preference[explicit]: amber prompt count should stay diagnostic"
        await Filesystem.write(userFile, ["# USER", `- ${target}`].join("\n"))
        const before = {
          [Memory.metaKeyForTest(target)]: {
            selected_count: 2,
            pin_count: 1,
            prompt_count: 7,
            last_pin_at: Date.now(),
            updated_at: Date.now(),
          },
        }
        await writeMeta(before)

        await Memory.activePrompt({ session_id: "user_meta_prompt_count" })
        await Memory.activePrompt({ session_id: "user_meta_prompt_count" })

        expect(await readMeta()).toEqual(before)
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
        const blank = await Session.create({ title: "Blank memory policy" })
        const blankPrompt = await Memory.activePrompt({ session_id: blank.id })
        expect(blankPrompt.prompt.includes("<memory_scope>")).toBe(true)
        expect(blankPrompt.prompt.includes(`session:${blank.id}`)).toBe(true)
        expect(blankPrompt.prompt.includes(`project:${Instance.project.id}`)).toBe(true)

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
        expect(prompt.prompt.includes("Chinese/English terms")).toBe(true)
        expect(prompt.prompt.includes("Use only the current valid scope ids below")).toBe(true)
        expect(prompt.prompt.includes("Use memory_reflect")).toBe(true)
        expect(prompt.prompt.includes("Priority order: current user instruction")).toBe(true)
      },
    })
  })

  test("scoped live writes mirror to inbox and stay scope-filtered in L2", async () => {
    await cleanMemory()
    await using left = await tmpdir({ git: true })
    await using right = await tmpdir({ git: true })

    await Instance.provide({
      directory: left.path,
      fn: async () => {
        const session = await Session.create({ title: "Inbox writer" })
        const project = Instance.project.id
        const workspace = WorkspaceID.ascending()
        const scoped = await Session.create({ title: "Workspace writer", workspaceID: workspace })
        const scopedReader = await Session.create({ title: "Workspace reader", workspaceID: workspace })

        expect(
          (
            await Memory.write({
              session_id: session.id,
              store: "memory",
              action: "add",
              value: "Project scoped kiwi marker belongs to this repo.",
              scope: `project:${project}`,
              salience_hint: "important",
              salience_reason: "project_fact",
              reason: "manual",
            })
          ).ok,
        ).toBe(true)
        expect(
          (
            await Memory.write({
              session_id: session.id,
              store: "memory",
              action: "add",
              value: "Global scoped lychee marker applies everywhere.",
              scope: "global",
              reason: "manual",
            })
          ).ok,
        ).toBe(true)
        expect(
          (
            await Memory.write({
              session_id: session.id,
              store: "memory",
              action: "add",
              value: "Session scoped guava marker stays local.",
              scope: `session:${session.id}`,
              reason: "manual",
            })
          ).ok,
        ).toBe(true)
        expect(
          (
            await Memory.write({
              session_id: scoped.id,
              store: "memory",
              action: "add",
              value: "Workspace scoped plum marker belongs to this workspace.",
              scope: `workspace:${workspace}`,
              reason: "manual",
            })
          ).ok,
        ).toBe(true)

        const wrong = await Memory.write({
          session_id: session.id,
          store: "memory",
          action: "add",
          value: "Wrong project ghost marker should stay local.",
          scope: "project:not-the-current-project",
          reason: "manual",
        })
        expect(wrong.ok).toBe(true)
        expect(wrong.events.some((entry) => entry.reason === "scope_project_mismatch")).toBe(true)

        const entries = await InboxStore.all()
        expect(entries.some((entry) => entry.text.includes("Project scoped kiwi") && entry.source_count === 1)).toBe(true)
        expect(entries.some((entry) => entry.text.includes("Global scoped lychee"))).toBe(true)
        expect(entries.some((entry) => entry.text.includes("Workspace scoped plum"))).toBe(true)
        expect(entries.some((entry) => entry.text.includes("Session scoped guava"))).toBe(false)
        expect(entries.some((entry) => entry.text.includes("Wrong project ghost"))).toBe(false)

        const prompt = await Memory.activePrompt({ session_id: "same_project_reader" })
        expect(prompt.prompt).not.toContain("Project scoped kiwi")

        const projectHits = await Memory.search({
          session_id: "same_project_reader",
          query: "Project scoped kiwi",
          pin: false,
        })
        expect(projectHits[0]?.source).toBe("inbox")
        expect(projectHits[0]?.text).toContain("Project scoped kiwi")

        const workspaceHits = await Memory.search({
          session_id: scopedReader.id,
          query: "Workspace scoped plum",
          pin: false,
        })
        expect(workspaceHits[0]?.source).toBe("inbox")

        const plainHits = await Memory.search({
          session_id: "plain_project_reader",
          query: "plum",
          pin: false,
        })
        expect(plainHits).toEqual([])

        const sessionHits = await Memory.search({
          session_id: "same_project_reader",
          query: "guava",
          pin: false,
        })
        expect(sessionHits).toEqual([])
      },
    })

    await Instance.provide({
      directory: right.path,
      fn: async () => {
        const projectHits = await Memory.search({
          session_id: "other_project_reader",
          query: "kiwi",
          pin: false,
        })
        expect(projectHits).toEqual([])

        const globalHits = await Memory.search({
          session_id: "other_project_reader",
          query: "Global scoped lychee",
          pin: false,
        })
        expect(globalHits[0]?.source).toBe("inbox")
      },
    })
    await cleanMemory()
  })

  test("inbox usage counts come only from real search and retained pins", async () => {
    await cleanMemory()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Inbox count writer" })
        const project = Instance.project.id
        await Memory.write({
          session_id: session.id,
          store: "memory",
          action: "add",
          value: "Counted inbox quince marker.",
          scope: `project:${project}`,
          reason: "manual",
        })
        let entry = (await InboxStore.all()).find((item) => item.text.includes("Counted inbox quince"))
        expect(entry?.selected_count).toBe(0)
        expect(entry?.pin_count).toBe(0)

        await Memory.search({ session_id: "count_reader_one", query: "quince", pin: false })
        await Memory.search({ session_id: "count_reader_one", query: "quince", pin: false })
        entry = (await InboxStore.all()).find((item) => item.text.includes("Counted inbox quince"))
        expect(entry?.selected_count).toBe(1)
        expect(entry?.pin_count).toBe(0)
        expect(entry?.selected_sessions).toEqual(["count_reader_one"])

        await Memory.search({ session_id: "count_reader_two", query: "quince" })
        entry = (await InboxStore.all()).find((item) => item.text.includes("Counted inbox quince"))
        expect(entry?.selected_count).toBe(2)
        expect(entry?.pin_count).toBe(1)
        expect(entry?.pinned_sessions).toEqual(["count_reader_two"])

        await Memory.write({
          session_id: "count_writer_two",
          store: "memory",
          action: "add",
          value: "Counted inbox quince marker.",
          scope: `project:${project}`,
          reason: "manual",
        })
        entry = (await InboxStore.all()).find((item) => item.text.includes("Counted inbox quince"))
        expect(entry?.source_count).toBe(2)
        expect(entry?.selected_count).toBe(2)
        expect(entry?.pin_count).toBe(1)
      },
    })
    await cleanMemory()
  })

  test("reflection applies explicit inbox decisions without blind clearing", async () => {
    await cleanMemory()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Inbox reflection writer" })
        const project = Instance.project.id
        await Memory.write({
          session_id: session.id,
          store: "user",
          action: "add",
          value: "Global inbox mango should become a global profile.",
          scope: "global",
          reason: "manual",
        })
        await Memory.write({
          session_id: session.id,
          store: "memory",
          action: "add",
          value: "Project inbox papaya should become a dated project fact.",
          scope: `project:${project}`,
          reason: "manual",
        })
        await Memory.write({
          session_id: session.id,
          store: "user",
          action: "add",
          value: "Project inbox fig must not enter USER raw.",
          scope: `project:${project}`,
          reason: "manual",
        })
        await Memory.write({
          session_id: session.id,
          store: "memory",
          action: "add",
          value: "Project inbox melon should remain pending.",
          scope: `project:${project}`,
          reason: "manual",
        })
        const entries = await InboxStore.all()
        const mango = entries.find((entry) => entry.text.includes("mango"))!
        const papaya = entries.find((entry) => entry.text.includes("papaya"))!
        const fig = entries.find((entry) => entry.text.includes("fig"))!
        const melon = entries.find((entry) => entry.text.includes("melon"))!

        Memory.setReflectionObjectGeneratorForTest(async (params) => {
          const body = String(((params as Record<string, unknown>).messages as Array<{ content: string }>).at(-1)?.content ?? "")
          expect(body).toContain("Pending inbox entries to reflect")
          expect(body).toContain(mango.id)
          return {
            object: {
              daily_memory: [],
              user_patches: [],
              inbox_decisions: [
                {
                  id: mango.id,
                  revision: mango.revision,
                  decision: "promote_to_user",
                  user_patch: {
                    kind: "preference",
                    source: "explicit",
                    content: "Global inbox mango profile",
                  },
                },
                {
                  id: papaya.id,
                  revision: papaya.revision,
                  decision: "promote_to_daily",
                  daily_memory: {
                    kind: "fact",
                    content: "In this project, papaya became a dated fact.",
                  },
                },
                {
                  id: fig.id,
                  revision: fig.revision,
                  decision: "promote_to_user",
                  user_patch: {
                    kind: "preference",
                    source: "explicit",
                    content: "Project fig raw leak",
                  },
                },
                {
                  id: melon.id,
                  revision: melon.revision,
                  decision: "keep_pending",
                },
              ],
              summary: "inbox reflected",
            },
          }
        })

        try {
          const result = await Memory.reflect({ session_id: session.id, scope: "current_scope" })
          expect(result.status).toBe("success")

          const user = await Memory.read("user")
          expect(user.entries).toContain("preference[explicit]: Global inbox mango profile")
          expect(user.entries.some((entry) => entry.includes("Project fig raw leak"))).toBe(false)

          const daily = await Bun.file(path.join(Global.Path.data, "memory", "daily", todayKey(), "MEMORY.md")).text()
          expect(daily).toContain("In this project, papaya became a dated fact.")

          const next = await InboxStore.all()
          expect(next.find((entry) => entry.id === mango.id)?.status).toBe("promoted_user")
          expect(next.find((entry) => entry.id === papaya.id)?.status).toBe("promoted_daily")
          expect(next.find((entry) => entry.id === fig.id)?.status).toBe("pending")
          expect(next.find((entry) => entry.id === melon.id)?.status).toBe("pending")
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }
      },
    })
    await cleanMemory()
  })

  test("inbox active entries are revalidated after reflection and fork seed inherits active without counts", async () => {
    await cleanMemory()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ title: "Memory seed parent" })
        const project = Instance.project.id
        await Memory.write({
          session_id: parent.id,
          store: "memory",
          action: "add",
          value: "Fork seed raspberry project context.",
          scope: `project:${project}`,
          reason: "manual",
        })
        let entry = (await InboxStore.all()).find((item) => item.text.includes("Fork seed raspberry"))!
        expect(entry.pin_count).toBe(0)

        const app = Server.Default()
        const child = (await (
          await app.request(`/session/${parent.id}/fork`, {
            method: "POST",
            body: JSON.stringify({}),
            headers: { "content-type": "application/json" },
          })
        ).json()) as Session.Info
        const childPrompt = await Memory.activePrompt({ session_id: child.id })
        expect(childPrompt.prompt).toContain("Fork seed raspberry project context")
        expect(
          await Bun.file(path.join(Global.Path.data, "memory", "session", child.id, "MEMORY.md")).exists(),
        ).toBe(false)
        entry = (await InboxStore.all()).find((item) => item.text.includes("Fork seed raspberry"))!
        expect(entry.pin_count).toBe(0)

        await Memory.search({ session_id: "reject_reader", query: "raspberry" })
        let prompt = await Memory.activePrompt({ session_id: "reject_reader" })
        expect(prompt.prompt).toContain("Fork seed raspberry project context")
        entry = (await InboxStore.all()).find((item) => item.text.includes("Fork seed raspberry"))!

        Memory.setReflectionObjectGeneratorForTest(async () => ({
          object: {
            daily_memory: [],
            user_patches: [],
            inbox_decisions: [
              {
                id: entry.id,
                revision: entry.revision,
                decision: "reject_or_stale",
              },
            ],
            summary: "reject raspberry",
          },
        }))
        try {
          await Memory.reflect({ session_id: parent.id, scope: "current_scope" })
        } finally {
          Memory.resetReflectionObjectGeneratorForTest()
        }

        prompt = await Memory.activePrompt({ session_id: "reject_reader" })
        expect(prompt.prompt).not.toContain("Fork seed raspberry project context")

        await Memory.reload({ session_id: child.id })
        const reloaded = await Memory.activePrompt({ session_id: child.id })
        expect(reloaded.prompt).not.toContain("Fork seed raspberry project context")
      },
    })
    await cleanMemory()
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
