#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"

import { Script } from "@opencode-ai/script"
import { copyBinaryToSidecarFolder, getCurrentSidecar, resolveChannel, windowsify } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`

const pkg = await Bun.file("./package.json").json()
pkg.version = Script.version
await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`Updated package.json version to ${Script.version}`)

const sidecarConfig = getCurrentSidecar()

const dir = "resources/opencode-binaries"
const local = windowsify(`../opencode/dist/${sidecarConfig.ocBinary}/bin/aether`)

await $`mkdir -p ${dir}`

if (!fs.existsSync(local)) {
  const artifact = Bun.env.OPENCODE_CLI_ARTIFACT ?? "aether-cli"
  await $`gh run download ${Bun.env.GITHUB_RUN_ID} -n ${artifact}`.cwd(dir)
}

await copyBinaryToSidecarFolder(fs.existsSync(local) ? local : windowsify(`${dir}/${sidecarConfig.ocBinary}/bin/aether`))

await $`rm -rf ${dir}`
