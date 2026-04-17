export type SelectionAnchorRect = {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

const FIRST_LINE_TOLERANCE_PX = 4

const rectFromEdges = (input: { top: number; left: number; right: number; bottom: number }): SelectionAnchorRect => ({
  top: input.top,
  left: input.left,
  right: input.right,
  bottom: input.bottom,
  width: input.right - input.left,
  height: input.bottom - input.top,
})

const isValidRect = (rect: SelectionAnchorRect) =>
  Number.isFinite(rect.top) &&
  Number.isFinite(rect.left) &&
  Number.isFinite(rect.right) &&
  Number.isFinite(rect.bottom) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width > 0 &&
  rect.height > 0

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[middle - 1]! + sorted[middle]!) / 2
  return sorted[middle]!
}

export function resolveSelectionAnchorRect(input: {
  rects: SelectionAnchorRect[]
  containerWidth: number
  fallbackRect?: SelectionAnchorRect
}): SelectionAnchorRect | undefined {
  const validRects = input.rects.filter(isValidRect)
  const fallbackRect = input.fallbackRect && isValidRect(input.fallbackRect) ? input.fallbackRect : undefined

  if (validRects.length === 0) return fallbackRect

  const firstLineTop = Math.min(...validRects.map((rect) => rect.top))
  const firstLineRects = validRects.filter((rect) => Math.abs(rect.top - firstLineTop) <= FIRST_LINE_TOLERANCE_PX)
  if (firstLineRects.length === 0) return fallbackRect

  const medianWidth = median(firstLineRects.map((rect) => rect.width))
  const filteredRects = firstLineRects.filter((rect) => {
    if (input.containerWidth > 0 && rect.width >= input.containerWidth * 0.9) return false
    if (firstLineRects.length > 1 && medianWidth > 0 && rect.width >= medianWidth * 2.5) return false
    return true
  })

  const anchorRects = filteredRects.length > 0 ? filteredRects : firstLineRects
  if (anchorRects.length === 1) return anchorRects[0]

  const left = Math.min(...anchorRects.map((rect) => rect.left))
  const right = Math.max(...anchorRects.map((rect) => rect.right))
  const top = Math.min(...anchorRects.map((rect) => rect.top))
  const bottom = Math.max(...anchorRects.map((rect) => rect.bottom))

  return rectFromEdges({ left, right, top, bottom })
}
