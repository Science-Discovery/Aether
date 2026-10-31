import utif from "utif2"

const pixels = 16_000_000
const bytes = 32 * 1024 * 1024

// UTIF trusts directory offsets and counts. Bound its metadata traversal before
// decoding so a truncated file or a cyclic IFD cannot hang the viewer.
function inspect(input: ArrayBuffer) {
  if (input.byteLength > bytes) throw new RangeError("TIFF preview is limited to 32 MiB")
  if (input.byteLength < 8) throw new Error("Invalid TIFF header")
  const view = new DataView(input)
  const order = view.getUint16(0)
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error("Invalid TIFF byte order")
  const little = order === 0x4949
  const version = view.getUint16(2, little)
  if (version === 43) throw new Error("BigTIFF preview is not supported")
  if (version !== 42) throw new Error("Invalid TIFF version")
  const active = new Set<number>()
  const budget = { directories: 0, values: 0 }
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4]
  const walk = (offset: number, chain: boolean) => {
    if (offset < 8 || offset + 2 > input.byteLength || active.has(offset)) throw new Error("Invalid TIFF directory")
    if (++budget.directories > 256) throw new Error("TIFF has too many directories")
    active.add(offset)
    const count = view.getUint16(offset, little)
    const end = offset + 2 + count * 12
    if (end + 4 > input.byteLength) throw new Error("Truncated TIFF directory")
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12
      const tag = view.getUint16(entry, little)
      const type = view.getUint16(entry + 2, little)
      const count = view.getUint32(entry + 4, little)
      const size = sizes[type]
      if (!size) throw new Error("Unsupported TIFF field type")
      budget.values += count
      if (budget.values > 1_000_000) throw new Error("TIFF metadata is too large")
      const length = size * count
      const start = length <= 4 ? entry + 8 : view.getUint32(entry + 8, little)
      if (start + length > input.byteLength) throw new Error("Truncated TIFF metadata")
      if (tag === 50740) throw new Error("RAW TIFF metadata is not supported")
      if (![330, 34665, 34853, 61440].includes(tag)) continue
      if (type !== 4 && type !== 13) throw new Error("Invalid TIFF subdirectory")
      for (let index = 0; index < count; index++) walk(view.getUint32(start + index * 4, little), false)
    }
    const next = view.getUint32(end, little)
    if (chain && next) walk(next, true)
    active.delete(offset)
  }
  walk(view.getUint32(4, little), true)
}

/** Decode the first image page of a classic TIFF without changing the source. */
export async function decodeTiff(input: ArrayBuffer) {
  inspect(input)
  try {
    const directories = utif.decode(input, { parseMN: false })
    const pages = directories.filter((page) => (page.t256?.[0] ?? 0) > 0 && (page.t257?.[0] ?? 0) > 0)
    const page = pages[0]
    if (!page) throw new Error("TIFF contains no image pages")
    const width = page.t256![0]
    const height = page.t257![0]
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > pixels) {
      throw new RangeError("TIFF preview is limited to 16 megapixels")
    }
    const bits = page.t258 ?? [1]
    const channels = page.t277?.[0] ?? bits.length
    const color = page.t262?.[0] ?? 0
    const compression = page.t259?.[0] ?? 1
    if (
      ![1, 2, 3, 4, 5, 8, 32773, 32809, 32946].includes(compression) ||
      ![0, 1, 2, 3, 5, 6].includes(color) ||
      ![1, 2, 3, 4].includes(channels) ||
      bits.some((value) => ![1, 2, 4, 8, 16].includes(value) || value !== bits[0]) ||
      (page.t284?.[0] ?? 1) !== 1 ||
      (page.t339 ?? [1]).some((value) => value !== 1)
    ) {
      throw new Error("This TIFF encoding is not supported")
    }
    if (page.t338?.includes(1)) throw new Error("Associated-alpha TIFF preview is not supported")
    if (
      ((color === 0 || color === 1) && channels !== 1) ||
      (color === 0 && bits[0] === 2) ||
      (color === 1 && bits[0] === 4) ||
      (color === 2 && (![3, 4].includes(channels) || ![8, 16].includes(bits[0]))) ||
      (color === 3 && (channels !== 1 || bits[0] > 8 || (page.t320?.length ?? 0) < 3 * 2 ** bits[0])) ||
      (color === 5 && (channels !== 4 || bits[0] !== 8)) ||
      (color === 6 && (channels !== 3 || bits[0] !== 8))
    ) {
      throw new Error("This TIFF color layout is not supported")
    }
    const offsets = page.t324 ?? page.t273
    const lengths = page.t325 ?? page.t279
    if (!offsets?.length || !lengths || offsets.length !== lengths.length) throw new Error("Invalid TIFF image data")
    if (offsets.some((offset, index) => lengths[index] <= 0 || offset + lengths[index] > input.byteLength)) {
      throw new Error("Truncated TIFF image data")
    }
    if (page.t278 && page.t278[0] <= 0) throw new Error("Invalid TIFF strip size")
    if (page.t322) {
      const width = page.t322[0]
      const height = page.t323?.[0] ?? 0
      if (width <= 0 || height <= 0 || width * height > pixels) throw new Error("Invalid TIFF tile size")
      if (Math.ceil(page.t256![0] / width) * Math.ceil(page.t257![0] / height) !== offsets.length) {
        throw new Error("Invalid TIFF tile count")
      }
    }
    if (compression === 1 && !page.t322 && offsets.length === 1) {
      if (offsets[0] + Math.ceil((width * channels * bits[0]) / 8) * height > input.byteLength) {
        throw new Error("Truncated TIFF image data")
      }
    }
    if (compression === 8 || compression === 32946) {
      if (typeof DecompressionStream === "undefined") throw new Error("Deflate TIFF preview is unavailable")
      const columns = page.t322?.[0] ?? width
      const rows = page.t323?.[0] ?? Math.min(page.t278?.[0] ?? height, height)
      if (!page.t322 && offsets.length !== Math.ceil(height / rows)) throw new Error("Invalid TIFF strip count")
      for (const [index, offset] of offsets.entries()) {
        const expected =
          Math.ceil((columns * channels * bits[0]) / 8) * (page.t322 ? rows : Math.min(rows, height - index * rows))
        const reader = new Blob([new Uint8Array(input, offset, lengths[index])])
          .stream()
          .pipeThrough(new DecompressionStream("deflate"))
          .getReader()
        let count = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            count += chunk.value.byteLength
            if (count <= expected) continue
            await reader.cancel()
            throw new Error("TIFF Deflate output exceeds its image dimensions")
          }
        } finally {
          reader.releaseLock()
        }
        if (count !== expected) throw new Error("Truncated TIFF Deflate output")
      }
    }
    utif.decodeImage(input, page, directories)
    if (!page.data || page.data.length !== Math.ceil((width * channels * bits[0]) / 8) * height) {
      throw new Error("TIFF image could not be decoded")
    }
    const rgba = utif.toRGBA8(page)
    if (rgba.length !== width * height * 4) throw new Error("Invalid TIFF pixels")
    const orientation = page.t274?.[0] ?? 1
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8)
      throw new Error("Invalid TIFF orientation")
    if (orientation !== 1) {
      const rotated = orientation >= 5
      const horizontal = [2, 3, 6, 7].includes(orientation)
      const vertical = [3, 4, 7, 8].includes(orientation)
      const columns = rotated ? height : width
      const rows = rotated ? width : height
      const data = new Uint8ClampedArray(rgba.length)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const left = horizontal ? columns - 1 - (rotated ? y : x) : rotated ? y : x
          const top = vertical ? rows - 1 - (rotated ? x : y) : rotated ? x : y
          const source = (y * width + x) * 4
          const target = (top * columns + left) * 4
          for (let channel = 0; channel < 4; channel++) data[target + channel] = rgba[source + channel]
        }
      }
      return { width: columns, height: rows, data, pages: pages.length }
    }
    return {
      width,
      height,
      data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      pages: pages.length,
    }
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error("TIFF image could not be decoded", { cause: error })
  }
}
