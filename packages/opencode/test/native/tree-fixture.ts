import { createInterface } from "node:readline"

const threads = new Map<string, Record<string, unknown>>()
const pending = new Map<string, number>()
const interrupts: unknown[] = []
let reads = 0
let lists = 0
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")

for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line) as {
    id: number | string
    method?: string
    params?: Record<string, unknown>
    result?: unknown
    error?: unknown
  }
  if (!value.method) {
    const id = pending.get(String(value.id))
    if (id !== undefined) {
      pending.delete(String(value.id))
      write({ id, ...(value.error ? { error: value.error } : { result: value.result }) })
    }
    continue
  }
  const params = value.params ?? {}
  const respond = (result: unknown) => write({ id: value.id, result })
  if (value.method === "fixture/thread") {
    threads.set(String(params.id), params)
    respond({})
    continue
  }
  if (value.method === "fixture/emit") {
    write({ method: params.method, params: params.params })
    respond({})
    continue
  }
  if (value.method === "fixture/ask") {
    const id = crypto.randomUUID()
    pending.set(id, Number(value.id))
    write({ id, method: params.method, params: params.params })
    continue
  }
  if (value.method === "fixture/interrupts") {
    respond(interrupts)
    continue
  }
  if (value.method === "fixture/reads") {
    respond(reads)
    continue
  }
  if (value.method === "fixture/lists") {
    respond(lists)
    continue
  }
  if (value.method === "thread/loaded/list") {
    respond({ data: [...threads.keys()], nextCursor: null })
    continue
  }
  if (value.method === "thread/turns/list") {
    lists++
    write({ id: value.id, error: { code: -32603, message: "list_turns is not supported yet" } })
    continue
  }
  if (value.method === "thread/read") {
    reads++
    const thread = threads.get(String(params.threadId))
    if (!thread) {
      write({ id: value.id, error: { code: -32000, message: "Thread unavailable" } })
      continue
    }
    if (params.includeTurns === true && thread.historyUnsupported === true) {
      write({ id: value.id, error: { code: -32603, message: "list_turns is not supported yet" } })
      continue
    }
    const result = { thread }
    if (typeof thread.delay === "number") setTimeout(() => respond(result), thread.delay)
    else respond(result)
    continue
  }
  if (value.method === "turn/interrupt") {
    interrupts.push(params)
    respond({})
    continue
  }
  write({ id: value.id, error: { code: -32601, message: "Unknown fixture method" } })
}
