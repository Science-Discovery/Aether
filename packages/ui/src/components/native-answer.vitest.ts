import { describe, expect, test } from "vitest"
import { nativeAnswer } from "./native-answer"

const entry = { questionItemId: '["request_user_input_async","item",0]', question: "Which method?", answer: "A" }
const wrap = (value: unknown) =>
  `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`

describe("native answer summaries", () => {
  test("summarizes only a complete structured reply", () => {
    expect(nativeAnswer(wrap([entry]))).toBe("Which method?: A")
    expect(
      nativeAnswer(wrap([entry, { ...entry, questionItemId: '["request_user_input_async","item",1]', answer: "B" }])),
    ).toBe("Which method?: A\n\nWhich method?: B")
  })
  test("preserves malformed, partial, unrelated, or expanded wrappers", () => {
    for (const value of [
      "normal text",
      `${wrap([entry])} extra`,
      wrap([]),
      wrap([{ ...entry, extra: true }]),
      wrap([{ ...entry, answer: 3 }]),
      wrap([{ ...entry, questionItemId: "invalid" }]),
      wrap([{ ...entry, questionItemId: '["different_tool","item",0]' }]),
      wrap([{ ...entry, questionItemId: '["request_user_input_async","item",1]' }]),
    ])
      expect(nativeAnswer(value)).toBeUndefined()
  })
})
