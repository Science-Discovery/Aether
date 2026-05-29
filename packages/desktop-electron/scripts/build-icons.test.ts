import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { Icns } from "@fiahfy/icns"
import { describe, expect, test } from "bun:test"
import sharp from "sharp"

const root = resolve(import.meta.dir, "..")
const channels = ["dev", "beta", "prod"]
const sizes = [16, 24, 32, 48, 64, 128, 256, 512]

function md5(buf: ArrayBuffer | Buffer) {
  return createHash("md5").update(Buffer.from(buf)).digest("hex")
}

async function pixels(buf: ArrayBuffer | Buffer) {
  return md5(await sharp(buf).ensureAlpha().raw().toBuffer())
}

async function bounds(buf: ArrayBuffer | Buffer) {
  const raw = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const box = Array.from({ length: raw.info.width * raw.info.height }).reduce(
    (acc, _, i) => {
      if (raw.data[i * 4 + 3] === 0) return acc
      const x = i % raw.info.width
      const y = Math.floor(i / raw.info.width)
      return {
        left: Math.min(acc.left, x),
        top: Math.min(acc.top, y),
        right: Math.max(acc.right, x),
        bottom: Math.max(acc.bottom, y),
      }
    },
    { left: raw.info.width, top: raw.info.height, right: -1, bottom: -1 },
  )
  return {
    width: box.right - box.left + 1,
    height: box.bottom - box.top + 1,
    left: box.left,
    top: box.top,
  }
}

async function layer(file: string) {
  const data = Icns.from(Buffer.from(await Bun.file(file).arrayBuffer()))
  const image = data.images.find((item) => item.osType === "ic09")
  if (!image) throw new Error(`Missing 512x512 icns layer in ${file}`)
  return image.image
}

describe("desktop icons", () => {
  for (const channel of channels) {
    test(`${channel} assets exist`, () => {
      const dir = join(root, "icons", channel)
      for (const size of sizes) {
        expect(existsSync(join(dir, `${size}x${size}.png`))).toBe(true)
      }
      for (const name of ["icon.png", "dock.png", "icon.ico", "icon.icns"]) {
        expect(existsSync(join(dir, name))).toBe(true)
      }
    })

    test(`${channel} png dimensions match filenames`, async () => {
      const dir = join(root, "icons", channel)
      for (const size of sizes) {
        const meta = await sharp(join(dir, `${size}x${size}.png`)).metadata()
        expect(meta.width).toBe(size)
        expect(meta.height).toBe(size)
      }
    })

    test(`${channel} legacy mobile assets are absent`, () => {
      const dir = join(root, "icons", channel)
      expect(existsSync(join(dir, "android"))).toBe(false)
      expect(existsSync(join(dir, "ios"))).toBe(false)
      expect(existsSync(join(dir, "StoreLogo.png"))).toBe(false)
      for (const size of ["30", "44", "71", "89", "107", "142", "150", "284", "310"]) {
        expect(existsSync(join(dir, `Square${size}x${size}Logo.png`))).toBe(false)
      }
    })
  }

  test("prod 512 icon matches web manifest icon", async () => {
    expect(md5(await Bun.file(join(root, "icons/prod/512x512.png")).arrayBuffer())).toBe(
      md5(await Bun.file(join(root, "../ui/src/assets/favicon/web-app-manifest-512x512.png")).arrayBuffer()),
    )
  })

  test("mac icns 512 layer matches web manifest pixels", async () => {
    const src = await Bun.file(join(root, "../ui/src/assets/favicon/web-app-manifest-512x512.png")).arrayBuffer()
    const web = await bounds(src)
    const hash = await pixels(src)
    for (const channel of channels) {
      const img = await layer(join(root, "icons", channel, "icon.icns"))
      expect(await bounds(img)).toEqual(web)
      expect(await pixels(img)).toBe(hash)
    }
  })
})
