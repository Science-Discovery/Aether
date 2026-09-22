import path from "path"
import { describe, expect, test } from "bun:test"
import { NamedError } from "@opencode-ai/util/error"
import { fileURLToPath } from "url"
import { mkdir, rm } from "node:fs/promises"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Filesystem } from "../../src/util/filesystem"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

Log.init({ print: false })

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.agent-resolution", () => {
  test("unknown agent throws typed error", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const err = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }).then(
          () => undefined,
          (e) => e,
        )
        expect(err).toBeDefined()
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      },
    })
  }, 30000)

  test("unknown agent error includes available agent names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const err = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }).then(
          () => undefined,
          (e) => e,
        )
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      },
    })
  }, 30000)

  test("unknown command throws typed error with available names", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const err = await SessionPrompt.command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        }).then(
          () => undefined,
          (e) => e,
        )
        expect(err).toBeDefined()
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      },
    })
  }, 30000)

  test("skill-scan-paths command returns scan paths without model lookup", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "missing-provider/missing-model",
          },
        },
      },
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".aether", "skills", "demo", "SKILL.md"),
          `---
name: demo
description: Demo skill.
---

# Demo
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.command({
          sessionID: session.id,
          command: "skill-scan-paths",
          arguments: "",
          agent: "build",
          model: "missing-provider/missing-model",
        })
        const text = result.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(result.info.role).toBe("assistant")
        expect(text).toContain("Skill scan paths (low -> high priority)")
        expect(text).toContain(path.join(tmp.path, ".aether", "skills", "**", "SKILL.md"))
        expect(text).not.toContain("{skill,skills}")
      },
    })
  }, 30000)
})

describe("session prompt instance binding", () => {
  const pid = ProviderID.make("binding-local")
  const mid = ModelID.make("tiny")
  const model = { providerID: pid, modelID: mid }

  function line(input: unknown) {
    if (input === "done") return "data: [DONE]\n\n"
    return `data: ${JSON.stringify(input)}\n\n`
  }

  function chunk(input: { text?: string; finish?: string }) {
    return {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: input.text ? { content: input.text } : {},
          ...(input.finish ? { finish_reason: input.finish } : {}),
        },
      ],
    }
  }

  function text(text: string) {
    return new Response([line(chunk({ text })), line(chunk({ finish: "stop" })), line("done")].join(""), {
      headers: { "Content-Type": "text/event-stream" },
    })
  }

  test("prompt runs the session in its own directory's instance, not the caller's", async () => {
    const server = await serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (JSON.stringify(body).includes("Generate a title for this conversation")) return text("Binding Test")
        return text("hello from home")
      },
    })

    const config = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [pid]: {
          name: "Binding Local",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            [mid]: {
              name: "Tiny",
              tool_call: true,
              temperature: true,
              limit: { context: 100, output: 20 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
          options: {
            apiKey: "test-key",
            baseURL: `${server.url.origin}/v1`,
          },
        },
      },
    }

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(config))
        // A linked git worktree resolves to the same project as the main repo,
        // mirroring how sandbox workspaces share one project database.
        const wt = dir + "-wt"
        const proc = Bun.spawnSync(["git", "-C", dir, "worktree", "add", wt, "-b", "wt-binding"])
        if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr))
        await Bun.write(path.join(wt, "opencode.json"), JSON.stringify(config))
        return wt
      },
      dispose: async (dir) => {
        await rm(dir + "-wt", { recursive: true, force: true })
        return dir
      },
    })

    const other = tmp.extra!

    let homeSession: Session.Info | undefined
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        homeSession = await Session.create({})
      },
    })

    await Instance.provide({
      directory: other,
      fn: async () => {
        const result = await SessionPrompt.prompt({
          sessionID: homeSession!.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start" }],
        })

        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("expected assistant message")
        expect(result.info.path.cwd).toBe(tmp.path)
        expect(result.info.path.cwd).not.toBe(other)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Session.remove(homeSession!.id)
      },
    })
  }, 30000)
})

describe("session prompt cross-project binding", () => {
  const pid = ProviderID.make("cross-local")
  const mid = ModelID.make("tiny")
  const model = { providerID: pid, modelID: mid }

  function line(input: unknown) {
    if (input === "done") return "data: [DONE]\n\n"
    return `data: ${JSON.stringify(input)}\n\n`
  }

  function chunk(input: { text?: string; finish?: string }) {
    return {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: input.text ? { content: input.text } : {},
          ...(input.finish ? { finish_reason: input.finish } : {}),
        },
      ],
    }
  }

  function text(text: string) {
    return new Response([line(chunk({ text })), line(chunk({ finish: "stop" })), line("done")].join(""), {
      headers: { "Content-Type": "text/event-stream" },
    })
  }

  function settle<T>(promise: Promise<T>, ms: number) {
    return Promise.race([
      promise.then(
        () => "settled",
        () => "settled",
      ),
      Bun.sleep(ms).then(() => null as null),
    ])
  }

  // Two independent git repositories => two separate projects, each with its
  // own session database. Sessions created in `other` are invisible to
  // `tmp.path`'s project DB.
  async function twoProjects(config: unknown) {
    return tmpdir({
      git: true,
      init: async (dir) => {
        const other = dir + "-other"
        await mkdir(other, { recursive: true })
        for (const args of [
          ["git", "init"],
          ["git", "config", "core.fsmonitor", "false"],
          ["git", "config", "user.email", "test@opencode.test"],
          ["git", "config", "user.name", "Test"],
          ["git", "commit", "--allow-empty", "-m", "root commit"],
        ]) {
          const proc = Bun.spawnSync([...args], { cwd: other })
          if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr))
        }
        await Bun.write(path.join(other, "opencode.json"), JSON.stringify(config))
        return other
      },
      dispose: async (dir) => {
        const other = dir + "-other"
        if (Instance.has(other)) {
          await Instance.provide({ directory: other, fn: () => Instance.dispose() }).catch(() => {})
        }
        Bun.spawnSync(["git", "-C", other, "fsmonitor--daemon", "stop"])
        await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
        return dir
      },
    })
  }

  // The prompt loop fires title/summary work without awaiting it and its
  // projector runs asynchronously; let both settle so teardown does not race
  // them (the summarize promise would otherwise reject unhandled mid-teardown).
  async function drainSessionWork(sessionID: SessionID, directory: string) {
    await Instance.provide({
      directory,
      fn: async () => {
        for (let i = 0; i < 100; i++) {
          const session = await Session.get(sessionID).catch(() => undefined)
          if (session?.summary !== undefined) break
          await Bun.sleep(50)
        }
        await Bun.sleep(300)
      },
    })
  }

  function providerConfig(baseURL: string) {
    return {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [pid]: {
          name: "Cross Local",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            [mid]: {
              name: "Tiny",
              tool_call: true,
              temperature: true,
              limit: { context: 100, output: 20 },
              modalities: { input: ["text"], output: ["text"] },
            },
          },
          options: {
            apiKey: "test-key",
            baseURL,
          },
        },
      },
    }
  }

  test("prompt resolves a session that lives in another project's database", async () => {
    const server = await serve({
      port: 0,
      async fetch() {
        return text("hello from other project")
      },
    })

    await using tmp = await twoProjects(providerConfig(server.url.origin + "/v1"))
    const other = tmp.extra!

    let otherSession: Session.Info | undefined
    await Instance.provide({
      directory: other,
      fn: async () => {
        otherSession = await Session.create({})
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const err = await Session.get(otherSession!.id).then(
          () => undefined,
          (e) => e,
        )
        expect(err).toBeDefined()

        const resolved = await Session.getGlobal(otherSession!.id)
        expect(Filesystem.resolve(resolved.directory)).toBe(Filesystem.resolve(other))

        const result = await SessionPrompt.prompt({
          sessionID: otherSession!.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start" }],
        })
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("expected assistant message")
        expect(result.info.path.cwd).toBe(other)
      },
    })

    server.stop(true)

    await drainSessionWork(otherSession!.id, other)

    await Instance.provide({
      directory: other,
      fn: async () => {
        await Session.remove(otherSession!.id)
      },
    })
  }, 30000)

  test("cancel aborts a run that lives in another project's instance", async () => {
    let started = () => {}
    const started$ = new Promise<void>((resolve) => {
      started = resolve
    })
    const encoder = new TextEncoder()
    const server = await serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (JSON.stringify(body).includes("Generate a title for this conversation")) return text("Cross Test")
        // Hold the stream open forever: only a real abort can end this run.
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(line(chunk({ text: "partial" }))))
            started()
          },
        })
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
      },
    })

    await using tmp = await twoProjects(providerConfig(server.url.origin + "/v1"))
    const other = tmp.extra!

    let otherSession: Session.Info | undefined
    await Instance.provide({
      directory: other,
      fn: async () => {
        otherSession = await Session.create({})
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const run = SessionPrompt.prompt({
          sessionID: otherSession!.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start" }],
        })
        const began = await settle(started$, 15000)
        expect(began).toBe("settled")

        await SessionPrompt.cancel(otherSession!.id)

        const finished = await settle(run, 10000)
        expect(finished).toBe("settled")
      },
    })

    const status = await Instance.provide({
      directory: other,
      fn: () => SessionStatus.get(otherSession!.id),
    })
    expect(status.type).toBe("idle")

    server.stop(true)

    await drainSessionWork(otherSession!.id, other)

    await Instance.provide({
      directory: other,
      fn: async () => {
        await Session.remove(otherSession!.id)
      },
    })
  }, 30000)
})
