import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { Global } from "@/global"
import { which } from "@/util/which"
import { Engine } from "./schema"

export type Definition = {
  id: Engine.ID
  name: string
  protocol: "acp" | "claude"
  command: string
  args: string[]
  env?: string
}

const definitions: Definition[] = [
  { id: "qoder", name: "Qoder CLI", protocol: "acp", command: "qodercli", args: ["--acp"], env: "AETHER_QODER_PATH" },
  {
    id: "qodercn",
    name: "Qoder CLI CN",
    protocol: "acp",
    command: "qoderclicn",
    args: ["--acp"],
    env: "AETHER_QODERCN_PATH",
  },
  {
    id: "opencode",
    name: "OpenCode",
    protocol: "acp",
    command: "opencode",
    args: ["acp"],
    env: "AETHER_OPENCODE_PATH",
  },
  { id: "claude", name: "Claude Code", protocol: "claude", command: "claude", args: [], env: "AETHER_CLAUDE_PATH" },
]

export function list() {
  return definitions
}

export function get(id: Engine.ID) {
  return definitions.find((item) => item.id === id)
}

async function executable(file: string) {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat?.isFile()) return
  if (
    process.platform !== "win32" &&
    !(await fs.access(file, constants.X_OK).then(
      () => true,
      () => false,
    ))
  )
    return
  return path.resolve(file)
}

async function latest(dir: string, prefix: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map(async (entry) => {
        const file = path.join(dir, entry.name)
        const stat = await fs.stat(file).catch(() => undefined)
        return stat?.isFile() ? { file, time: stat.mtimeMs } : undefined
      }),
  )
  return files
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.time - a.time || a.file.localeCompare(b.file))[0]?.file
}

async function nodeBins(command: string) {
  const root = path.join(Global.Path.home, ".nvm", "versions", "node")
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const file = path.join(root, entry.name, "bin", command)
        const stat = await fs.stat(file).catch(() => undefined)
        return stat?.isFile() ? { file, time: stat.mtimeMs } : undefined
      }),
  )
  return found
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.time - a.time)[0]?.file
}

async function candidates(def: Definition) {
  const home = Global.Path.home
  const override = def.env ? process.env[def.env]?.trim() : undefined
  if (override) return [override]
  switch (def.id) {
    case "qoder": {
      const found = which(def.command)
      if (found) return [found, await latest(path.join(home, ".qoder", "bin", "qodercli"), "qodercli-")]
      return [await latest(path.join(home, ".qoder", "bin", "qodercli"), "qodercli-")]
    }
    case "qodercn": {
      const found = which(def.command)
      if (found) return [found, path.join(home, ".local", "bin", def.command)]
      return [
        path.join(home, ".local", "bin", def.command),
        await latest(path.join(home, ".qoder-cn", "bin", "qoderclicn"), "qoderclicn-"),
      ]
    }
    case "opencode": {
      const found = which(def.command)
      return [found, path.join(home, ".opencode", "bin", "opencode"), path.join(home, ".local", "bin", "opencode")]
    }
    case "claude": {
      const found = which(def.command)
      return [
        found,
        path.join(home, ".claude", "local", "claude"),
        path.join(home, ".local", "bin", "claude"),
        await nodeBins("claude"),
        path.join(home, ".volta", "bin", "claude"),
      ]
    }
  }
}

export async function discover(id: Engine.ID): Promise<string | undefined> {
  const def = get(id)
  if (!def) return
  for (const candidate of await candidates(def)) {
    if (!candidate) continue
    const found = await executable(candidate)
    if (found) return found
  }
}
