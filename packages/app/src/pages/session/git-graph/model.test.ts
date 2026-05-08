import type { CommitLogItem } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { computeGraphLayout, UNCOMMITTED } from "./model"

const item = (input: { hash: string; parents?: string[]; heads?: string[] }): CommitLogItem => ({
  hash: input.hash,
  parents: input.parents ?? [],
  author: "Test",
  email: "test@example.com",
  date: 1,
  message: input.hash,
  heads: input.heads ?? [],
  tags: [],
  remotes: [],
})

describe("computeGraphLayout", () => {
  test("marks only the node matching the head hash", () => {
    const graph = computeGraphLayout(
      [item({ hash: "bbbb", parents: ["aaaa"], heads: ["dev"] }), item({ hash: "aaaa" })],
      "bbbb",
    )

    expect(graph.nodes.map((node) => [node.hash, node.isHead])).toEqual([
      ["bbbb", true],
      ["aaaa", false],
    ])
  })

  test("does not treat a branch name as a head hash", () => {
    const graph = computeGraphLayout(
      [item({ hash: "bbbb", parents: ["aaaa"], heads: ["dev"] }), item({ hash: "aaaa" })],
      "dev",
    )

    expect(graph.nodes.some((node) => node.isHead)).toBe(false)
  })

  test("supports an uncommitted node parented to head", () => {
    const graph = computeGraphLayout(
      [
        item({ hash: UNCOMMITTED, parents: ["bbbb"] }),
        item({ hash: "bbbb", parents: ["aaaa"], heads: ["dev"] }),
        item({ hash: "aaaa" }),
      ],
      "bbbb",
    )

    expect(graph.nodes[0]?.isUncommitted).toBe(true)
    expect(graph.nodes[1]?.isHead).toBe(true)
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromRow: 0,
          toRow: 1,
        }),
      ]),
    )
  })
})
