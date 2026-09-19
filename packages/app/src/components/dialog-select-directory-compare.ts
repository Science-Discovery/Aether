export type Row = {
  absolute: string
  search: string
  group: "recent" | "folders"
  isExpander?: true
  isCollapser?: true
  expanderCount?: number
}

export function compare(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
}

export function sortRows(a: Row, b: Row) {
  const pseudo = (x: Row) => (x.isExpander || x.isCollapser ? 1 : 0)
  const diff = pseudo(a) - pseudo(b)
  return diff !== 0 ? diff : compare(a.absolute, b.absolute)
}
