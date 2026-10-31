import { read } from "./xlsx-model"
import type { Reply, Request } from "./xlsx-types"

let workbook: Awaited<ReturnType<typeof read>> | undefined
const send = (message: Reply, transfers: Transferable[] = []) => self.postMessage(message, { transfer: transfers })
self.onmessage = (event: MessageEvent<Request>) => {
  const input = event.data
  void (async () => {
    if (input.type === "load") {
      workbook = await read(input.data)
      send(
        { id: input.id, type: "loaded", sheets: workbook.sheets, images: workbook.images },
        workbook.images.map((image) => image.data.buffer),
      )
      return
    }
    if (!workbook) throw new Error("Workbook is not loaded")
    send({ id: input.id, type: "range", sheet: input.sheet, cells: workbook.range(input) })
  })().catch((error: unknown) =>
    send({ id: input.id, type: "error", message: error instanceof Error ? error.message : "Unable to read workbook" }),
  )
}
