import { describe, expect, test } from "bun:test"
import { errorText, zombieTargets, type Notification } from "./notification-helpers"

const error = (overrides: Partial<Notification> = {}): Notification => ({
  type: "error",
  directory: "C:/repo",
  session: "ses_1",
  time: 100,
  viewed: false,
  error: { name: "UnknownError", data: { message: "no such table: session_retry" } },
  ...overrides,
})

describe("errorText", () => {
  test("joins name and message", () => {
    expect(errorText(error())).toBe("UnknownError: no such table: session_retry")
  })

  test("string error passes through", () => {
    expect(errorText(error({ error: "boom" } as unknown as Notification))).toBe("boom")
  })

  test("falls back to name without message", () => {
    expect(errorText(error({ error: { name: "MessageOutputLengthError", data: {} } }))).toBe("MessageOutputLengthError")
  })

  test("empty for missing error", () => {
    expect(errorText(error({ error: undefined }))).toBe("")
  })

  test("empty for non-error notification", () => {
    expect(errorText({ type: "turn-complete", directory: "C:/repo", time: 1, viewed: false })).toBe("")
  })

  test("clamps long messages", () => {
    expect(errorText(error({ error: { name: "UnknownError", data: { message: "x".repeat(200) } } })).length).toBe(80)
  })
})

describe("zombieTargets", () => {
  test("groups unseen session-bound notifications by directory", () => {
    const groups = zombieTargets([
      error(),
      error({ session: "ses_2", time: 200 }),
      error({ directory: "C:/other", session: "ses_1" }),
    ])
    expect(groups.get("C:/repo")).toEqual(new Set(["ses_1", "ses_2"]))
    expect(groups.get("C:/other")).toEqual(new Set(["ses_1"]))
    expect(groups.size).toBe(2)
  })

  test("skips viewed, global, and anonymous notifications", () => {
    const groups = zombieTargets([
      error({ viewed: true }),
      error({ session: "global" }),
      error({ session: undefined }),
      error({ directory: undefined }),
    ])
    expect(groups.size).toBe(0)
  })
})
