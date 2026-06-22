export type SelectionAnchorRect = {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

const TOLERANCE = 4

const make = (input: { top: number; left: number; right: number; bottom: number }): SelectionAnchorRect => ({
  top: input.top,
  left: input.left,
  right: input.right,
  bottom: input.bottom,
  width: input.right - input.left,
  height: input.bottom - input.top,
})

const valid = (rect: SelectionAnchorRect) =>
  Number.isFinite(rect.top) &&
  Number.isFinite(rect.left) &&
  Number.isFinite(rect.right) &&
  Number.isFinite(rect.bottom) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width > 0 &&
  rect.height > 0

const middle = (values: number[]) => {
  const list = [...values].sort((a, b) => a - b)
  const idx = Math.floor(list.length / 2)
  if (list.length % 2 === 0) return (list[idx - 1]! + list[idx]!) / 2
  return list[idx]!
}

export function resolveSelectionAnchorRect(input: {
  rects: SelectionAnchorRect[]
  containerWidth: number
  fallbackRect?: SelectionAnchorRect
}) {
  const rects = input.rects.filter(valid)
  const fallback = input.fallbackRect && valid(input.fallbackRect) ? input.fallbackRect : undefined
  if (rects.length === 0) return fallback

  const top = Math.min(...rects.map((rect) => rect.top))
  const lines = rects.filter((rect) => Math.abs(rect.top - top) <= TOLERANCE)
  if (lines.length === 0) return fallback

  const width = middle(lines.map((rect) => rect.width))
  const filtered = lines.filter((rect) => {
    if (input.containerWidth > 0 && rect.width >= input.containerWidth * 0.9) return false
    if (lines.length > 1 && width > 0 && rect.width >= width * 2.5) return false
    return true
  })

  const anchor = filtered.length > 0 ? filtered : lines
  if (anchor.length === 1) return anchor[0]

  return make({
    left: Math.min(...anchor.map((rect) => rect.left)),
    right: Math.max(...anchor.map((rect) => rect.right)),
    top: Math.min(...anchor.map((rect) => rect.top)),
    bottom: Math.max(...anchor.map((rect) => rect.bottom)),
  })
}
