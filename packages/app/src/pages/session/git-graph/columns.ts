export type Column = "graph" | "description" | "author" | "date" | "commit"

export type Columns = Record<Column, number>

export const COLUMN_MIN = 40
export const GRAPH_MIN = 64
export const GRAPH_MAX_RATIO = 0.333

export const fitColumns = (cols: Columns, width: number): Columns => {
  const total = cols.graph + cols.description + cols.author + cols.date + cols.commit
  if (width <= 0 || total === width) return cols

  if (total < width) {
    return { ...cols, description: cols.description + width - total }
  }

  const min = COLUMN_MIN * 4 + GRAPH_MIN
  if (width < min) {
    const scale = width / min
    return {
      graph: GRAPH_MIN * scale,
      description: COLUMN_MIN * scale,
      author: COLUMN_MIN * scale,
      date: COLUMN_MIN * scale,
      commit: COLUMN_MIN * scale,
    }
  }

  const next = { ...cols }
  const reduce = (col: Column, min: number, amount: number) => {
    const value = Math.max(min, next[col] - amount)
    const used = next[col] - value
    next[col] = value
    return amount - used
  }

  const rest = (["description", "graph", "author", "date", "commit"] as const).reduce(
    (amount, col) => reduce(col, col === "graph" ? GRAPH_MIN : COLUMN_MIN, amount),
    total - width,
  )

  if (rest <= 0) return next

  return {
    graph: GRAPH_MIN,
    description: COLUMN_MIN,
    author: COLUMN_MIN,
    date: COLUMN_MIN,
    commit: COLUMN_MIN,
  }
}

const narrow = (width: number) => {
  if (width <= 700) return 80
  if (width <= 775) return 90
  if (width <= 850) return 100
  return 112
}

export const autoColumns = (width: number, graphWidth: number): Columns => {
  if (width <= 0) return { graph: 0, description: 0, author: 0, date: 0, commit: 0 }

  const author = narrow(width)
  const date = Math.min(96, narrow(width))
  const commit = 74
  const max = Math.max(GRAPH_MIN, Math.round(width * GRAPH_MAX_RATIO))
  const graph = Math.min(Math.max(graphWidth, GRAPH_MIN), max)

  return fitColumns(
    {
      graph,
      description: Math.max(COLUMN_MIN, width - graph - author - date - commit),
      author,
      date,
      commit,
    },
    width,
  )
}

export const template = (cols: Columns) =>
  `${cols.graph}px minmax(0, ${cols.description}px) ${cols.author}px ${cols.date}px ${cols.commit}px`

export const resizeColumns = (cols: Columns, left: Column, right: Column, delta: number, width: number): Columns => {
  const min = (col: Column) => (col === "graph" ? GRAPH_MIN : COLUMN_MIN)
  const grow = Math.max(min(left), cols[left] + delta)
  const diff = grow - cols[left]
  const shrink = Math.max(min(right), cols[right] - diff)
  const actual = cols[right] - shrink

  return fitColumns(
    {
      ...cols,
      [left]: cols[left] + actual,
      [right]: shrink,
    },
    width,
  )
}
