import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Worktree } from "../../src/worktree"
import { Global } from "../../src/global"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

const remove = (root: string, dir: string, force?: boolean) =>
  Instance.provide({ directory: root, fn: () => Worktree.remove({ directory: dir, force }) })

const sandboxRoot = (projectID: string) => path.join(Global.Path.data, "worktree", projectID)

describe("Worktree.remove ownership gate", () => {
  test("rejects an unrelated directory without force", async () => {
    await using tmp = await tmpdir({ git: true })
    await using stranger = await tmpdir()
    await Bun.write(path.join(stranger.path, "keep.txt"), "sentinel\n")

    await expect(remove(tmp.path, stranger.path)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(stranger.path)).toBe(true)
    expect(await Bun.file(path.join(stranger.path, "keep.txt")).text()).toBe("sentinel\n")
  })

  test("rejects an unrelated directory even with force", async () => {
    await using tmp = await tmpdir({ git: true })
    await using stranger = await tmpdir()
    await Bun.write(path.join(stranger.path, "keep.txt"), "sentinel\n")

    await expect(remove(tmp.path, stranger.path, true)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(stranger.path)).toBe(true)
    expect(await Bun.file(path.join(stranger.path, "keep.txt")).text()).toBe("sentinel\n")
  })

  test("rejects another repository's worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    await using other = await tmpdir({ git: true })

    await expect(remove(tmp.path, other.path)).rejects.toThrow("WorktreeRemoveFailedError")

    const list = await Bun.$`git worktree list --porcelain`.cwd(other.path).quiet().text()
    expect(list).toContain("worktree")
    expect(await Filesystem.exists(other.path)).toBe(true)
  })

  test("rejects the main working tree with force", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "keep.txt"), "sentinel\n")

    await expect(remove(tmp.path, tmp.path, true)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(tmp.path)).toBe(true)
    expect(await Bun.file(path.join(tmp.path, "keep.txt")).text()).toBe("sentinel\n")
  })

  test("rejects the main working tree without force", async () => {
    await using tmp = await tmpdir({ git: true })

    await expect(remove(tmp.path, tmp.path)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(tmp.path)).toBe(true)
  })

  test("rejects a subdirectory of the main working tree", async () => {
    await using tmp = await tmpdir({ git: true })
    const nested = path.join(tmp.path, "nested")
    await Bun.$`mkdir ${nested}`.quiet()
    await Bun.write(path.join(nested, "keep.txt"), "sentinel\n")

    await expect(remove(tmp.path, nested, true)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(nested)).toBe(true)
    expect(await Bun.file(path.join(nested, "keep.txt")).text()).toBe("sentinel\n")
  })

  test("still cleans a stale sandbox under the project sandbox root", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectID = await Instance.provide({ directory: tmp.path, fn: () => Instance.project.id })
    const stale = path.join(sandboxRoot(projectID), "sandbox-7")
    await Bun.$`mkdir -p ${stale}`.quiet()
    await Bun.write(path.join(stale, "stale.txt"), "stale\n")

    const result = await remove(tmp.path, stale)

    expect(result).toEqual({ status: "ok" })
    expect(await Filesystem.exists(stale)).toBe(false)
  })

  test("sandbox root itself is not removable", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectID = await Instance.provide({ directory: tmp.path, fn: () => Instance.project.id })
    const root = sandboxRoot(projectID)
    await Bun.$`mkdir -p ${root}`.quiet()

    await expect(remove(tmp.path, root)).rejects.toThrow("WorktreeRemoveFailedError")

    expect(await Filesystem.exists(root)).toBe(true)
  })

  test("non-existent unregistered directory still resolves idempotently", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await remove(tmp.path, path.join(tmp.path, "does-not-exist"))

    expect(result).toEqual({ status: "ok" })
  })
})
