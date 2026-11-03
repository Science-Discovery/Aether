import { expect, test } from "vitest"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { forkable } from "./native-fork"

const user = (id: string): UserMessage => ({
  id,
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "codex",
  model: { providerID: "codex-native", modelID: "model" },
})
const answer = (id: string, parentID: string): AssistantMessage => ({
  id,
  parentID,
  sessionID: "session",
  role: "assistant",
  time: { created: 2, completed: 3 },
  providerID: "codex-native",
  modelID: "model",
  mode: "default",
  agent: "codex",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const part = (id: string, turn: string): Part => ({
  id: `${id}-text`,
  messageID: id,
  sessionID: "session",
  type: "text",
  text: id,
  metadata: { native: { turn } },
})

test("allows only the final response segment of a completed native turn", () => {
  const first = answer("first", "original")
  const last = answer("last", "steer")
  const messages: Message[] = [
    user("original"),
    first,
    user("steer"),
    last,
    user("next"),
    answer("next-answer", "next"),
  ]
  const parts = Object.fromEntries(
    messages.map((message) => [message.id, [part(message.id, message.id.startsWith("next") ? "next-turn" : "turn")]]),
  )
  expect(forkable(first, messages, parts)).toBe(false)
  expect(forkable(last, messages, parts)).toBe(true)
  expect(forkable(first, messages.slice(0, 3), parts)).toBe(false)
})

test("supports live response metadata without projecting the original user message", () => {
  const message = answer("answer", "original")
  expect(forkable(message, [user("original"), message], { answer: [part("answer", "turn")] })).toBe(true)
})

test("requires a completed native response with a known single turn", () => {
  const message = answer("answer", "original")
  const parts = { answer: [part("answer", "turn")] }
  expect(forkable({ ...message, providerID: "aether" }, [message], parts)).toBe(false)
  expect(forkable({ ...message, time: { created: 1 } }, [message], parts)).toBe(false)
  expect(forkable(message, [message], {})).toBe(false)
  expect(forkable(message, [message], { answer: [...parts.answer, part("other", "another-turn")] })).toBe(false)
})
