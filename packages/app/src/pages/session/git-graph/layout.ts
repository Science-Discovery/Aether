import type { CommitLogItem } from "@opencode-ai/sdk/v2"
import type { GraphLine, GraphNode, GraphView } from "./model"

const PENDING = "UNCOMMITTED"

type Vertex = {
  commit: CommitLogItem
  row: number
  parents: (number | null)[]
  used: Set<number>
  lane: number
  branch: number | null
  colorIndex: number
  next: number
  parent: number
}

type Branch = {
  colorIndex: number
  end: number
  lines: GraphLine[]
}

const idx = (commits: CommitLogItem[]) => {
  const map = new Map<string, number>()
  for (let i = 0; i < commits.length; i++) map.set(commits[i].hash, i)
  return map
}

const color = (bag: { end: number }[], start: number) => {
  for (let i = 0; i < bag.length; i++) {
    if (start > bag[i].end) {
      bag[i].end = start
      return i
    }
  }
  bag.push({ end: start })
  return bag.length - 1
}

const take = (v: Vertex, lane?: number) => {
  if (lane !== undefined && !v.used.has(lane)) {
    v.used.add(lane)
    v.next = Math.max(v.next, lane + 1)
    return lane
  }

  while (v.used.has(v.next)) v.next++
  v.used.add(v.next)
  return v.next++
}

export const layout = (commits: CommitLogItem[], head: string | null): GraphView => {
  const lookup = idx(commits)
  const bag: { end: number }[] = []
  const branches: Branch[] = []

  const vertices: Vertex[] = commits.map((commit, row) => ({
    commit,
    row,
    parents: commit.parents.map((p) => lookup.get(p) ?? null),
    used: new Set<number>(),
    lane: -1,
    branch: null,
    colorIndex: 0,
    next: 0,
    parent: 0,
  }))

  const branch = (start: number) => {
    branches.push({ colorIndex: color(bag, start), end: start, lines: [] })
    return branches.length - 1
  }

  const place = (v: Vertex, b: number, lane?: number) => {
    if (v.branch !== null) return
    v.branch = b
    v.colorIndex = branches[b].colorIndex
    if (lane !== undefined && v.used.has(lane)) {
      v.lane = lane
      v.next = Math.max(v.next, lane + 1)
      return
    }
    v.lane = take(v, lane)
  }

  const add = (b: number, a: { row: number; lane: number }, z: { row: number; lane: number }, committed: boolean) => {
    branches[b].end = Math.max(branches[b].end, z.row)
    bag[branches[b].colorIndex].end = branches[b].end
    branches[b].lines.push({
      branch: b,
      colorIndex: branches[b].colorIndex,
      fromRow: a.row,
      toRow: z.row,
      fromLane: a.lane,
      toLane: z.lane,
      committed,
      lockedFirst: a.lane === z.lane,
    })
  }

  const ensure = (v: Vertex) => {
    if (v.branch !== null) return v.branch
    const b = branch(v.row)
    place(v, b)
    return b
  }

  const route = (v: Vertex, at: number) => {
    const row = v.parents[at]
    if (row === null || row === undefined) {
      v.parent++
      return
    }

    const target = vertices[row]
    const first = at === 0
    const b = first ? ensure(v) : target.branch ?? branch(v.row)
    if (!first && v.branch === null) ensure(v)

    const committed = v.commit.hash !== PENDING
    const start = { row: v.row, lane: v.lane }
    let last = start

    for (let i = v.row + 1; i <= row; i++) {
      const next = vertices[i]
      const end = i === row
      const lane =
        end && next.branch !== null
          ? next.lane
          : end
            ? next.used.has(last.lane)
              ? take(next)
              : take(next, last.lane)
            : take(next, last.lane)

      add(b, last, { row: i, lane }, committed)

      if (end && next.branch === null) place(next, b, lane)
      last = { row: i, lane }
    }

    v.parent++
  }

  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]
    ensure(v)
    while (v.parent < v.parents.length) route(v, v.parent)
  }

  const nodes: GraphNode[] = vertices.map((v) => ({
    hash: v.commit.hash,
    row: v.row,
    lane: v.lane >= 0 ? v.lane : 0,
    colorIndex: v.colorIndex,
    isHead: v.commit.hash === head,
    isUncommitted: v.commit.hash === PENDING,
    message: v.commit.message,
    author: v.commit.author,
    date: v.commit.date,
    heads: v.commit.heads,
    tags: v.commit.tags,
    remotes: v.commit.remotes,
  }))

  const lines = branches.flatMap((b) => b.lines)
  const lanes = Math.max(
    0,
    ...vertices.map((v) => Math.max(v.lane, ...Array.from(v.used))),
    ...lines.flatMap((line) => [line.fromLane, line.toLane]),
  )

  return { nodes, lines, lanes: lanes + 1 }
}
