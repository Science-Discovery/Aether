import { expect, test } from "bun:test"
import path from "node:path"
import config from "./electron-builder.config"

function resource(to: string) {
  if (!Array.isArray(config.extraResources)) throw new Error("Desktop extraResources must be an array")

  const item = config.extraResources.find((item) => typeof item === "object" && item !== null && item.to === to)
  if (!item || typeof item === "string") throw new Error(`Desktop resource ${to} not found`)
  return item
}

async function pins(dir: string, to: string) {
  const filter = resource(to).filter
  if (!Array.isArray(filter)) throw new Error(`Desktop resource ${to} must declare filters`)

  const excluded = new Set(filter.filter((item) => item.startsWith("!")).map((item) => item.slice(1)))
  const root = `${import.meta.dir}/../../.opencode/${dir}`
  const files = await Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: root, absolute: true }))

  return (
    await Promise.all(
      files
        .filter((file) => !excluded.has(path.relative(root, file).replaceAll("\\", "/")))
        .map(async (file) => {
          const match = (await Bun.file(file).text()).match(/^---\r?\n([\s\S]*?)\r?\n---/)
          return /^\s*(?:model|["']model["'])\s*:/m.test(match?.[1] ?? "") ? file : undefined
        }),
    )
  ).filter((file) => file !== undefined)
}

test("desktop excludes repository-only agents", () => {
  expect(resource(".aether/agent").filter).toEqual(["**/*", "!triage.md", "!duplicate-pr.md"])
})

test("desktop excludes repository-only commands", () => {
  expect(resource(".aether/command").filter).toEqual(["**/*", "!issues.md", "!commit.md", "!changelog.md"])
})

test("desktop-facing agents and commands inherit the conversation model", async () => {
  expect(await pins("agent", ".aether/agent")).toEqual([])
  expect(await pins("command", ".aether/command")).toEqual([])
})
