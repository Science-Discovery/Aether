function viewport(el: HTMLElement) {
  return (
    el.closest<HTMLElement>(".scroll-view__viewport") ?? el.closest<HTMLElement>("[data-slot='session-turn-content']")
  )
}

function place(el: HTMLElement, view: HTMLElement) {
  const top = Math.max(0, Number.parseFloat(getComputedStyle(el).top) || 0)
  el.setAttribute("data-sticky", String(view.clientHeight > top + el.getBoundingClientRect().height))
}

export function anchor(el: HTMLElement) {
  const view = viewport(el)
  const parent = el.parentElement
  if (!view || !parent) return
  const offset = Math.max(0, Number.parseFloat(getComputedStyle(el).top) || 0)
  const top = el.getBoundingClientRect().top - view.getBoundingClientRect().top
  return () => {
    if (!el.isConnected || !view.contains(el) || el.parentElement !== parent) return
    place(el, view)
    // A collapsed sticky bubble can mask its original position far above the
    // viewport. Return to the turn start when collapsing from that position.
    const rect = (top < offset ? parent : el).getBoundingClientRect()
    view.scrollTop += rect.top - view.getBoundingClientRect().top - Math.max(offset, top)
  }
}

export function observe(el: HTMLElement) {
  const view = viewport(el)
  if (!view) return () => {}

  const apply = () => place(el, view)
  const observer = new ResizeObserver(apply)
  apply()
  observer.observe(el)
  observer.observe(view)
  return () => {
    observer.disconnect()
    el.removeAttribute("data-sticky")
  }
}
