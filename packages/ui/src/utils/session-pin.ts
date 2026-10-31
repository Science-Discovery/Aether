export function observe(el: HTMLElement) {
  const view =
    el.closest<HTMLElement>(".scroll-view__viewport") ?? el.closest<HTMLElement>("[data-slot='session-turn-content']")
  if (!view) return () => {}

  const apply = () => {
    const top = Math.max(0, Number.parseFloat(getComputedStyle(el).top) || 0)
    const room = Math.max(0, view.clientHeight - top)
    el.setAttribute("data-sticky", String(room > 0 && el.getBoundingClientRect().height < room))
  }
  const observer = new ResizeObserver(apply)
  apply()
  observer.observe(el)
  observer.observe(view)
  return () => {
    observer.disconnect()
    el.removeAttribute("data-sticky")
  }
}
