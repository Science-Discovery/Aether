import { decodeTiff } from "./tiff"
import type { TiffReply } from "./tiff-preview"

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  void decodeTiff(event.data)
    .then((result) => {
      self.postMessage({ result } satisfies TiffReply, { transfer: [result.data.buffer] })
    })
    .catch((error: unknown) => {
      self.postMessage({
        error: {
          name: error instanceof RangeError ? "RangeError" : "Error",
          message: error instanceof Error ? error.message : "TIFF image could not be decoded",
        },
      } satisfies TiffReply)
    })
}
