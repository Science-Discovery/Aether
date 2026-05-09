import type { CommitLogItem } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { autoColumns, resizeColumns } from "./columns"
import { computeGraphLayout, expandedY, LANE_GAP, RAIL_PAD, ROW_HEIGHT, UNCOMMITTED } from "./model"
import { refsFor } from "./refs"

const item = (input: {
  hash: string
  parents?: string[]
  heads?: string[]
  tags?: { name: string; annotated: boolean }[]
  remotes?: { name: string; remote: string | null }[]
}): CommitLogItem => ({
  hash: input.hash,
  parents: input.parents ?? [],
  author: "Test",
  email: "test@example.com",
  date: 1,
  message: input.hash,
  heads: input.heads ?? [],
  tags: input.tags ?? [],
  remotes: input.remotes ?? [],
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
    expect(graph.graphWidth).toBeLessThanOrEqual(RAIL_PAD * 2 + LANE_GAP)
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

  test("reports graph width from occupied connection slots", () => {
    const graph = computeGraphLayout(
      [item({ hash: "cccc", parents: ["aaaa"] }), item({ hash: "bbbb" }), item({ hash: "aaaa" })],
      "cccc",
    )

    expect(graph.graphWidth).toBeLessThanOrEqual(RAIL_PAD * 2 + LANE_GAP)
    expect(graph.widthsAtRows).toHaveLength(graph.nodes.length)
  })

  test("keeps a first-parent chain on the leftmost lane", () => {
    const graph = computeGraphLayout(
      [
        item({ hash: "dddd", parents: ["cccc"] }),
        item({ hash: "cccc", parents: ["bbbb"] }),
        item({ hash: "bbbb", parents: ["aaaa"] }),
        item({ hash: "aaaa" }),
      ],
      "dddd",
    )

    expect(graph.nodes.map((node) => node.lane)).toEqual([0, 0, 0, 0])
    expect(graph.graphWidth).toBe(RAIL_PAD * 2)
  })
})

describe("git graph refs", () => {
  test("combines local and matching remote branch labels", () => {
    const graph = computeGraphLayout(
      [
        item({
          hash: "bbbb",
          heads: ["dev"],
          remotes: [
            { name: "origin/dev", remote: "origin" },
            { name: "upstream/main", remote: "upstream" },
          ],
          tags: [{ name: "v1", annotated: true }],
        }),
      ],
      "bbbb",
    )
    const refs = refsFor(graph.nodes[0]!, "dev")

    expect(refs).toEqual([
      expect.objectContaining({
        kind: "head",
        name: "dev",
        full: "dev",
        active: true,
        remotes: [{ name: "origin", full: "origin/dev" }],
      }),
      expect.objectContaining({ kind: "remote", name: "upstream/main", full: "upstream/main", remote: "upstream" }),
      expect.objectContaining({ kind: "tag", name: "v1", full: "v1", annotated: true }),
    ])
  })

  test("keeps semantic fields for branch remote and tag labels", () => {
    const graph = computeGraphLayout(
      [
        item({
          hash: "bbbb",
          heads: ["dev"],
          remotes: [{ name: "origin/dev", remote: "origin" }],
          tags: [{ name: "v1", annotated: false }],
        }),
      ],
      "bbbb",
    )
    const refs = refsFor(graph.nodes[0]!, "dev")

    expect(refs[0]).toEqual(
      expect.objectContaining({
        kind: "head",
        name: "dev",
        full: "dev",
        remotes: [{ name: "origin", full: "origin/dev" }],
      }),
    )
    expect(refs[1]).toEqual(expect.objectContaining({ kind: "tag", name: "v1", full: "v1", annotated: false }))
  })
})

describe("git graph columns", () => {
  const total = (cols: ReturnType<typeof autoColumns>) =>
    cols.graph + cols.description + cols.author + cols.date + cols.commit

  test("keeps auto columns within the available width", () => {
    const cols = autoColumns(230, 1000)

    expect(Math.round(total(cols))).toBe(230)
    expect(cols.graph).toBeLessThanOrEqual(Math.round(230 * 0.333))
    expect(cols.description).toBeGreaterThan(0)
  })

  test("resizes adjacent columns without changing total width", () => {
    const cols = autoColumns(500, 120)
    const next = resizeColumns(cols, "graph", "description", 1000, 500)

    expect(Math.round(total(next))).toBe(500)
    expect(next.description).toBeGreaterThanOrEqual(40)
  })
})

describe("expandedY", () => {
  test("offsets only rows below the expanded row", () => {
    expect(expandedY(0, 1, 200)).toBe(ROW_HEIGHT / 2)
    expect(expandedY(1, 1, 200)).toBe(ROW_HEIGHT + ROW_HEIGHT / 2)
    expect(expandedY(2, 1, 200)).toBe(2 * ROW_HEIGHT + ROW_HEIGHT / 2 + 200)
  })

  test("matches normal row positions without an expanded row", () => {
    expect(expandedY(2, null, 200)).toBe(2 * ROW_HEIGHT + ROW_HEIGHT / 2)
  })
})
