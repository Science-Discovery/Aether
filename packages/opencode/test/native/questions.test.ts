import { expect, test } from "bun:test"
import { NativeQuestion } from "../../src/native/questions"

const origin = { thread: "thread", turn: "turn" }
const item = {
  id: "call_fixture",
  type: "agentMessage",
  text: "Choose a style and destination",
  delivery: "async",
  questions: [
    { title: "Style?", options: ["Short", "Detailed"] },
    { title: "Destination?", options: null },
  ],
}
const question = () => NativeQuestion.parse(item, origin)!

test("only structured async messages become questions and nullable options normalize", () => {
  expect(question()).toEqual({
    ...origin,
    item: item.id,
    questions: [{ title: "Style?", options: ["Short", "Detailed"] }, { title: "Destination?" }],
    state: "pending",
  })
  expect(NativeQuestion.parse({ ...item, delivery: undefined }, origin)).toBeUndefined()
  expect(NativeQuestion.parse({ ...item, questions: [] }, origin)).toBeUndefined()
  expect(NativeQuestion.parse({ ...item, questions: [{ title: "" }] }, origin)).toBeUndefined()
  expect(NativeQuestion.parse({ ...item, questions: Array(33).fill(item.questions[0]) }, origin)).toBeUndefined()
  expect(NativeQuestion.parse(item, { ...origin, thread: "" })).toBeUndefined()
})

test("replies round trip the observed Desktop wrapper with stable item and question index", () => {
  const text = NativeQuestion.reply(question(), ["Short", "new directory"])
  expect(NativeQuestion.responses(text)).toEqual([
    { questionItemId: '["request_user_input_async","call_fixture",0]', question: "Style?", answer: "Short" },
    {
      questionItemId: '["request_user_input_async","call_fixture",1]',
      question: "Destination?",
      answer: "new directory",
    },
  ])
  expect(NativeQuestion.answered(question(), [text])).toMatchObject({
    state: "answered",
    answers: ["Short", "new directory"],
  })
  expect(() => NativeQuestion.reply(question(), ["Short"])).toThrow()
  expect(() => NativeQuestion.reply(question(), ["Short", ""])).toThrow()
})

test("only a complete group of Aether's exact no-answer responses rebuilds as skipped", () => {
  const answers = item.questions.map(() => NativeQuestion.skipped)
  const text = NativeQuestion.reply(question(), answers)
  expect(NativeQuestion.responses(text)).toEqual([
    { questionItemId: '["request_user_input_async","call_fixture",0]', question: "Style?", answer: answers[0] },
    { questionItemId: '["request_user_input_async","call_fixture",1]', question: "Destination?", answer: answers[1] },
  ])
  expect(NativeQuestion.answered(question(), [text])).toMatchObject({ state: "answered", answers, skipped: true })
  for (const values of [[NativeQuestion.skipped, "folder"], answers.map((answer) => `${answer} Please continue.`)]) {
    const result = NativeQuestion.answered(question(), [NativeQuestion.reply(question(), values)])
    expect(result.state).toBe("answered")
    expect(result.skipped).toBeUndefined()
  }
  expect(NativeQuestion.answered(question(), [NativeQuestion.skipped]).state).toBe("pending")
})

test("malformed or quoted reply envelopes and non-question tools never confirm answers", () => {
  const text = NativeQuestion.reply(question(), ["Short", "folder"])
  for (const value of [
    `Example: ${text}`,
    `${text} trailing text`,
    `\`\`\`\n${text}\`\`\``,
    text.replace("request_user_input_async", "another_tool"),
    text.replace('"question":', '"extra":true,"question":'),
    "<send_user_message_question_reply>not json</send_user_message_question_reply>",
  ]) {
    expect(NativeQuestion.responses(value)).toEqual([])
    expect(NativeQuestion.answered(question(), [value]).state).toBe("pending")
  }
})

test("matching requires every index, the exact title, and unambiguous answers", () => {
  const text = NativeQuestion.reply(question(), ["Short", "folder"])
  expect(NativeQuestion.answered(question(), [text.replace("call_fixture", "other")]).state).toBe("pending")
  expect(NativeQuestion.answered(question(), [text.replace("Style?", "Another title")]).state).toBe("pending")
  const rows = NativeQuestion.responses(text)
  const wrap = (value: unknown) =>
    `<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`
  expect(NativeQuestion.answered(question(), [wrap(rows.slice(0, 1))]).state).toBe("pending")
  expect(NativeQuestion.answered(question(), [text, wrap([{ ...rows[0], answer: "Detailed" }])]).state).toBe("pending")
  expect(NativeQuestion.answered(question(), [text, text]).state).toBe("answered")
  expect(
    NativeQuestion.answered(question(), [
      wrap(
        rows.map((entry) => ({ ...entry, questionItemId: JSON.stringify(JSON.parse(entry.questionItemId), null, 2) })),
      ),
    ]).state,
  ).toBe("answered")
})
