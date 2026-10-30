import { base64Encode } from "@opencode-ai/util/encode"

type Submission = { url: string; directory: string; session: string; thread: string; item: string }
const listeners = new Set<(value: Submission) => void>()

export const nativeQuestionAnchor = (session: string, question: { thread: string; item: string }) =>
  `native-question-${base64Encode(JSON.stringify([session, question.thread, question.item]))}`

export function submittedNativeQuestion(value: Submission) {
  listeners.forEach((listener) => listener(value))
}

export function observeNativeQuestion(listener: (value: Submission) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
