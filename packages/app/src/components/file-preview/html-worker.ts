import { htmlConvert } from "./html-convert"
import type { HtmlRequest, HtmlResponse } from "./html-bridge"

const pending = new Map<
  number,
  { resolve: (file: { data: ArrayBuffer; mime: string }) => void; reject: (error: Error) => void }
>()
let seq = 0
const send = (message: HtmlResponse) => self.postMessage(message)

self.onmessage = (event: MessageEvent<HtmlRequest>) => {
  const message = event.data
  if (message.type === "resource" || message.type === "failure") {
    const task = pending.get(message.id)
    if (!task) return
    pending.delete(message.id)
    if (message.type === "failure") task.reject(new Error(message.message))
    if (message.type === "resource") task.resolve({ data: message.data, mime: message.mime })
    return
  }
  void htmlConvert({
    path: message.path,
    source: message.source,
    signal: new AbortController().signal,
    read: (path) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        send({ type: "read", id, path })
      }),
  }).then(
    (result) => send({ type: "done", result: { ...result, deps: [...result.deps] } }),
    (error: unknown) => send({ type: "error", message: error instanceof Error ? error.message : String(error) }),
  )
}
