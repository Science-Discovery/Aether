import z from "zod"

export namespace NativeQuestion {
  // Aether's explicit no-answer message, not a Codex protocol sentinel.
  export const skipped = "The user chose not to answer this question. This does not grant approval or consent."
  const question = z.object({
    title: z.string().min(1).max(16_000),
    options: z.array(z.string().min(1).max(4_000)).max(64).optional(),
  })
  const answer = z.string().min(1).max(100_000)
  const identity = z.tuple([z.literal("request_user_input_async"), z.string().min(1), z.number().int().min(0).max(31)])
  const response = z.object({ questionItemId: z.string().max(4_000), question: question.shape.title, answer }).strict()
  export const Info = z
    .object({
      thread: z.string().min(1),
      turn: z.string().min(1),
      item: z.string().min(1),
      questions: z.array(question).min(1).max(32),
      state: z.enum(["pending", "sending", "answered", "uncertain", "failed"]),
      answers: z.array(answer).max(32).optional(),
      skipped: z.literal(true).optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeQuestion" })
  export type Info = z.infer<typeof Info>

  export function parse(value: unknown, origin: { thread: string; turn: string }): Info | undefined {
    const parsed = z
      .object({
        type: z.literal("agentMessage"),
        id: Info.shape.item,
        delivery: z.literal("async"),
        questions: z
          .array(question.extend({ options: question.shape.options.nullable() }))
          .min(1)
          .max(32),
      })
      .safeParse(value)
    if (!parsed.success || !origin.thread || !origin.turn) return
    return {
      ...origin,
      item: parsed.data.id,
      questions: parsed.data.questions.map((entry) => ({
        title: entry.title,
        ...(entry.options ? { options: entry.options } : {}),
      })),
      state: "pending",
    }
  }

  export function reply(value: Info, answers: string[]) {
    const parsed = Info.parse(value)
    const values = z.array(answer).length(parsed.questions.length).parse(answers)
    return `<send_user_message_question_reply>\n${JSON.stringify(
      parsed.questions.map((entry, index) => ({
        questionItemId: JSON.stringify(["request_user_input_async", parsed.item, index]),
        question: entry.title,
        answer: values[index],
      })),
    )}\n</send_user_message_question_reply>\n`
  }

  export function responses(text: string): z.infer<typeof response>[] {
    if (text.length > 1_000_000) return []
    const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(
      text,
    )
    if (!match) return []
    try {
      const parsed = z.array(response).min(1).max(32).safeParse(JSON.parse(match[1]))
      if (!parsed.success) return []
      const values = parsed.data.map((entry) => ({
        ...entry,
        questionItemId: JSON.stringify(identity.parse(JSON.parse(entry.questionItemId))),
      }))
      return values
    } catch {
      return []
    }
  }

  export function texts(items: unknown[]) {
    return items.flatMap((item) => {
      const parsed = z
        .object({
          type: z.literal("userMessage"),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
        })
        .safeParse(item)
      return parsed.success
        ? [
            parsed.data.content
              .filter((entry) => entry.type === "text")
              .map((entry) => entry.text ?? "")
              .join("\n"),
          ]
        : []
    })
  }

  export function answered(value: Info, texts: string[]): Info {
    const matches = texts.flatMap(responses)
    const answers = value.questions.map((entry, index) => {
      const key = JSON.stringify(["request_user_input_async", value.item, index])
      const values = matches.filter((item) => item.questionItemId === key && item.question === entry.title)
      return values.length && values.every((item) => item.answer === values[0].answer) ? values[0].answer : undefined
    })
    if (!answers.every((value): value is string => value !== undefined)) return value
    return {
      ...value,
      state: "answered",
      answers,
      skipped: answers.every((answer) => answer === skipped) ? true : undefined,
      error: undefined,
    }
  }
}
