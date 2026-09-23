export interface Pane {
  width: number
  min: number
  key?: "fileTree"
}

export function cascade(panes: Pane[], at: number, delta: number) {
  const widths = panes.map((pane) => pane.width)
  const forward = delta > 0
  let need = Math.abs(delta)
  const absorb = (i: number) => {
    if (need <= 0) return
    const slack = Math.max(0, widths[i] - panes[i].min)
    const size = Math.min(need, slack)
    widths[i] -= size
    need -= size
  }
  if (forward) for (let i = at; i < panes.length && need > 0; i++) absorb(i)
  else for (let i = at - 1; i >= 0 && need > 0; i--) absorb(i)
  const moved = Math.abs(delta) - need
  const grow = forward ? at - 1 : at
  if (moved > 0 && grow >= 0 && grow < panes.length) widths[grow] += moved
  return { widths, moved: moved === 0 ? 0 : forward ? moved : -moved }
}
