import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Memory } from "../../src/memory"
import { installMemory } from "../../src/memory/installer"
import { Cron } from "../../src/cron"
import { MemoryReflectTool, MemorySearchTool } from "../../src/tool/memory"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { parseMemoryMarkdown, renderMemoryDocument } from "../../src/memory/markdown"
import { searchMemoryDocument } from "../../src/memory/search"
import { shouldQuickReflect } from "../../src/memory/gate"

describe("memory markdown", () => {
  test("round trips fixed memory block fields without task-specific extras", () => {
    const doc = parseMemoryMarkdown(`# Aether Memory

## Shortcut Directory

- shortcut: response-style
  triggers: language, answer style
  types: preference
  target_ids: PREF-answer-language
  weight: 0.9
  instruction: Search response style preferences before answering.

## Preferences

### PREF-answer-language
- type: preference
- scope: global
- memory: 用户偏好默认用中文回答。
- confidence: 0.95
- weight: 0.9
- evidence: 用户明确要求默认中文回答。
- updated_at: 2026-05-13T00:00:00.000Z
- status: active

## Facts

## Tasks
`)

    expect(doc.memories).toHaveLength(1)
    expect(doc.memories[0]).toMatchObject({
      id: "PREF-answer-language",
      type: "preference",
      scope: "global",
      memory: "用户偏好默认用中文回答。",
      status: "active",
    })
    expect(Object.keys(doc.memories[0])).not.toContain("task_status")

    const rendered = renderMemoryDocument(doc)
    expect(rendered).toContain("- scope: global")
    expect(rendered).not.toContain("task_status")

    const reparsed = parseMemoryMarkdown(rendered)
    expect(reparsed.shortcuts[0]).toMatchObject({
      shortcut: "response-style",
      triggers: ["language", "answer style"],
      types: ["preference"],
      target_ids: ["PREF-answer-language"],
      weight: 0.9,
    })
  })
})

describe("memory search", () => {
  const doc = parseMemoryMarkdown(`# Aether Memory

## Shortcut Directory

- shortcut: response-style
  triggers: 中文, answer style, language
  types: preference
  target_ids: PREF-answer-language
  weight: 0.9
  instruction: Search response style preferences before answering.

## Preferences

### PREF-answer-language
- type: preference
- scope: global
- memory: 用户偏好默认用中文回答。
- confidence: 0.95
- weight: 0.9
- evidence: 用户明确要求默认中文回答。
- updated_at: 2026-05-13T00:00:00.000Z
- status: active

### PREF-project-runtime
- type: preference
- scope: project:project-x
- memory: 这个项目默认使用 Bun。
- confidence: 0.93
- weight: 0.92
- evidence: 用户明确说这个项目以后都用 Bun。
- updated_at: 2026-05-13T00:00:00.000Z
- status: active

## Facts

## Tasks
`)

  test("splits common separators and returns any keyword match", () => {
    const results = searchMemoryDocument(doc, {
      query: "English, 中文; latex",
      currentProjectID: "project-y",
      limit: 5,
    })

    expect(results.map((item) => item.id)).toContain("PREF-answer-language")
    expect(results[0].ranking_note).toContain("scope")
  })

  test("boosts current project scoped memory over global memory", () => {
    const results = searchMemoryDocument(doc, {
      query: "项目 Bun",
      currentProjectID: "project-x",
      limit: 5,
    })

    expect(results[0].id).toBe("PREF-project-runtime")
  })

  test("does not return unrelated memories from weight or recency alone", () => {
    const results = searchMemoryDocument(doc, {
      query: "EdgeSimUniqueNoMatch",
      currentProjectID: "project-x",
      limit: 5,
    })

    expect(results).toHaveLength(0)
  })
})

describe("quick reflect gate", () => {
  test("marks explicit remember as important", () => {
    const decision = shouldQuickReflect({
      text: "请记住我默认喜欢中文回答",
      intent: "explicit",
      op: "remember",
      shortcutTriggers: [],
    })

    expect(decision).toEqual({
      shouldRun: true,
      priority: "important",
      reason: expect.stringContaining("explicit"),
    })
  })

  test("skips low-signal one-off questions", () => {
    const decision = shouldQuickReflect({
      text: "这个命令是什么意思？",
      intent: "observed",
      op: "remember",
      shortcutTriggers: [],
    })

    expect(decision.shouldRun).toBe(false)
  })

  test("skips sensitive observed signals unless explicitly requested", () => {
    const observed = shouldQuickReflect({
      text: "我的身份证号是 1234567890",
      intent: "observed",
      op: "remember",
      shortcutTriggers: [],
    })
    expect(observed).toEqual({
      shouldRun: false,
      priority: "normal",
      reason: "sensitive observed signal",
    })

    const explicit = shouldQuickReflect({
      text: "请记住我的电话号码只用于测试",
      intent: "explicit",
      op: "remember",
      shortcutTriggers: [],
    })
    expect(explicit.shouldRun).toBe(true)
  })

  test("queues observed emphasis or requirement wording for LLM filtering", () => {
    const decision = shouldQuickReflect({
      text: "我强调过，做每日反思时不要把同主题偏好拆成很多条。",
      intent: "observed",
      op: "remember",
      shortcutTriggers: [],
    })

    expect(decision).toEqual({
      shouldRun: true,
      priority: "normal",
      reason: "preference signal",
    })
  })
})

describe("memory service", () => {
  let tmp: Awaited<ReturnType<typeof tmpdir>>

  beforeEach(async () => {
    tmp = await tmpdir()
    Memory.configureForTest({
      globalMemoryDir: path.join(tmp.path, "global-memory"),
      channelRootDir: path.join(tmp.path, "channels"),
      channelID: "latest",
    })
    await Memory.purge()
  })

  afterEach(async () => {
    await Memory.stop()
    await tmp?.[Symbol.asyncDispose]()
  })

  test("forget deletes matching markdown block and records a tombstone only after a match", async () => {
    await Memory.writeDocumentForTest(
      parseMemoryMarkdown(`# Aether Memory

## Shortcut Directory

- shortcut: response-style
  triggers: 中文, answer style
  types: preference
  target_ids: PREF-answer-language
  weight: 0.9
  instruction: Search response style preferences before answering.

## Preferences

### PREF-answer-language
- type: preference
- scope: global
- memory: 用户偏好默认用中文回答。
- confidence: 0.95
- weight: 0.9
- evidence: 用户明确要求默认中文回答。
- updated_at: 2026-05-13T00:00:00.000Z
- status: active

## Facts

## Tasks
`),
    )

    const deleted = await Memory.forget({
      query: "忘掉中文回答这个偏好",
      source: { createdAt: Date.now(), role: "user" },
      decide: async () => ({ deleteIDs: ["PREF-answer-language"], keepIDs: [], reason: "user requested forget" }),
    })

    expect(deleted.status).toBe("deleted")
    expect(deleted.deletedIDs).toEqual(["PREF-answer-language"])
    expect((await Memory.search({ query: "中文回答" })).results).toHaveLength(0)
    expect((await Memory.status()).shortcut_count).toBe(0)

    const events = await Memory.eventsForTest()
    expect(events.some((event) => event.op === "forget" && event.status === "forgot")).toBe(true)

    const notFound = await Memory.forget({
      query: "忘掉不存在的东西",
      source: { createdAt: Date.now(), role: "user" },
      decide: async () => ({ deleteIDs: [], keepIDs: [], reason: "not found" }),
    })
    expect(notFound.status).toBe("not_found")
  })

  test("status does not create markdown before initialization", async () => {
    const before = await Memory.status()
    expect(before.markdown_exists).toBe(false)
    expect(before.needs_initialization).toBe(true)

    const markdownPath = path.join(tmp.path, "global-memory", "AETHER_MEMORY.md")
    expect(await fs.stat(markdownPath).catch(() => undefined)).toBeUndefined()
  })

  test("explicit remember is quickly reflected into searchable markdown", async () => {
    const remembered = await Memory.remember({
      text: "请记住我默认喜欢中文回答",
      type: "preference",
      intent: "explicit",
      source: { createdAt: Date.now(), role: "user", projectID: "project-a" },
    })

    expect(remembered.status).toBe("applied")
    const found = await Memory.search({ query: "中文回答", limit: 5 })
    expect(found.results).toHaveLength(1)
    expect(found.results[0]?.type).toBe("preference")
    expect(found.results[0]?.scope).toBe("global")

    const events = await Memory.eventsForTest()
    expect(events[0]?.status).toBe("applied")
  })

  test("low-signal observed events are not left pending for daily reflection", async () => {
    const remembered = await Memory.remember({
      text: "这个命令是什么意思？",
      intent: "observed",
      source: { createdAt: Date.now(), role: "user", projectID: "project-a" },
    })

    expect(remembered.status).toBe("ignored")
    const reflected = await Memory.reflect({ mode: "daily", reason: "test" })
    expect(reflected.changed).toBe(false)
    const events = await Memory.eventsForTest()
    expect(events[0]?.status).toBe("ignored")
  })

  test("forget can fall back to LLM decision when keyword search finds no candidate", async () => {
    await Memory.writeDocumentForTest(
      parseMemoryMarkdown(`# Aether Memory

## Shortcut Directory

## Preferences

### PREF-temporary-test
- type: preference
- scope: global
- memory: User has a temporary testing preference that should be deleted later.
- confidence: 0.9
- weight: 0.8
- evidence: The user explicitly requested a temporary testing preference.
- updated_at: 2026-05-13T00:00:00.000Z
- status: active

## Facts

## Tasks
`),
    )

    const deleted = await Memory.forget({
      query: "忘掉测试偏好",
      source: { createdAt: Date.now(), role: "user" },
      decide: async ({ candidates }) => ({
        deleteIDs: candidates.map((candidate) => candidate.id),
        keepIDs: [],
        reason: "semantic fallback matched translated query",
      }),
    })

    expect(deleted.status).toBe("deleted")
    expect(deleted.deletedIDs).toEqual(["PREF-temporary-test"])
  })

  test("observed sensitive information is not reflected into long-term markdown", async () => {
    await Memory.remember({
      text: "我的身份证号是 1234567890",
      intent: "observed",
      source: { createdAt: Date.now(), role: "user" },
    })

    const reflected = await Memory.reflect({ mode: "daily", reason: "test" })
    expect(reflected.changed).toBe(false)
    expect((await Memory.search({ query: "身份证", limit: 5 })).results).toHaveLength(0)
  })

  test("new response-style preference deprecates the older conflicting preference", async () => {
    await Memory.writeDocumentForTest(
      parseMemoryMarkdown(`# Aether Memory

## Shortcut Directory

- shortcut: preference:global
  triggers: 回答, 详细
  types: preference
  target_ids: PREF-old-response-style
  weight: 0.8
  instruction: Call memory_search before response-style tasks.

## Preferences

### PREF-old-response-style
- type: preference
- scope: global
- memory: 用户偏好回答写得详细一些。
- confidence: 0.9
- weight: 0.8
- evidence: 用户曾经要求详细回答。
- updated_at: 2026-05-12T00:00:00.000Z
- status: active

## Facts

## Tasks
`),
    )

    await Memory.remember({
      text: "以后回答请简短一点，先给结论",
      type: "preference",
      intent: "explicit",
      source: { createdAt: Date.now(), role: "user" },
    })

    const concise = await Memory.search({ query: "简短 结论", limit: 5 })
    const detailed = await Memory.search({ query: "详细", limit: 5 })

    expect(concise.results[0]?.memory).toContain("简短")
    expect(detailed.results.some((memory) => memory.id === "PREF-old-response-style")).toBe(false)
  })

  test("project task memory is scoped to the current project when reflected", async () => {
    await Memory.remember({
      text: "请记住这个项目每天检查一次 cron 运行状态",
      type: "task",
      intent: "explicit",
      source: { createdAt: Date.now(), role: "user", projectID: "project-a" },
    })

    const currentProject = await Memory.search({ query: "cron 状态", currentProjectID: "project-a", limit: 5 })
    const otherProject = await Memory.search({ query: "cron 状态", currentProjectID: "project-b", limit: 5 })

    expect(currentProject.results[0]?.scope).toBe("project:project-a")
    expect(currentProject.results[0]!.score).toBeGreaterThan(otherProject.results[0]!.score)
  })

  test("daily reflection scans pending events from all channel memory databases", async () => {
    Memory.configureForTest({
      globalMemoryDir: path.join(tmp.path, "global-memory"),
      channelRootDir: path.join(tmp.path, "channels"),
      channelID: "older",
    })
    await Memory.remember({
      text: "我希望所有项目默认先给结论",
      type: "preference",
      intent: "observed",
      source: { createdAt: Date.now(), role: "user", channelID: "older" },
    })

    Memory.configureForTest({
      globalMemoryDir: path.join(tmp.path, "global-memory"),
      channelRootDir: path.join(tmp.path, "channels"),
      channelID: "latest",
    })
    const reflected = await Memory.reflect({ mode: "daily", reason: "test" })

    expect(reflected.changed).toBe(true)
    const found = await Memory.search({ query: "先给结论", limit: 5 })
    expect(found.results[0]?.memory).toContain("先给结论")
  })

  test("startup catchup schedules one missed daily reflection in the background", async () => {
    await Memory.remember({
      text: "我希望回答先给简短结论",
      type: "preference",
      intent: "observed",
      source: { createdAt: Date.now(), role: "user" },
    })

    const scheduled = await Memory.startupCatchup()
    expect(scheduled.started).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const found = await Memory.search({ query: "简短结论", limit: 5 })
    expect(found.results[0]?.memory).toContain("简短结论")

    const second = await Memory.startupCatchup()
    expect(second.started).toBe(false)
  })

  test("shortcut system prompt excludes target ids and memory bodies", async () => {
    await Memory.writeDocumentForTest(
      parseMemoryMarkdown(`# Aether Memory

## Shortcut Directory

- shortcut: response-style
  triggers: 中文, answer style
  types: preference
  target_ids: PREF-answer-language
  weight: 0.9
  instruction: Search response style preferences before answering.

## Preferences

### PREF-answer-language
- type: preference
- scope: global
- memory: 用户偏好默认用中文回答。
- confidence: 0.95
- weight: 0.9
- evidence: 用户明确要求默认中文回答。
- updated_at: 2026-05-13T00:00:00.000Z
- status: active

## Facts

## Tasks
`),
    )

    const prompt = await Memory.shortcutSystemPrompt()
    expect(prompt).toContain("response-style")
    expect(prompt).toContain("memory_search")
    expect(prompt).not.toContain("PREF-answer-language")
    expect(prompt).not.toContain("用户偏好默认用中文回答")
  })

  test("initialize scans sessions serially and stops after cancellation", async () => {
    const visited: string[] = []
    Memory.setSessionScannerForTest(async function* () {
      yield {
        channelID: "latest",
        projectID: "project-a",
        sessionID: "one",
        messages: [{ role: "user" as const, text: "请记住我喜欢中文回答", createdAt: 1 }],
      }
      yield {
        channelID: "latest",
        projectID: "project-a",
        sessionID: "two",
        messages: [{ role: "user" as const, text: "普通一次性问题", createdAt: 2 }],
      }
    })

    Memory.setInitializerExtractorForTest(async (session) => {
      visited.push(session.sessionID)
      await Memory.cancelInitialize()
      return [
        {
          text: "用户偏好默认用中文回答。",
          type: "preference" as const,
          scope: "global" as const,
        },
      ]
    })

    const result = await Memory.initialize({ confirm: true })

    expect(result.status).toBe("cancelled")
    expect(visited).toEqual(["one"])
    expect((await Memory.eventsForTest()).length).toBe(1)
  })

  test("initialize imports matching user messages with the production extractor", async () => {
    Memory.setSessionScannerForTest(async function* () {
      yield {
        channelID: "latest",
        projectID: "project-a",
        sessionID: "one",
        messages: [
          { role: "user" as const, text: "请记住我偏好先给结论再展开", createdAt: 1 },
          { role: "assistant" as const, text: "好的。", createdAt: 2 },
        ],
      }
      yield {
        channelID: "latest",
        projectID: "project-a",
        sessionID: "two",
        messages: [{ role: "user" as const, text: "这个命令是什么意思？", createdAt: 3 }],
      }
    })

    const result = await Memory.initialize({ confirm: true })

    expect(result).toEqual({ status: "succeeded", scanned: 2, imported: 1 })
    const events = await Memory.eventsForTest()
    expect(events).toHaveLength(1)
    expect(events[0]?.raw_text).toContain("先给结论")

    const found = await Memory.search({ query: "先给结论", limit: 5 })
    expect(found.results[0]?.memory).toContain("先给结论")

    const current = await Memory.status()
    expect(current.initialization).toMatchObject({ status: "succeeded", scanned: 2, imported: 1 })
  })

  test("initialize recognizes natural preference wording from user messages", async () => {
    Memory.setSessionScannerForTest(async function* () {
      yield {
        channelID: "latest",
        projectID: "project-a",
        sessionID: "mathematica",
        messages: [
          {
            role: "user" as const,
            text: "你知道么，我很喜欢用Mathematica来编写程序。我觉得它的代码很实用，且富有美感",
            createdAt: 1,
          },
        ],
      }
    })

    const result = await Memory.initialize({ confirm: true })

    expect(result).toEqual({ status: "succeeded", scanned: 1, imported: 1 })
    const found = await Memory.search({ query: "Mathematica 编写程序", limit: 5 })
    expect(found.results[0]?.memory).toContain("Mathematica")
  })

  test("quick remember can write through reflection while daily reflection can consolidate topics", async () => {
    const seenModes: string[] = []
    Memory.setReflectorForTest(async ({ events, mode }) => {
      seenModes.push(mode)
      return events.map((event) => ({
        eventID: event.id,
        type: "preference" as const,
        scope: "global" as const,
        memory:
          mode === "daily"
            ? "用户在回答风格主题下偏好中文、先给结论，并保留必要解释。"
            : event.raw_text.replace(/^请记住/, "").trim(),
        confidence: 0.9,
        weight: 0.86,
        evidence: mode === "daily" ? "按主题合并生成。" : "quick LLM reflection accepted.",
      }))
    })

    const remembered = await Memory.remember({
      text: "请记住我希望默认用中文回答",
      type: "preference",
      intent: "explicit",
      source: { createdAt: Date.now(), role: "user" },
    })
    expect(remembered.status).toBe("applied")
    expect(seenModes).toEqual(["quick"])
    expect((await Memory.search({ query: "中文回答", limit: 5 })).results).toHaveLength(1)

    await Memory.remember({
      text: "我希望回答先给结论",
      type: "preference",
      intent: "observed",
      source: { createdAt: Date.now(), role: "user" },
    })
    const reflected = await Memory.reflect({ mode: "daily", reason: "test" })

    expect(reflected.changed).toBe(true)
    expect(seenModes).toContain("daily")
    const found = await Memory.search({ query: "回答风格 中文 结论", limit: 5 })
    expect(found.results[0]?.memory).toContain("回答风格")
  })
})

describe("memory agent tools", () => {
  test("tool registry exposes memory tools", async () => {
    await using tmp = await tmpdir()
    const ids = await Instance.provide({ directory: tmp.path, fn: () => ToolRegistry.ids() })
    expect(ids).toContain("memory_search")
    expect(ids).toContain("memory_reflect")
  })

  test("memory_search tool returns markdown memory block ids", async () => {
    await using tmp = await tmpdir()
    Memory.configureForTest({
      globalMemoryDir: path.join(tmp.path, "global-memory"),
      channelRootDir: path.join(tmp.path, "channels"),
      channelID: "latest",
    })
    await Memory.purge()
    await Memory.writeDocumentForTest(
      parseMemoryMarkdown(`# Aether Memory

## Shortcut Directory

## Preferences

### PREF-answer-language
- type: preference
- scope: global
- memory: 用户偏好默认用中文回答。
- confidence: 0.95
- weight: 0.9
- evidence: 用户明确要求默认中文回答。
- updated_at: 2026-05-13T00:00:00.000Z
- status: active

## Facts

## Tasks
`),
    )

    const tool = await MemorySearchTool.init()
    const result = await tool.execute({ query: "中文回答" }, {} as any)
    expect(result.output).toContain("PREF-answer-language")
    expect(result.output).not.toContain("memory_event")

    const reflect = await MemoryReflectTool.init()
    const reflected = await reflect.execute({ mode: "quick" }, {} as any)
    expect(reflected.output).toContain("No changes")
  })
})

describe("memory installer", () => {
  test("registers daily reflect direct action and creates builtin cron job once", async () => {
    await installMemory()
    const job = await Cron.getJob("builtin.memory.daily_reflect")
    expect(job.definition.payload).toEqual({ action: "memory.reflect.daily" })
    expect(job.definition.schedule_value).toBe("0 3 * * *")

    await Cron.updateJob({ id: "builtin.memory.daily_reflect", patch: { schedule_value: "0 4 * * *" } })
    await installMemory()
    const preserved = await Cron.getJob("builtin.memory.daily_reflect")
    expect(preserved.definition.schedule_value).toBe("0 4 * * *")

    await Cron.runJobNow({ id: "builtin.memory.daily_reflect" })
    const runs = await Cron.listRuns({ id: "builtin.memory.daily_reflect", count: 1 })
    expect(runs[0]?.status).toBe("success")
  })
})
