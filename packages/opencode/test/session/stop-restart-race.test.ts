import path from "path"
import { afterAll, describe, expect, mock, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

Log.init({ print: false })

const realWatchdog = await import("../../src/session/watchdog")
const realRecovery = await import("../../src/session/recovery")

let gate: Promise<void> | undefined
let releaseCleanup: () => void = () => {}
let clearCalls = 0
let repairs = 0

const realClear = realWatchdog.SessionWatchdog.clear
const realRepair = realRecovery.SessionRecovery.repairSession

// The first clear in the scenario below belongs to the stale run's exit
// cleanup; park it there so the test can interleave a newer prompt before
// the cleanup resumes. Every other call passes through untouched.
const clear = mock((sessionID: Parameters<typeof realClear>[0]) => {
  clearCalls++
  if (clearCalls === 1 && gate) return gate.then(() => realClear(sessionID))
  return realClear(sessionID)
})
const repair = mock((sessionID: Parameters<typeof realRepair>[0]) => {
  repairs++
  return realRepair(sessionID)
})

mock.module("../../src/session/watchdog", () => ({
  SessionWatchdog: {
    ...realWatchdog.SessionWatchdog,
    clear,
  },
}))

mock.module("../../src/session/recovery", () => ({
  SessionRecovery: {
    ...realRecovery.SessionRecovery,
    repairSession: repair,
  },
}))

const { SessionPrompt } = await import("../../src/session/prompt")

afterAll(() => {
  releaseCleanup()
  gate = undefined
})

namespace harness {
  export const pid = ProviderID.make("race-local")
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

  // Chat request 2 (the newer prompt) is held until the test releases it, so
  // the newer run is provably parked inside its LLM call during the
  // interleaving. Title generation is answered immediately.
  export async function llm() {
    let chats = 0
    let hold: Promise<void> | undefined
    let releaseHold = () => {}
    const server = await serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (JSON.stringify(body).includes("Generate a title for this conversation")) return sse("Race Test")
        chats++
        if (chats === 2 && hold) await hold
        return sse("ok")
      },
    })
    return {
      server,
      arm() {
        hold = new Promise<void>((resolve) => {
          releaseHold = resolve
        })
      },
      release() {
        releaseHold()
      },
      get chats() {
        return chats
      },
    }
  }

  export function providerConfig(origin: string) {
    return {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [pid]: {
          name: "Race Local",
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
}

describe("stop then immediate prompt", () => {
  test("stale run's exit cleanup does not abort or repair a newer prompt", async () => {
    const llm = await harness.llm()
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(llm.server.url.origin)))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        clearCalls = 0
        repairs = 0
        gate = new Promise<void>((resolve) => {
          releaseCleanup = resolve
        })

        const stale = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "stale run" }],
        })

        // parked inside its exit cleanup, holding the busy claim
        for (let i = 0; i < 250 && clearCalls < 1; i++) await sleep(20)
        expect(clearCalls).toBe(1)

        // user hits stop: the claim is dropped while the stale cleanup is paused
        await SessionPrompt.cancel(session.id)

        llm.arm()
        const newer = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "newer run" }],
        })
        for (let i = 0; i < 250 && llm.chats < 2; i++) await sleep(20)
        expect(llm.chats).toBe(2)

        expect(await SessionStatus.get(session.id)).toEqual({ type: "busy" })

        releaseCleanup()
        const staleResult = await stale
        expect(staleResult.info.role).toBe("assistant")

        // the stale cleanup must have bailed out: no repair of the newer
        // run's in-flight message, no idle overwrite while it is active
        expect(await SessionStatus.get(session.id)).toEqual({ type: "busy" })
        expect(repairs).toBe(1)

        llm.release()
        const newerResult = await newer
        expect(newerResult.info.role).toBe("assistant")
        if (newerResult.info.role === "assistant") expect(newerResult.info.error).toBeUndefined()

        const again = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "after" }],
        })
        expect(again.info.role).toBe("assistant")

        await Session.remove(session.id)
      },
    })
    llm.server.stop(true)
  }, 60000)
})
