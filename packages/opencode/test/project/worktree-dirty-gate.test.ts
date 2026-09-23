import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Worktree } from "../../src/worktree"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

function slash(input: string) {
  return input.replace(/\\/g, "/")
}

async function worktree(root: string, name: string) {
  const branch = `opencode/${name}`
  const dir = path.join(root, "..", name)
  await $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet()
  await $`git reset --hard`.cwd(dir).quiet()
  return dir
}

const remove = (root: string, dir: string, force?: boolean) =>
  Instance.provide({ directory: root, fn: () => Worktree.remove({ directory: dir, force }) })

async function registered(root: string, dir: string) {
  const list = await $`git worktree list --porcelain`.cwd(root).quiet().text()
  return list.includes(`worktree ${slash(dir)}`)
}

describe("Worktree.remove dirty gate", () => {
  test("rejects non-force removal with untracked files", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = await worktree(tmp.path, `dg-untracked-${Date.now().toString(36)}`)
    const file = path.join(dir, "notes.txt")
    await Bun.write(file, "uncommitted\n")

    await expect(remove(tmp.path, dir)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(dir)).toBe(true)
    expect(await Bun.file(file).text()).toBe("uncommitted\n")
    expect(await registered(tmp.path, dir)).toBe(true)
  })

  test("rejects non-force removal with staged changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = await worktree(tmp.path, `dg-staged-${Date.now().toString(36)}`)
    await Bun.write(path.join(dir, "staged.txt"), "data\n")
    await $`git add .`.cwd(dir).quiet()

    await expect(remove(tmp.path, dir)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(dir)).toBe(true)
    expect(await registered(tmp.path, dir)).toBe(true)
  })

  test("rejects non-force removal with modified tracked files", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = await worktree(tmp.path, `dg-tracked-${Date.now().toString(36)}`)
    await Bun.write(path.join(dir, "tracked.txt"), "v1\n")
    await $`git add .`.cwd(dir).quiet()
    await $`git commit -m tracked`.cwd(dir).quiet()
    await Bun.write(path.join(dir, "tracked.txt"), "v2\n")

    await expect(remove(tmp.path, dir)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Bun.file(path.join(dir, "tracked.txt")).text()).toBe("v2\n")
  })

  test("fails closed when git status cannot be verified", async () => {
    await using tmp = await tmpdir({ git: true })
    const name = `dg-corrupt-${Date.now().toString(36)}`
    const dir = await worktree(tmp.path, name)
    await Bun.write(path.join(tmp.path, ".git", "worktrees", name, "index"), "corrupt")

    await expect(remove(tmp.path, dir)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(dir)).toBe(true)
    expect(await registered(tmp.path, dir)).toBe(true)
  })

  test("force removes dirty worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = await worktree(tmp.path, `dg-force-${Date.now().toString(36)}`)
    await Bun.write(path.join(dir, "notes.txt"), "uncommitted\n")

    const result = await remove(tmp.path, dir, true)

    expect(result).toEqual({ status: "forceOk" })
    expect(await Filesystem.exists(dir)).toBe(false)
  })

  test("force escape hatch survives corrupt index", async () => {
    await using tmp = await tmpdir({ git: true })
    const name = `dg-force-corrupt-${Date.now().toString(36)}`
    const dir = await worktree(tmp.path, name)
    await Bun.write(path.join(tmp.path, ".git", "worktrees", name, "index"), "corrupt")

    const result = await remove(tmp.path, dir, true)

    expect(result).toEqual({ status: "forceOk" })
    expect(await Filesystem.exists(dir)).toBe(false)
  })

  test("non-force removal of clean worktree still succeeds", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = await worktree(tmp.path, `dg-clean-${Date.now().toString(36)}`)

    const result = await remove(tmp.path, dir)

    expect(result).toEqual({ status: "ok" })
    expect(await Filesystem.exists(dir)).toBe(false)
  })
})
