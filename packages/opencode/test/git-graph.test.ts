import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { ManagedRuntime } from "effect"
import { Git } from "../src/git"
import { parseRefs } from "../src/git/git-graph"
import { tmpdir } from "./fixture/fixture"

async function withGit<T>(fn: (rt: ManagedRuntime.ManagedRuntime<Git.Service, never>) => Promise<T>) {
  const rt = ManagedRuntime.make(Git.defaultLayer)
  try {
    return await fn(rt)
  } finally {
    await rt.dispose()
  }
}

describe("git graph refs", () => {
  test("parses head, local branches, remotes, and tags", () => {
    const refs = parseRefs(
      [
        "1111111111111111111111111111111111111111 HEAD",
        "1111111111111111111111111111111111111111 refs/heads/dev",
        "2222222222222222222222222222222222222222 refs/heads/feature/git-graph",
        "1111111111111111111111111111111111111111 refs/remotes/origin/dev",
        "1111111111111111111111111111111111111111 refs/remotes/origin/HEAD",
        "3333333333333333333333333333333333333333 refs/tags/v1.0.0",
      ].join("\n"),
    )

    expect(refs.head).toBe("1111111111111111111111111111111111111111")
    expect(refs.heads).toEqual([
      { hash: "1111111111111111111111111111111111111111", name: "dev" },
      { hash: "2222222222222222222222222222222222222222", name: "feature/git-graph" },
    ])
    expect(refs.remotes).toEqual([{ hash: "1111111111111111111111111111111111111111", name: "origin/dev" }])
    expect(refs.tags).toEqual([{ hash: "3333333333333333333333333333333333333333", name: "v1.0.0", annotated: false }])
  })

  test("uses peeled hashes for annotated tags", () => {
    const refs = parseRefs(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/v2.0.0",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v2.0.0^{}",
      ].join("\n"),
    )

    expect(refs.tags).toEqual([{ hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "v2.0.0", annotated: true }])
  })

  test("does not duplicate direct and peeled records for one tag", () => {
    const refs = parseRefs(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/v2.0.0",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v2.0.0^{}",
        "cccccccccccccccccccccccccccccccccccccccc refs/tags/v3.0.0",
      ].join("\n"),
    )

    expect(refs.tags).toEqual([
      { hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "v2.0.0", annotated: true },
      { hash: "cccccccccccccccccccccccccccccccccccccccc", name: "v3.0.0", annotated: false },
    ])
  })
})

describe("git graph commit details", () => {
  test("shows files changed by a merge commit against its first parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M main`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "main.txt"), "main\n")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "main file"`.cwd(tmp.path).quiet()
    await $`git checkout -b feature`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "feature.txt"), "feature\n")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "feature file"`.cwd(tmp.path).quiet()
    await $`git checkout main`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, "main.txt"), "main\nnext\n")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "main update"`.cwd(tmp.path).quiet()
    await $`git merge --no-ff --no-gpg-sign -m "merge feature" feature`.cwd(tmp.path).quiet()
    const hash = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()

    await withGit(async (rt) => {
      const detail = await rt.runPromise(Git.Service.use((git) => git.commitDetails(tmp.path, hash)))

      expect(detail.parents).toHaveLength(2)
      expect(detail.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "A",
            file: "feature.txt",
          }),
        ]),
      )
    })
  })
})
