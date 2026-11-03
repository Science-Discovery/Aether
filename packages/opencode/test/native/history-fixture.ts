import { createInterface } from "node:readline"
import { isDeepStrictEqual } from "node:util"

const steps = (await Bun.file(process.argv[2]).json()) as {
  method: string
  params?: Record<string, unknown>
  result?: unknown
  error?: string
}[]
const calls: string[] = []
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
  if (input.method === "inspect") {
    send({ id: input.id, result: { calls, remaining: steps.length } })
    continue
  }
  calls.push(input.method)
  const step = steps.shift()
  if (
    !step ||
    input.method !== step.method ||
    Object.entries(step.params ?? {}).some(([key, value]) => !isDeepStrictEqual(input.params?.[key], value))
  ) {
    send({ id: input.id, error: { code: -32602, message: `Unexpected request: ${JSON.stringify(input)}` } })
    continue
  }
  send(
    step.error ? { id: input.id, error: { code: -32601, message: step.error } } : { id: input.id, result: step.result },
  )
}
