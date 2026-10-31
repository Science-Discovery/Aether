import { describe, expect, test } from "bun:test"
import utif, { type Directory } from "utif2"
import { decodeTiff } from "./tiff"

const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255])
const page: Directory = {
  t256: [2],
  t257: [1],
  t258: [8, 8, 8, 8],
  t259: [1],
  t262: [2],
  t273: [1000],
  t277: [4],
  t278: [1],
  t279: [8],
  t338: [2],
}

function fixture(pages: Directory[], pixels = rgba) {
  const metadata = utif.encode(pages)
  const output = new Uint8Array(1000 + pixels.length)
  output.set(new Uint8Array(metadata))
  output.set(pixels, 1000)
  return output.buffer
}

describe("TIFF preview", () => {
  test("decodes an actual RGBA TIFF without modifying the original", async () => {
    const input = utif.encodeImage(rgba.buffer, 2, 1, { t338: [2] })
    const before = new Uint8Array(input.slice(0))
    const output = await decodeTiff(input)
    expect(output.width).toBe(2)
    expect(output.height).toBe(1)
    expect(output.pages).toBe(1)
    expect(output.data).toBeInstanceOf(Uint8ClampedArray)
    expect(Array.from(output.data)).toEqual(Array.from(rgba))
    expect(new Uint8Array(input)).toEqual(before)
  })

  test("skips metadata-only directories and reports the image page count", async () => {
    const output = await decodeTiff(fixture([{}, page, page]))
    expect(output.pages).toBe(2)
    expect(Array.from(output.data)).toEqual(Array.from(rgba))
  })

  // Small RGB fixtures encoded by sharp/libvips, independent of the decoder.
  const compressed = {
    lzw: "SUkqABAAAACAP8AAAAwKAhAAAAEDAAEAAAACAAAAAQEDAAEAAAABAAAAAgEDAAMAAADmAAAAAwEDAAEAAAAFAAAABgEDAAEAAAACAAAAEQEEAAEAAAAIAAAAEgEDAAEAAAABAAAAFQEDAAEAAAADAAAAFgEDAAEAAAAAAQAAFwEEAAEAAAAIAAAAGgEFAAEAAADWAAAAGwEFAAEAAADeAAAAHAEDAAEAAAABAAAAKAEDAAEAAAACAAAAPQEDAAEAAAACAAAAUwEDAAMAAADsAAAAAAAAADMzywAAAAgAMzPLAAAACAAIAAgACAABAAEAAQA=",
    deflate:
      "SUkqABYAAAB4nPvPwMD4nwEACAECABAAAAEDAAEAAAACAAAAAQEDAAEAAAABAAAAAgEDAAMAAADsAAAAAwEDAAEAAAAIAAAABgEDAAEAAAACAAAAEQEEAAEAAAAIAAAAEgEDAAEAAAABAAAAFQEDAAEAAAADAAAAFgEDAAEAAAAAAQAAFwEEAAEAAAAOAAAAGgEFAAEAAADcAAAAGwEFAAEAAADkAAAAHAEDAAEAAAABAAAAKAEDAAEAAAACAAAAPQEDAAEAAAACAAAAUwEDAAMAAADyAAAAAAAAADMzywAAAAgAMzPLAAAACAAIAAgACAABAAEAAQA=",
    packbits:
      "SUkqABAAAAAA//4AAf8AAA8AAAEDAAEAAAACAAAAAQEDAAEAAAABAAAAAgEDAAMAAADaAAAAAwEDAAEAAAAFgAAABgEDAAEAAAACAAAAEQEEAAEAAAAIAAAAEgEDAAEAAAABAAAAFQEDAAEAAAADAAAAFgEDAAEAAAAAAQAAFwEEAAEAAAAHAAAAGgEFAAEAAADKAAAAGwEFAAEAAADSAAAAHAEDAAEAAAABAAAAKAEDAAEAAAACAAAAUwEDAAMAAADgAAAAAAAAADMzywAAAAgAMzPLAAAACAAIAAgACAABAAEAAQA=",
  }
  test.each(Object.entries(compressed))("decodes %s compression", async (_, encoded) => {
    const output = await decodeTiff(Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0)).buffer)
    expect([output.width, output.height]).toEqual([2, 1])
    expect(Array.from(output.data)).toEqual(Array.from(rgba))
  })

  test("decodes 16-bit grayscale to 8-bit preview pixels", async () => {
    const input = fixture([{ ...page, t258: [16], t262: [1], t277: [1], t279: [4] }], new Uint8Array([0, 0, 255, 255]))
    expect(Array.from((await decodeTiff(input)).data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255])
  })

  test("applies a rotated orientation", async () => {
    const output = await decodeTiff(fixture([{ ...page, t274: [6] }]))
    expect([output.width, output.height]).toEqual([1, 2])
    expect(Array.from(output.data)).toEqual(Array.from(rgba))
  })

  test("rejects bad headers and BigTIFF", async () => {
    await expect(decodeTiff(new ArrayBuffer(0))).rejects.toThrow("header")
    await expect(decodeTiff(new ArrayBuffer(8))).rejects.toThrow("byte order")
    await expect(decodeTiff(new Uint8Array([73, 73, 43, 0, 8, 0, 0, 0]).buffer)).rejects.toThrow("BigTIFF")
  })

  test("rejects cyclic directories before the decoder can loop", async () => {
    const input = fixture([page])
    const view = new DataView(input)
    const little = view.getUint16(0) === 0x4949
    const start = view.getUint32(4, little)
    view.setUint32(start + 2 + view.getUint16(start, little) * 12, start, little)
    await expect(decodeTiff(input)).rejects.toThrow("directory")
  })

  test("rejects cyclic subdirectories and unreasonable metadata counts", async () => {
    const input = fixture([page])
    const view = new DataView(input)
    const little = view.getUint16(0) === 0x4949
    const start = view.getUint32(4, little)
    view.setUint16(start + 2, 330, little)
    view.setUint16(start + 4, 4, little)
    view.setUint32(start + 10, start, little)
    await expect(decodeTiff(input)).rejects.toThrow("directory")
    view.setUint32(start + 6, 0xffffffff, little)
    await expect(decodeTiff(input)).rejects.toThrow("metadata is too large")
  })

  test("rejects truncated metadata and image payloads", async () => {
    await expect(decodeTiff(fixture([page]).slice(0, 25))).rejects.toThrow("directory")
    await expect(decodeTiff(fixture([page]).slice(0, 1004))).rejects.toThrow("image data")
    await expect(decodeTiff(fixture([{ ...page, t273: [2000] }]))).rejects.toThrow("image data")
    await expect(decodeTiff(fixture([{ ...page, t278: [0] }]))).rejects.toThrow("strip size")
  })

  test("rejects oversized previews and unsupported encodings", async () => {
    await expect(decodeTiff(new ArrayBuffer(32 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(RangeError)
    await expect(decodeTiff(fixture([{ ...page, t256: [20_000], t257: [20_000] }]))).rejects.toBeInstanceOf(RangeError)
    await expect(decodeTiff(fixture([{ ...page, t259: [99] }]))).rejects.toThrow("encoding")
    await expect(decodeTiff(fixture([{ ...page, t284: [2] }]))).rejects.toThrow("encoding")
    await expect(decodeTiff(fixture([{}]))).rejects.toThrow("no image pages")
  })

  test.each([8, 32946])("bounds Deflate %s output to the strip dimensions", async (compression) => {
    for (const size of [100, 3]) {
      const data = new Uint8Array(
        await new Response(
          new Blob([new Uint8Array(size)]).stream().pipeThrough(new CompressionStream("deflate")),
        ).arrayBuffer(),
      )
      const input = fixture([{ ...page, t256: [1], t259: [compression], t279: [data.length] }], data)
      await expect(decodeTiff(input)).rejects.toThrow(size > 4 ? "exceeds" : "Truncated")
    }
  })

  test("rejects embedded JPEG and associated alpha before decoding", async () => {
    await expect(decodeTiff(fixture([{ ...page, t259: [6] }]))).rejects.toThrow("encoding")
    await expect(decodeTiff(fixture([{ ...page, t259: [7] }]))).rejects.toThrow("encoding")
    await expect(decodeTiff(fixture([{ ...page, t338: [1] }]))).rejects.toThrow("Associated-alpha")
  })
})
