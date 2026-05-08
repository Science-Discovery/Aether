import { describe, expect, test } from "bun:test"
import { parseRefs } from "../src/git/git-graph"

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
