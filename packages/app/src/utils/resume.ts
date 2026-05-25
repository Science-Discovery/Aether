const name = "opencode:resume"

export const Resume = {
  emit() {
    window.dispatchEvent(new Event(name))
  },
  on(fn: () => void) {
    window.addEventListener(name, fn)
    return () => window.removeEventListener(name, fn)
  },
}
