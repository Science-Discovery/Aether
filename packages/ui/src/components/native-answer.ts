/** Display only: keep the stored Codex reply marker unchanged. */
export function nativeAnswer(text: string): string | undefined {
  if (text.length > 1_000_000) return
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(
    text,
  )
  if (!match) return
  try {
    const values: unknown = JSON.parse(match[1])
    if (!Array.isArray(values) || !values.length || values.length > 32) return
    const rows = values.flatMap((value: unknown, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return []
      if (Object.keys(value).length !== 3) return []
      if (
        !("questionItemId" in value) ||
        typeof value.questionItemId !== "string" ||
        value.questionItemId.length > 4_000
      )
        return []
      if (
        !("question" in value) ||
        typeof value.question !== "string" ||
        !value.question ||
        value.question.length > 16_000
      )
        return []
      if (!("answer" in value) || typeof value.answer !== "string" || !value.answer || value.answer.length > 100_000)
        return []
      const identity: unknown = JSON.parse(value.questionItemId)
      if (
        !Array.isArray(identity) ||
        identity.length !== 3 ||
        identity[0] !== "request_user_input_async" ||
        typeof identity[1] !== "string" ||
        !identity[1] ||
        identity[2] !== index
      )
        return []
      return [{ item: identity[1], question: value.question, answer: value.answer }]
    })
    if (rows.length !== values.length || rows.some((row) => row.item !== rows[0].item)) return
    return rows.map((row) => `${row.question}: ${row.answer}`).join("\n\n")
  } catch {
    return
  }
}
