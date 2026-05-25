#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import path from "path"

import { Script } from "@opencode-ai/script"
import { copyBinaryToSidecarFolder, copyResource, getCurrentSidecar, resolveChannel, windowsify } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`

const pkg = await Bun.file("./package.json").json()
pkg.version = Script.version
await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`Updated package.json version to ${Script.version}`)

const sidecarConfig = getCurrentSidecar()

const dir = "resources/opencode-binaries"
const local = windowsify(`../opencode/dist/${sidecarConfig.ocBinary}/bin/aether`)
const sidecar =
  sidecarConfig.ocBinary.includes("-linux-") || sidecarConfig.ocBinary.startsWith("aether-linux-")
    ? "../opencode/dist/" + sidecarConfig.ocBinary + "/bin/native/opencode-watcher"
    : undefined

await $`mkdir -p ${dir}`
await $`rm -rf resources/native`

if (!fs.existsSync(local)) {
  const artifact = Bun.env.OPENCODE_CLI_ARTIFACT ?? "aether-cli"
  await $`gh run download ${Bun.env.GITHUB_RUN_ID} -n ${artifact}`.cwd(dir)
}

const root = fs.existsSync(local) ? `../opencode/dist/${sidecarConfig.ocBinary}` : `${dir}/${sidecarConfig.ocBinary}`
await copyBinaryToSidecarFolder(windowsify(`${root}/bin/aether`))
if (sidecar) {
  const file = path.join(root, "bin", "native", "opencode-watcher")
  if (fs.existsSync(file)) {
    await copyResource(file, "resources/native/opencode-watcher")
  }
}

await $`rm -rf ${dir}`
