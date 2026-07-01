let dir = ""
const event = new EventTarget()

export const ActiveDirectory = {
  get() {
    return dir
  },
  set(next: string) {
    if (dir === next) return
    dir = next
    event.dispatchEvent(new Event("change"))
  },
  watch(fn: () => void) {
    event.addEventListener("change", fn)
    return () => {
      event.removeEventListener("change", fn)
    }
  },
}
