export type FileTabFitInput = {
  clientWidth: number
  fixedWidth: number
  natural: number[]
  capped: number[]
  moreWidth: number
}

export type FileTabFit = {
  capped: boolean
  visible: number
}

/**
 * Decide how file tabs fit into the titlebar strip:
 * 1. show every tab at its natural width when it fits;
 * 2. otherwise cap each tab and show them all when that fits;
 * 3. otherwise keep the cap, show as many leading tabs as fit (at least one)
 *    and reveal the rest through the overflow menu.
 * Widths are expected to include each item's trailing gap.
 */
export const fitFileTabs = (input: FileTabFitInput): FileTabFit => {
  const sum = (widths: number[]) => widths.reduce((acc, w) => acc + w, 0)
  if (sum(input.natural) + input.fixedWidth <= input.clientWidth)
    return { capped: false, visible: input.natural.length }
  if (sum(input.capped) + input.fixedWidth <= input.clientWidth) return { capped: true, visible: input.capped.length }
  const budget = input.clientWidth - input.fixedWidth - input.moreWidth
  let acc = 0
  let visible = 0
  for (const w of input.capped) {
    if (acc + w > budget) break
    acc += w
    visible++
  }
  return { capped: true, visible: Math.max(1, visible) }
}
