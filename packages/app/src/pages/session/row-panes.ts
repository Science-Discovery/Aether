import { REVIEW_MIN, SESSION_MIN, SIDEBAR_MIN, TREE_MIN } from "./reading-layout"
import type { Pane } from "./cascade"

export function panes(input: {
  desktop: boolean
  reading: boolean
  rowWidth: number
  chat: number
  tree: number
  reviewOpen: boolean
  treeOpen: boolean
}): Pane[] {
  if (!input.desktop || input.reading) return []
  const chat = Math.max(SESSION_MIN, input.chat)
  const tree = Math.max(TREE_MIN, input.tree)
  const list: Pane[] = [{ width: chat, min: SESSION_MIN }]
  if (input.reviewOpen)
    list.push({ width: Math.max(REVIEW_MIN, input.rowWidth - chat - (input.treeOpen ? tree : 0)), min: REVIEW_MIN })
  if (input.treeOpen) list.push({ width: tree, min: TREE_MIN, key: "fileTree" })
  return list
}

export function bounds(list: Pane[], sidebar: number | undefined) {
  const chain = sidebar === undefined ? list : [{ width: Math.max(SIDEBAR_MIN, sidebar), min: SIDEBAR_MIN }, ...list]
  const at = sidebar === undefined ? 1 : 2
  let span = 0
  let low = 0
  let high = 0
  chain.forEach((pane, i) => {
    if (i < at) {
      span += pane.width
      low += pane.min
      high += pane.width
      return
    }
    high += Math.max(0, pane.width - pane.min)
  })
  return { chain, at, span, low, high: Math.max(low, high) }
}
