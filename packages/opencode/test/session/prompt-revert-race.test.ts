import path from "path"
import { describe, expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

Log.init({ print: false })

namespace harness {
  export const pid = ProviderID.make("revert-race-local")
  export const mid = ModelID.make("tiny")
  export const model = { providerID: pid, modelID: mid }

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

  function sse(text: string) {
    return new Response([line(chunk({ text })), line(chunk({ finish: "stop" })), line("done")].join(""), {
      headers: { "Content-Type": "text/event-stream" },
    })
  }

  export function llm(delay: number) {
    return serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith("/embeddings")) {
          await sleep(delay)
          return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] })
        }
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (JSON.stringify(body).includes("Generate a title for this conversation")) return sse("Revert Race")
        await sleep(delay)
        return sse("ok")
      },
    })
  }

  export function providerConfig(origin: string) {
    return {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [pid]: {
          name: "Revert Race Local",
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
            baseURL: `${origin}/v1`,
          },
        },
      },
    }
  }

  export async function seedTurn(sessionID: SessionID, text: string) {
    const user = await Session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model,
      time: { created: Date.now() },
    })
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID,
      type: "text",
      text,
    })
    const assistant: MessageV2.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      parentID: user.id,
      mode: "build",
      agent: "build",
      modelID: mid,
      providerID: pid,
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: Instance.directory, root: Instance.worktree },
      time: { created: Date.now() },
      finish: "stop",
    }
    await Session.updateMessage(assistant)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID,
      type: "text",
      text: "reply",
    })
    return { user, assistant }
  }
}

async function seedSession() {
  const session = await Session.create({})
  const first = await harness.seedTurn(session.id, "first")
  const second = await harness.seedTurn(session.id, "second")
  return { session, first, second }
}

describe("session.prompt revert race", () => {
  test("prompt after a completed revert clears the marker and removes reverted messages", async () => {
    const server = await harness.llm(200)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(server.url.origin)))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, second } = await seedSession()

        await SessionRevert.revert({ sessionID: session.id, messageID: second.user.id })
        const marked = await Session.get(session.id)
        expect(marked.revert?.messageID).toBe(second.user.id)

        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "resent" }],
        })

        const after = await Session.get(session.id)
        expect(after.revert).toBeUndefined()

        const msgs = await Session.messages({ sessionID: session.id })
        const ids = msgs.map((m) => m.info.id)
        expect(ids).not.toContain(second.user.id)
        expect(ids).not.toContain(second.assistant.id)
        const users = msgs.filter((m) => m.info.role === "user")
        expect(users.length).toBe(2)
        const lastUser = users.at(-1)!
        expect(lastUser.parts.some((part) => part.type === "text" && part.text === "resent")).toBe(true)
        expect(msgs.filter((m) => m.info.role === "assistant").length).toBe(2)

        await Session.remove(session.id)
      },
    })
    server.stop(true)
  }, 30000)

  test("prompt racing an in-flight revert never leaves a residual marker", async () => {
    const server = await harness.llm(100)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(server.url.origin)))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (let round = 0; round < 5; round++) {
          const { session, first, second } = await seedSession()

          const revertOutcome = SessionRevert.revert({ sessionID: session.id, messageID: second.user.id }).then(
            () => "reverted" as const,
            (err) => {
              if (err instanceof Session.BusyError) return "busy" as const
              throw err
            },
          )
          const promptOutcome = SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: harness.model,
            parts: [{ type: "text", text: "resent" }],
          }).then(() => "prompted" as const)

          const [revert] = await Promise.all([revertOutcome, promptOutcome])

          const after = await Session.get(session.id)
          expect(after.revert).toBeUndefined()

          const msgs = await Session.messages({ sessionID: session.id })
          const userIds = msgs.filter((m) => m.info.role === "user").map((m) => m.info.id)
          if (revert === "reverted") {
            expect(userIds).not.toContain(second.user.id)
            expect(userIds).toContain(first.user.id)
            expect(msgs.filter((m) => m.info.role === "user").length).toBe(2)
          } else {
            expect(userIds).toContain(first.user.id)
            expect(userIds).toContain(second.user.id)
            expect(msgs.filter((m) => m.info.role === "user").length).toBe(3)
          }

          await Session.remove(session.id)
          await sleep(20)
        }
      },
    })
    server.stop(true)
  }, 60000)

  test("shell racing an in-flight revert never leaves a residual marker", async () => {
    const server = await harness.llm(100)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(server.url.origin)))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, second } = await seedSession()

        const revertOutcome = SessionRevert.revert({ sessionID: session.id, messageID: second.user.id }).then(
          () => "reverted" as const,
          (err) => {
            if (err instanceof Session.BusyError) return "busy" as const
            throw err
          },
        )
        const shellOutcome = SessionPrompt.shell({
          sessionID: session.id,
          agent: "build",
          command: "echo hello",
        }).then(() => "shelled" as const)

        const [revert] = await Promise.all([revertOutcome, shellOutcome])

        const after = await Session.get(session.id)
        expect(after.revert).toBeUndefined()

        if (revert === "reverted") {
          const msgs = await Session.messages({ sessionID: session.id })
          const ids = msgs.map((m) => m.info.id)
          expect(ids).not.toContain(second.user.id)
          expect(ids).not.toContain(second.assistant.id)
        }

        await Session.remove(session.id)
      },
    })
    server.stop(true)
  }, 30000)
})
