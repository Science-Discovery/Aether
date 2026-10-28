import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { getSessionContextMetrics } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContextMetrics", () => {
  test("computes totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.totalCost).toBe(1.75)
    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.total).toBe(500)
    expect(metrics.context?.usage).toBe(50)
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message.id).toBe("a1")
    expect(two.context?.message.id).toBe("a2")
    expect(two.totalCost).toBe(1)
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.totalCost).toBe(0)
    expect(metrics.context).toBeUndefined()
  })

  test("native context uses the last reported input and window instead of provider metadata or turn totals", () => {
    const message = {
      ...assistant("native", { input: 1000, output: 200, reasoning: 150, read: 500, write: 0 }, 0, "codex-native"),
      nativeUsage: { input: 400, total: 450, contextWindow: 2000, updatedAt: 1 },
    } as Message
    const metrics = getSessionContextMetrics(
      [message],
      [{ id: "codex-native", models: { "gpt-4.1": { limit: { context: 10 } } } }],
    )
    expect(metrics.native).toBe(true)
    expect(metrics.totalCost).toBeNull()
    expect(metrics.context).toMatchObject({ total: 1700, limit: 2000, used: 400, usage: 20, reasoning: 150 })
    expect(metrics.context?.provider).toBeUndefined()
  })

  test("native totals use the reported total without counting reasoning twice", () => {
    const message = assistant(
      "native",
      { input: 100, output: 50, reasoning: 30, read: 20, write: 0 },
      0,
      "codex-native",
    )
    if (message.role !== "assistant") throw new Error("Expected assistant fixture")
    message.tokens.total = 170
    expect(getSessionContextMetrics([message]).context?.total).toBe(170)
    delete message.tokens.total
    expect(getSessionContextMetrics([message]).context?.total).toBe(170)
  })

  test("native history without context evidence remains unknown, including an empty native session", () => {
    const message = assistant(
      "native",
      { input: 100, output: 50, reasoning: 30, read: 20, write: 0 },
      0,
      "codex-native",
    )
    const metrics = getSessionContextMetrics(
      [message],
      [{ id: "codex-native", models: { "gpt-4.1": { limit: { context: 1000 } } } }],
    )
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
    expect(metrics.totalCost).toBeNull()
    expect(getSessionContextMetrics([], [], true)).toEqual({ native: true, totalCost: null, context: undefined })
  })

  test("a known zero last input is different from a missing context measurement", () => {
    const message = {
      ...assistant("native", { input: 100, output: 50, reasoning: 30, read: 20, write: 0 }, 0, "codex-native"),
      nativeUsage: { input: 0, contextWindow: 2000, updatedAt: 1 },
    } as Message
    expect(getSessionContextMetrics([message]).context?.usage).toBe(0)
  })
})
