import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import type { NamedError } from "@opencode-ai/util/error"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRetry } from "../../src/session/retry"
import { SessionWatchdog } from "../../src/session/watchdog"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

const pid = ProviderID.make("alibaba-cn")
const mid = ModelID.make("glm-5.2")
const model = { providerID: pid, modelID: mid }
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  await Memory.stop()
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

function apiError(input: {
  message?: string
  statusCode?: number
  isRetryable?: boolean
  responseBody?: string
}): ReturnType<NamedError["toObject"]> {
  return new MessageV2.APIError({
    message: input.message ?? "boom",
    isRetryable: input.isRetryable ?? false,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    ...(input.responseBody !== undefined ? { responseBody: input.responseBody } : {}),
  }).toObject()
}

describe("session.retry.connection", () => {
  test("retries provider-marked retryable errors", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", kind: "conn" },
    }).toObject()
    expect(SessionRetry.connection(error)).toBeDefined()
  })

  test("retries transport status codes regardless of the retryable flag", () => {
    for (const status of [402, 408, 429, 500, 502, 503, 504, 529]) {
      expect(SessionRetry.connection(apiError({ statusCode: status, message: "upstream" }))).toBeDefined()
    }
  })

  test("retries billing and quota failures hidden behind non-retryable flags", () => {
    expect(
      SessionRetry.connection(
        apiError({
          message: "Payment required",
          statusCode: 402,
          responseBody: '{"error":{"code":"insufficient_quota"}}',
        }),
      ),
    ).toBeDefined()
    expect(
      SessionRetry.connection(
        apiError({ message: "Your credit balance is too low to access the API", isRetryable: false }),
      ),
    ).toBeDefined()
    expect(
      SessionRetry.connection(apiError({ message: "boom", isRetryable: false, responseBody: "FreeUsageLimitError" })),
    ).toBeDefined()
  })

  test("does not retry context overflow or user aborts", () => {
    const overflow = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()
    expect(SessionRetry.connection(overflow)).toBeUndefined()
    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject()
    expect(SessionRetry.connection(aborted)).toBeUndefined()
  })

  test("does not retry auth or config failures", () => {
    expect(SessionRetry.connection(apiError({ message: "invalid api key", statusCode: 401 }))).toBeUndefined()
    expect(SessionRetry.connection(apiError({ message: "model not found", statusCode: 404 }))).toBeUndefined()
    expect(SessionRetry.connection(apiError({ message: "invalid request", statusCode: 400 }))).toBeUndefined()
    const auth = new MessageV2.AuthError({ providerID: pid, message: "missing api key" }).toObject()
    expect(SessionRetry.connection(auth)).toBeUndefined()
    expect(
      SessionRetry.connection(apiError({ message: "upgrade to Plus to continue", isRetryable: false })),
    ).toBeUndefined()
  })

  test("does not retry 4xx errors mislabeled as retryable by the provider", () => {
    expect(SessionRetry.connection(apiError({ message: "boom", statusCode: 400, isRetryable: true }))).toBeUndefined()
    expect(SessionRetry.connection(apiError({ message: "boom", statusCode: 404, isRetryable: true }))).toBeUndefined()
    expect(SessionRetry.connection(apiError({ message: "boom", statusCode: 422, isRetryable: true }))).toBeUndefined()
  })

  test("does not park unknown JSON errors from the retryable catch-all", () => {
    const unknown = {
      data: { message: JSON.stringify({ code: "something_unheard_of" }) },
    } as ReturnType<NamedError["toObject"]>
    expect(SessionRetry.retryable(unknown)).toBeDefined()
    expect(SessionRetry.connection(unknown)).toBeUndefined()
  })

  test("keeps legacy retryable heuristics for exotic error shapes", () => {
    const wrapped = { data: { message: "socket hang up" } } as ReturnType<NamedError["toObject"]>
    expect(SessionRetry.connection(wrapped)).toBe("Connection error")
    const unrelated = { data: { message: "model refused the request" } } as ReturnType<NamedError["toObject"]>
    expect(SessionRetry.connection(unrelated)).toBeUndefined()
  })
})

describe("session.retry.longWindow", () => {
  const HOUR = SessionRetry.WINDOW_HIGH
  const TOTAL = SessionRetry.WINDOW_TOTAL

  test("retries every minute during the first hour", () => {
    expect(SessionRetry.longDelay(0)).toBe(60_000)
    expect(SessionRetry.longDelay(60_000)).toBe(60_000)
    expect(SessionRetry.longDelay(HOUR - 1)).toBe(60_000)
  })

  test("drops to hourly retries after the first hour", () => {
    expect(SessionRetry.longDelay(HOUR)).toBe(3_600_000)
    expect(SessionRetry.longDelay(HOUR + 1)).toBe(3_600_000)
    expect(SessionRetry.longDelay(5 * 24 * HOUR)).toBe(3_600_000)
  })

  test("gives up after 10 days", () => {
    expect(SessionRetry.deadline(1000)).toBe(1000 + TOTAL)
    expect(SessionRetry.expired(1000, 1000 + TOTAL - 1)).toBe(false)
    expect(SessionRetry.expired(1000, 1000 + TOTAL)).toBe(true)
  })

  test("simulated 10-day schedule: minute cadence, then hourly, never past the deadline", () => {
    const started = 1_700_000_000_000
    const fires: number[] = []
    let now = started
    while (!SessionRetry.expired(started, now)) {
      fires.push(now)
      now += SessionRetry.longDelay(now - started)
    }
    expect(fires.length).toBeGreaterThan(0)
    expect(fires[0]).toBe(started)
    const deadline = SessionRetry.deadline(started)
    for (const fire of fires) expect(fire).toBeLessThan(deadline)
    for (let i = 1; i < fires.length; i++) {
      const gap = fires[i] - fires[i - 1]
      if (fires[i - 1] >= started + HOUR) expect(gap).toBe(3_600_000)
      else expect(gap).toBe(60_000)
    }
    const firstHour = fires.filter((fire) => fire < started + HOUR)
    expect(firstHour.length).toBe(60)
    const rest = fires.length - firstHour.length
    expect(rest).toBeGreaterThan(200)
    expect(rest).toBeLessThan(260)
  })
})

function line(input: unknown) {
  if (input === "done") return "data: [DONE]\n\n"
  return `data: ${JSON.stringify(input)}\n\n`
}

function chunk(delta: Record<string, unknown>, finish?: "stop") {
  return {
    id: "chatcmpl-glm-52",
    object: "chat.completion.chunk",
    choices: [
      {
        delta,
        ...(finish ? { finish_reason: finish } : {}),
      },
    ],
    ...(finish
      ? {
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      : {}),
  }
}

function stream(text: string) {
  const body = [
    line(chunk({ role: "assistant" })),
    line(chunk({ content: text })),
    line(chunk({}, "stop")),
    line("done"),
  ].join("")
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

describe("session.watchdog recovery loop", () => {
  test("parks the task on upstream outage and resumes automatically on recovery", async () => {
    let healthy = false
    let hits = 0
    const server = await serve({
      port: 0,
      async fetch(req) {
        hits++
        await req.json().catch(() => undefined)
        if (!healthy) {
          return new Response(
            JSON.stringify({ error: { message: "Insufficient quota: check plan and billing details" } }),
            {
              status: 429,
              headers: { "Content-Type": "application/json", "retry-after-ms": "1" },
            },
          )
        }
        return stream("second answer")
      },
    })
    servers.push(server)

    const tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [pid],
            provider: {
              [pid]: {
                npm: "@ai-sdk/openai-compatible",
                models: {
                  [mid]: {
                    name: "GLM-5.2",
                    tool_call: true,
                    temperature: true,
                    limit: { context: 1_000_000, output: 131_072 },
                    modalities: { input: ["text"], output: ["text"] },
                  },
                },
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })
    await using _tmp = tmp

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "outage" })

        // Upstream is down: the prompt returns instead of dying or hanging,
        // the turn is parked on the watchdog, and the session stays marked
        // as retrying.
        const parked = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "Answer briefly." }],
        })
        expect(hits).toBeGreaterThanOrEqual(1)
        expect((parked.info as MessageV2.Assistant).error).toBeDefined()
        const parkedStatus = await SessionStatus.get(session.id)
        expect(parkedStatus.type).toBe("retry")
        expect(parkedStatus.type === "retry" && parkedStatus.attempt).toBeGreaterThanOrEqual(1)
        expect(await SessionWatchdog.pending(session.id)).toBe(true)

        // A new user message while still parked starts a new task: the 10-day
        // window anchor resets instead of inheriting the old turn's window.
        const parked2 = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "Try again please." }],
        })
        expect((parked2.info as MessageV2.Assistant).error).toBeDefined()
        const parkedStatus2 = await SessionStatus.get(session.id)
        expect(parkedStatus2.type).toBe("retry")
        expect(parkedStatus2.type === "retry" && parkedStatus2.attempt).toBe(1)

        // Upstream recovers: the wake reruns the loop and the turn completes
        // without any user interaction.
        healthy = true
        await SessionWatchdog.fire(session.id)

        const doneStatus = await SessionStatus.get(session.id)
        expect(doneStatus.type).toBe("idle")
        expect(await SessionWatchdog.pending(session.id)).toBe(false)
        const msgs = await Session.messages({ sessionID: session.id })
        const texts = msgs.flatMap((msg) => msg.parts).filter((part) => part.type === "text")
        expect(texts.some((part) => part.type === "text" && part.text === "second answer")).toBe(true)

        await SessionWatchdog.clear(session.id)
        await Instance.dispose()
      },
    })
  })
})
