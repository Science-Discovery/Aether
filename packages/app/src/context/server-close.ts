export type Item = { worktree: string; expanded: boolean }

export function closeList(list: Item[], last: string | undefined, dir: string) {
  const next = list.filter((x) => x.worktree !== dir)
  if (last !== dir) return { next, last, edit: false }
  const head = next[0]?.worktree
  if (head) return { next, last: head, edit: true }
  return { next, last: undefined, edit: true }
}
