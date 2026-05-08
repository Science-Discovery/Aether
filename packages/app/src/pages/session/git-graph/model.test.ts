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
    expect(graph.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromRow: 0,
          toRow: 1,
          committed: false,
        }),
      ]),
    )
  })

  test("splits a skipped parent edge into row segments", () => {
    const graph = computeGraphLayout(
      [item({ hash: "cccc", parents: ["aaaa"] }), item({ hash: "bbbb" }), item({ hash: "aaaa" })],
      "cccc",
    )

    expect(graph.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromRow: 0, toRow: 1 }),
        expect.objectContaining({ fromRow: 1, toRow: 2 }),
      ]),
    )
  })

  test("keeps a simple merge as two logical branches", () => {
    const graph = computeGraphLayout(
      [
        item({ hash: "merge", parents: ["main", "side"] }),
        item({ hash: "main", parents: ["base"] }),
        item({ hash: "side", parents: ["base"] }),
        item({ hash: "base" }),
      ],
      "merge",
    )

    expect(new Set(graph.lines.map((line) => line.branch)).size).toBeGreaterThanOrEqual(2)
    expect(graph.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromRow: 0, toRow: 1 }),
        expect.objectContaining({ fromRow: 1, toRow: 2 }),
        expect.objectContaining({ fromRow: 2, toRow: 3 }),
      ]),
    )
  })

  test("ignores missing parents without dropping the node", () => {
    const graph = computeGraphLayout([item({ hash: "bbbb", parents: ["missing"] })], "bbbb")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.lane).toBe(0)
    expect(graph.lines).toHaveLength(0)
  })

  test("reuses color indexes after a branch has ended", () => {
    const graph = computeGraphLayout(
      [
        item({ hash: "bbbb", parents: ["aaaa"] }),
        item({ hash: "aaaa" }),
        item({ hash: "dddd", parents: ["cccc"] }),
        item({ hash: "cccc" }),
      ],
      "bbbb",
    )

    expect(graph.nodes[0]?.colorIndex).toBe(graph.nodes[2]?.colorIndex)
  })
})
