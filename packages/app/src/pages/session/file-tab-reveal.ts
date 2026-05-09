export function nextRevealScroll(input: {
  rootReady: boolean
  rootHeight: number
  targetReady: boolean
  targetHeight: number
  top: number
  bottom: number
  scrollTop: number
}) {
  if (!input.rootReady || input.rootHeight <= 0) {
    return { kind: "retry", reason: "root" } as const
  }

  if (!input.targetReady || input.targetHeight <= 0) {
    return { kind: "retry", reason: "target" } as const
  }

  const visible = input.top >= 0 && input.bottom <= input.rootHeight
  if (visible) {
    return { kind: "done", reason: "visible", top: input.scrollTop } as const
  }

  return {
    kind: "done",
    reason: "scroll",
    top: Math.max(0, input.scrollTop + input.top - input.rootHeight / 2 + input.targetHeight / 2),
  } as const
}
