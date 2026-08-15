type Item = {
  id: string
  time: { created: number }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export namespace MessageOrder {
  export function compare(a: Item, b: Item) {
    return a.time.created - b.time.created || cmp(a.id, b.id)
  }

  export function sort<T extends Item>(items: readonly T[]) {
    return [...items].sort(compare)
  }

  export function merge<T extends Item>(a: readonly T[], b: readonly T[]) {
    const map = new Map(a.map((item) => [item.id, item] as const))
    for (const item of b) map.set(item.id, item)
    return sort([...map.values()])
  }

  export function index<T extends { id: string }>(items: readonly T[], id: string) {
    return items.findIndex((item) => item.id === id)
  }

  export function insert<T extends Item>(items: readonly T[], item: T) {
    const at = items.findIndex((current) => compare(current, item) > 0)
    return at < 0 ? items.length : at
  }

  export function before<T extends { id: string }>(items: readonly T[], id: string) {
    const at = index(items, id)
    return at < 0 ? [...items] : items.slice(0, at)
  }

  export function from<T extends { id: string }>(items: readonly T[], id: string) {
    const at = index(items, id)
    return at < 0 ? [] : items.slice(at)
  }

  export function next<T extends { id: string }>(items: readonly T[], id: string) {
    const at = index(items, id)
    return at < 0 ? undefined : items[at + 1]
  }

  export function prev<T extends { id: string }>(items: readonly T[], id: string) {
    const at = index(items, id)
    return at <= 0 ? undefined : items[at - 1]
  }
}
