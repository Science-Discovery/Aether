import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"
import type { Config } from "../../src/config/config"

describe("memory + user profile backend", () => {
  test("keeps current_project isolation for non-git directories", async () => {
    await using left = await tmpdir()
    await using right = await tmpdir()

    let leftSessionID = ""
    let leftMemoryFile = ""

    await Instance.provide({
      directory: left.path,
      fn: async () => {
        leftMemoryFile = (await Memory.read("memory")).file
        await Memory.write({
          session_id: "left_scope",
          store: "memory",
          action: "add",
          value: "Left workspace specific memory",
          reason: "manual",
        })

        const target = await Session.create({})
        leftSessionID = target.id
        const userID = MessageID.ascending()
        await Session.updateMessage({
          id: userID,
          sessionID: target.id,
          role: "user",
          time: { created: Date.now() - 2_000 },
          agent: "build",
          model: { providerID: ProviderID.opencode, modelID: ModelID.make("gpt-5") },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: target.id,
          messageID: userID,
          type: "text",
          text: "Scope isolation marker alpha123",
        })
      },
    })

    await Instance.provide({
      directory: right.path,
      fn: async () => {
        const rightMemory = await Memory.read("memory")
        expect(rightMemory.file).not.toBe(leftMemoryFile)
        expect(rightMemory.entries).not.toContain("Left workspace specific memory")

        const current = await Session.create({})
        const currentScope = await Memory.sessionSearch({
          session_id: current.id,
          query: "alpha123",
          scope: "current_project",
        })
        expect(currentScope.some((hit) => hit.session_id === leftSessionID)).toBe(false)

        const globalScope = await Memory.sessionSearch({
          session_id: current.id,
          query: "alpha123",
          scope: "global",
        })
        expect(globalScope.some((hit) => hit.session_id === leftSessionID)).toBe(true)
      },
    })
  })

  test("session_search supports multi-keyword matching with session-level merge and recency-first ordering", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const appendText = async (sessionID: SessionID, text: string) => {
          const messageID = MessageID.ascending()
          await Session.updateMessage({
            id: messageID,
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: ProviderID.opencode, modelID: ModelID.make("gpt-5") },
          })
          await Session.updatePart({
            id: PartID.ascending(),
            sessionID,
            messageID,
            type: "text",
            text,
          })
        }

        const older = await Session.create({ title: "Older worklog" })
        await appendText(older.id, "alpha implementation details")
        await appendText(older.id, "beta test follow-ups")

        await new Promise((resolve) => setTimeout(resolve, 5))

        const recent = await Session.create({ title: "Recent checkpoint" })
        await appendText(recent.id, "alpha regression note")

        const current = await Session.create({ title: "Current conversation" })
        const hits = await Memory.sessionSearch({
          session_id: current.id,
          query: "alpha，beta;alpha/、beta|",
          scope: "current_project",
          limit: 10,
        })

        expect(hits.filter((item) => item.session_id === older.id).length).toBe(1)
        expect(hits.filter((item) => item.session_id === recent.id).length).toBe(1)
        expect(hits[0]?.session_id).toBe(recent.id)

        const olderHit = hits.find((item) => item.session_id === older.id)
        expect(olderHit).toBeDefined()
        expect(olderHit?.hits).toBe(2)
        expect(olderHit?.summary).toContain("Matched 2 messages across 2 keywords. Ordered by recency.")
        expect((olderHit?.snippets.length ?? 0) <= 3).toBe(true)
        expect(new Set(olderHit?.snippets ?? []).size).toBe(olderHit?.snippets.length ?? 0)
      },
    })
  })

  test("session_search supports title-only matches", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const target = await Session.create({ title: "Phoenix roadmap planning" })

        const current = await Session.create({ title: "Current conversation" })
        const hits = await Memory.sessionSearch({
          session_id: current.id,
          query: "phoenix",
          scope: "current_project",
        })

        const match = hits.find((item) => item.session_id === target.id)
        expect(match).toBeDefined()
        expect(match?.title).toContain("Phoenix roadmap planning")
        expect(match?.snippets).toEqual([])
        expect(match?.hits).toBe(0)
        expect(match?.summary).toBe("Matched title across 1 keywords. Ordered by recency.")
      },
    })
  })

  test("session_search title-only fallback includes sessions with receipt-only text parts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const target = await Session.create({ title: "Hydra planning receipt-only" })
        const messageID = MessageID.ascending()
        await Session.updateMessage({
          id: messageID,
          sessionID: target.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.opencode, modelID: ModelID.make("gpt-5") },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: target.id,
          messageID,
          type: "text",
          text: "Memory updates: - [MEMORY][add/manual] some receipt text",
          metadata: { memory_receipt: true },
        })

        const current = await Session.create({ title: "Current conversation" })
        const hits = await Memory.sessionSearch({
          session_id: current.id,
          query: "hydra",
          scope: "current_project",
        })

        const match = hits.find((item) => item.session_id === target.id)
        expect(match).toBeDefined()
        expect(match?.title).toContain("Hydra planning receipt-only")
        expect(match?.hits).toBe(0)
        expect(match?.snippets).toEqual([])
        expect(match?.summary).toBe("Matched title across 1 keywords. Ordered by recency.")
      },
    })
  })

  test("enforces strict USER format and inferred constraints", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          user_profile_enabled: true,
          user_profile_include_inferred: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ok = await Memory.write({
          session_id: "user_format_ok",
          store: "user",
          action: "add",
          value: "style[explicit]: 中文，先结论后展开",
          reason: "manual",
        })
        expect(ok.ok).toBe(true)

        const invalidFormat = await Memory.write({
          session_id: "user_format_bad",
          store: "user",
          action: "add",
          value: "用户偏好中文回答",
          reason: "manual",
        })
        expect(invalidFormat.ok).toBe(false)
        expect(invalidFormat.events[0]?.reason).toBe("invalid_user_format")

        const invalidInferred = await Memory.write({
          session_id: "user_format_bad2",
          store: "user",
          action: "add",
          value: "workflow[inferred]: 先确认再实现",
          reason: "manual",
        })
        expect(invalidInferred.ok).toBe(false)
        expect(invalidInferred.events[0]?.reason).toBe("invalid_inferred_type")
      },
    })
  })

  test("disables USER store entirely when user_profile_enabled=false", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          user_profile_enabled: false,
          user_profile_include_inferred: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userStore = await Memory.read("user")
        expect(userStore.enabled).toBe(false)
        expect(userStore.entries).toEqual([])

        const blocked = await Memory.write({
          session_id: "user_disabled",
          store: "user",
          action: "add",
          value: "style[explicit]: 中文",
          reason: "manual",
        })
        expect(blocked.ok).toBe(false)
        expect(blocked.events[0]?.reason).toBe("profile_disabled")

        const memoryWrite = await Memory.write({
          session_id: "memory_still_on",
          store: "memory",
          action: "add",
          value: "Run tests from packages/opencode.",
          reason: "manual",
        })
        expect(memoryWrite.ok).toBe(true)

        const snap = await Memory.snapshot({ session_id: "snapshot_user_off" })
        expect(snap.prompt.includes("<user_profile>")).toBe(false)
      },
    })
  })

  test("direct USER writes do not synthesize profile entries from natural-language paragraphs", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          user_profile_enabled: true,
          user_profile_include_inferred: true,
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

        expect(result.ok).toBe(false)
        expect(result.events[0]?.reason).toBe("invalid_user_format")
      },
    })
  })

  test("applies item limits and rejects writes when store remains full after strong reflection", async () => {
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
          value: `style[explicit]: ${"a".repeat(500)}`,
          reason: "manual",
        })
        expect(longUser.ok).toBe(true)
        const userStore = await Memory.read("user")
        expect(userStore.entries[0]!.length).toBeLessThanOrEqual(200 + "style[explicit]: ".length)

        const longMemory = await Memory.write({
          session_id: "long_memory",
          store: "memory",
          action: "add",
          value: `memory line ${"b".repeat(500)}`,
          reason: "manual",
        })
        expect(longMemory.ok).toBe(true)
        const memoryStoreAfterLong = await Memory.read("memory")
        expect(memoryStoreAfterLong.entries[0]!.length).toBeLessThanOrEqual(300)

        let blocked = false
        for (let i = 0; i < 140; i++) {
          const entry = `capacity-rule-${i} ${"x".repeat(270)}`
          const result = await Memory.write({
            session_id: `capacity_${i}`,
            store: "memory",
            action: "add",
            value: entry,
            reason: "manual",
          })
          if (!result.ok) {
            blocked = true
            expect(result.events.some((event) => event.reason === "capacity_limit")).toBe(true)
            break
          }
        }
        expect(blocked).toBe(true)
      },
    })
  })

  test("normalizes/removes invalid USER entries during startup reflection and emits events", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          ["# USER", "- 用户偏好中文回答", "- style[explicit]: 先结论后展开", "- workflow[inferred]: should be invalid"].join(
            "\n",
          ),
        )

        await Memory.snapshot({ session_id: "startup_reflect" })
        const events = Memory.flush("startup_reflect")
        expect(events.length).toBeGreaterThan(0)

        const userStore = await Memory.read("user")
        expect(userStore.entries.some((entry) => entry.startsWith("workflow[inferred]:"))).toBe(false)
        expect(userStore.invalid_entries ?? 0).toBe(0)
      },
    })
  })

  test("explicit reflection still runs when automatic reflection is disabled", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          memory_reflection_enabled: false,
          user_profile_enabled: true,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(userFile, ["# USER", "- 用户偏好中文回答"].join("\n"))

        const events = await Memory.reflect({
          session_id: "explicit_reflect_when_disabled",
          mode: "strong",
          stores: ["user"],
        })

        expect(events.length).toBeGreaterThan(0)
        expect(events.some((event) => event.store === "user")).toBe(true)

        const userStore = await Memory.read("user")
        expect(userStore.entries.some((entry) => entry.includes("[explicit]:"))).toBe(true)
        expect(userStore.invalid_entries ?? 0).toBe(0)
      },
    })
  })

  test("keeps inferred USER entries on disk when inferred injection is disabled", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          user_profile_enabled: true,
          user_profile_include_inferred: false,
        },
      } as Partial<Config.Info>,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const userFile = (await Memory.read("user")).file
        await Filesystem.write(
          userFile,
          ["# USER", "- style[explicit]: 中文，先结论后展开", "- capability[inferred]: 从近期互动看，用户熟悉量子场论"].join(
            "\n",
          ),
        )

        await Memory.reflect({
          session_id: "reflect_keep_inferred",
          mode: "strong",
          stores: ["user"],
        })

        const userStore = await Memory.read("user")
        expect(userStore.entries.some((entry) => entry.startsWith("capability[inferred]:"))).toBe(true)

        const snap = await Memory.snapshot({ session_id: "snapshot_no_inferred" })
        expect(snap.prompt.includes("Priority order for user-profile guidance:")).toBe(true)
        expect(
          snap.prompt.includes("Follow the user's current-turn instructions first (highest priority)."),
        ).toBe(true)
        expect(
          snap.prompt.includes("FOLLOW explicit USER profile entries below as standing instructions/preferences."),
        ).toBe(true)
        expect(
          snap.prompt.includes(
            "Treat inferred USER profile entries only as soft hints when consistent with both current-turn instructions and explicit profile.",
          ),
        ).toBe(true)
        expect(snap.prompt.includes("style[explicit]: 中文，先结论后展开")).toBe(true)
        expect(snap.prompt.includes("capability[inferred]: 从近期互动看，用户熟悉量子场论")).toBe(false)
      },
    })
  })

  test("snapshot recall policy guides direct memory_write and explicit memory_reflect", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const snap = await Memory.snapshot({ session_id: "snapshot_policy_direct_tools" })
        expect(snap.prompt.includes("call memory_route")).toBe(false)
        expect(snap.prompt.includes("call memory_write directly")).toBe(true)
        expect(snap.prompt.includes("Use memory_reflect proactively")).toBe(true)
        expect(snap.prompt.includes("Priority order for user-profile guidance:")).toBe(true)
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

  test("session_read requires explicit request then allows continuation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const actorSessionID = "actor"
        const explicit = [
          {
            info: { id: "usr_1", role: "user" },
            parts: [{ type: "text", text: "Please show the full session history." }],
          },
        ]
        const nextPage = [
          {
            info: { id: "usr_2", role: "user" },
            parts: [{ type: "text", text: "continue, next page please" }],
          },
        ]
        const unrelated = [
          {
            info: { id: "usr_3", role: "user" },
            parts: [{ type: "text", text: "what next?" }],
          },
        ]

        expect(
          Memory.canSessionRead({
            actor_session_id: actorSessionID,
            target_session_id: "target_a",
            page: 1,
            messages: explicit,
          }),
        ).toBe(true)
        expect(
          Memory.canSessionRead({
            actor_session_id: actorSessionID,
            target_session_id: "target_a",
            page: 2,
            messages: nextPage,
          }),
        ).toBe(true)
        expect(
          Memory.canSessionRead({
            actor_session_id: actorSessionID,
            target_session_id: "target_b",
            page: 2,
            messages: nextPage,
          }),
        ).toBe(false)
        expect(
          Memory.canSessionRead({
            actor_session_id: actorSessionID,
            target_session_id: "target_a",
            page: 1,
            messages: unrelated,
          }),
        ).toBe(false)
      },
    })
  })
})
