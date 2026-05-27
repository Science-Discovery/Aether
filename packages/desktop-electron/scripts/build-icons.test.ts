import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import sharp from "sharp"

const root = resolve(import.meta.dir, "..")
const channels = ["dev", "beta", "prod"]
const sizes = [16, 24, 32, 48, 64, 128, 256, 512]

function md5(buf: ArrayBuffer) {
  return createHash("md5").update(Buffer.from(buf)).digest("hex")
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
})
