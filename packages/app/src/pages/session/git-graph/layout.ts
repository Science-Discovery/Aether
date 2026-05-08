import type { CommitLogItem } from "@opencode-ai/sdk/v2"
import { LANE_GAP, RAIL_PAD } from "./model"
import type { GraphLine, GraphNode, GraphView } from "./model"

const PENDING = "UNCOMMITTED"

type Vertex = {
  commit: CommitLogItem
  row: number
  parents: (number | null)[]
  connections: ({ target: number | null; branch: number } | undefined)[]
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

const point = (v: Vertex) => ({ row: v.row, lane: v.lane })

const slot = (v: Vertex) => ({ row: v.row, lane: v.next })

const parent = (v: Vertex) => (v.parent < v.parents.length ? v.parents[v.parent] : undefined)

const reserve = (v: Vertex, lane: number, target: number | null, branch: number) => {
  if (lane !== v.next) return
  v.connections[lane] = { target, branch }
  v.next = lane + 1
}

const found = (v: Vertex, target: number | null, branch: number) => {
  const lane = v.connections.findIndex((c) => c?.target === target && c.branch === branch)
  return lane === -1 ? null : { row: v.row, lane }
}

export const layout = (commits: CommitLogItem[], head: string | null): GraphView => {
  const lookup = idx(commits)
  const bag: { end: number }[] = []
  const branches: Branch[] = []

  const vertices: Vertex[] = commits.map((commit, row) => ({
    commit,
    row,
    parents: commit.parents.map((p) => lookup.get(p) ?? null),
    connections: [],
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

  const place = (v: Vertex, b: number, lane: number) => {
    if (v.branch !== null) return
    v.branch = b
    v.colorIndex = branches[b].colorIndex
    v.lane = lane
  }

  const add = (
    b: number,
    a: { row: number; lane: number },
    z: { row: number; lane: number },
    committed: boolean,
    locked: boolean,
  ) => {
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
      lockedFirst: locked,
    })
  }

  const normal = (start: number) => {
    const b = branch(start)
    let v = vertices[start]
    let row = parent(v)
    let last = v.branch === null ? slot(v) : point(v)

    place(v, b, last.lane)
    reserve(v, last.lane, v.row, b)

    if (row === undefined) return

    if (row === null) {
      v.parent++
      return
    }

    for (let i = start + 1; i < vertices.length; i++) {
      const cur = vertices[i]
      const target = i === row ? cur : null
      const end = target !== null && target.branch !== null ? point(target) : slot(cur)

      add(b, last, end, v.commit.hash !== PENDING, last.lane < end.lane)
      reserve(cur, end.lane, row, b)
      last = end

      if (target === null) continue

      v.parent++
      const set = target.branch !== null
      place(target, b, end.lane)
      v = target
      row = parent(v)

      if (row === undefined || set) return
      if (row === null) {
        v.parent++
        return
      }
    }
  }

  const merge = (v: Vertex, row: number) => {
    const target = vertices[row]
    const b = target.branch!
    let last = point(v)

    for (let i = v.row + 1; i < vertices.length; i++) {
      const cur = vertices[i]
      const hit = found(cur, row, b)
      const end = hit ?? slot(cur)

      add(b, last, end, v.commit.hash !== PENDING, hit !== null || cur === target || last.lane < end.lane)
      reserve(cur, end.lane, row, b)
      last = end

      if (hit === null) continue
      v.parent++
      return
    }

    v.parent++
  }

  const determine = (start: number) => {
    const v = vertices[start]
    const row = parent(v)
    if (row !== undefined && row !== null && v.parents.length > 1 && v.branch !== null && vertices[row].branch !== null) {
      merge(v, row)
      return
    }

    normal(start)
  }

  for (let i = 0; i < vertices.length; ) {
    const v = vertices[i]
    if (parent(v) !== undefined || v.branch === null) {
      determine(i)
      continue
    }
    i++
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
  const lane = Math.max(
    0,
    ...vertices.map((v) => Math.max(v.lane, v.next - 1)),
    ...lines.flatMap((line) => [line.fromLane, line.toLane]),
  )
  const next = Math.max(1, ...vertices.map((v) => v.next))
  const graphWidth = RAIL_PAD * 2 + Math.max(0, next - 1) * LANE_GAP
  const widthsAtRows = vertices.map((v) => RAIL_PAD + v.next * LANE_GAP - 2)

  return { nodes, lines, lanes: lane + 1, graphWidth, widthsAtRows }
}
