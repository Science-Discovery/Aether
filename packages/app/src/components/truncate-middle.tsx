import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

/**
 * Displays text with middle-ellipsis truncation: "beginning…ending"
 * When truncated, hovering for 1s shows a tooltip with the full text.
 */
export function TruncateMiddle(props: {
  text: string
  class?: string
  style?: string | JSX.CSSProperties
}) {
  let containerRef: HTMLSpanElement | undefined
  let measureRef: HTMLSpanElement | undefined
  const [display, setDisplay] = createSignal(props.text)
  const [truncated, setTruncated] = createSignal(false)
  const [showTip, setShowTip] = createSignal(false)
  const [tipStyle, setTipStyle] = createSignal<JSX.CSSProperties>({})
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  let tipRef: HTMLDivElement | undefined

  const compute = () => {
    const container = containerRef
    const measure = measureRef
    if (!container || !measure) return

    const text = props.text
    if (!text) {
      setDisplay("")
      setTruncated(false)
      return
    }

    measure.textContent = text
    const fullWidth = measure.offsetWidth
    const availableWidth = container.clientWidth

    if (fullWidth <= availableWidth) {
      setDisplay(text)
      setTruncated(false)
      return
    }

    setTruncated(true)

    measure.textContent = "\u2026"
    const ellipsisWidth = measure.offsetWidth

    const usable = availableWidth - ellipsisWidth
    if (usable <= 0) {
      setDisplay("\u2026")
      return
    }

    const startRatio = 0.55
    const startBudget = usable * startRatio
    const endBudget = usable - startBudget

    let startLen = 0
    for (let i = 1; i <= text.length; i++) {
      measure.textContent = text.slice(0, i)
      if (measure.offsetWidth > startBudget) break
      startLen = i
    }

    let endLen = 0
    for (let i = 1; i <= text.length - startLen; i++) {
      measure.textContent = text.slice(text.length - i)
      if (measure.offsetWidth > endBudget) break
      endLen = i
    }

    if (startLen === 0 && endLen === 0) {
      setDisplay("\u2026")
      return
    }

    const start = text.slice(0, startLen)
    const end = endLen > 0 ? text.slice(text.length - endLen) : ""
    setDisplay(start + "\u2026" + end)
  }

  const positionTip = () => {
    const el = tipRef
    const container = containerRef
    if (!el || !container) return

    const rect = container.getBoundingClientRect()
    const tipW = el.offsetWidth
    const tipH = el.offsetHeight
    const pad = 6

    // Default: centered above the element
    let left = rect.left + rect.width / 2 - tipW / 2
    let top = rect.top - tipH - pad

    // Clamp horizontal to viewport
    if (left < pad) left = pad
    if (left + tipW > window.innerWidth - pad) left = window.innerWidth - pad - tipW

    // If above goes off-screen, show below
    if (top < pad) top = rect.bottom + pad

    setTipStyle({ left: `${left}px`, top: `${top}px` })
  }

  const onMouseEnter = () => {
    if (!truncated()) return
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => {
      if (!containerRef) return
      setShowTip(true)
      // Position after render
      requestAnimationFrame(positionTip)
    }, 1000)
  }

  const onMouseLeave = () => {
    clearTimeout(hoverTimer)
    setShowTip(false)
  }

  createEffect(() => {
    void props.text
    compute()
  })

  createEffect(() => {
    const el = containerRef
    if (!el) return

    const ro = new ResizeObserver(() => compute())
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  })

  onCleanup(() => {
    clearTimeout(hoverTimer)
  })

  return (
    <>
      <span
        ref={containerRef}
        class={props.class}
        style={props.style}
        data-full-text={props.text}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onMouseDown={onMouseLeave}
      >
        <span
          ref={measureRef}
          style="position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;"
          aria-hidden="true"
        />
        {display()}
      </span>
      <Show when={showTip()}>
        <Portal>
          <div
            ref={tipRef}
            class="fixed z-[9999] px-2 py-1 rounded-md text-12-regular whitespace-nowrap pointer-events-none max-w-[90vw]"
            style={{
              ...tipStyle(),
              "background-color": "var(--surface-raised-base)",
              color: "var(--text-strong)",
              border: "1px solid var(--border-base)",
              "box-shadow": "0 2px 8px rgba(0,0,0,0.15)",
              "word-break": "break-all",
              "white-space": "pre-wrap",
            }}
          >
            {props.text}
          </div>
        </Portal>
      </Show>
    </>
  )
}
