#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { Icns, IcnsImage } from "@fiahfy/icns"
import pngToIco from "png-to-ico"
import sharp from "sharp"

const channels = ["dev", "beta", "prod"] as const
const arg = process.argv[2]
const channel = channels.find((item) => item === arg) ?? "prod"
const root = resolve(import.meta.dir, "..")
const out = join(root, "icons", channel)
const png = join(root, "../ui/src/assets/favicon/web-app-manifest-512x512.png")
const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
const ico = [16, 24, 32, 48, 64, 128, 256]
const icnsSizes = [16, 32, 64, 128, 256, 512, 1024]
const types = [
  "icp4",
  "ic04",
  "icp5",
  "ic05",
  "icp6",
  "ic07",
  "ic08",
  "ic09",
  "ic10",
  "ic11",
  "ic12",
  "ic13",
  "ic14",
] as const

function md5(buf: ArrayBuffer | Buffer) {
  return createHash("md5").update(Buffer.from(buf)).digest("hex")
}

function clean() {
  mkdirSync(out, { recursive: true })
  for (const name of readdirSync(out)) {
    rmSync(join(out, name), { recursive: true, force: true })
  }
}

async function buildIcns() {
  const file = new Icns()
  for (const type of types) {
    const item = Icns.supportedIconTypes.find((entry) => entry.osType === type)
    if (!item) continue
    file.append(
      IcnsImage.fromPNG(Buffer.from(await Bun.file(join(tmp, `${item.size}x${item.size}.png`)).arrayBuffer()), type),
    )
  }
  return file.data
}

async function render(size: number, file: string) {
  await sharp(png).resize(size, size).png().toFile(file)
}

async function mac(size: number, file: string) {
  await sharp(png).resize(size, size).png().toFile(file)
}

clean()

for (const size of sizes) {
  await render(size, join(out, `${size}x${size}.png`))
}

await Bun.write(join(out, "512x512.png"), Bun.file(png))
await Bun.write(join(out, "icon.png"), Bun.file(png))
await Bun.write(join(out, "dock.png"), Bun.file(png))

const tmp = join(out, ".icns")
mkdirSync(tmp, { recursive: true })
for (const size of icnsSizes) {
  await mac(size, join(tmp, `${size}x${size}.png`))
}

await Bun.write(join(out, "icon.ico"), await pngToIco(ico.map((size) => join(out, `${size}x${size}.png`))))
await Bun.write(join(out, "icon.icns"), await buildIcns())

rmSync(tmp, { recursive: true, force: true })

console.log(`${channel} 512x512.png ${md5(await Bun.file(join(out, "512x512.png")).arrayBuffer())}`)
console.log(`source web-app-manifest-512x512.png ${md5(await Bun.file(png).arrayBuffer())}`)
