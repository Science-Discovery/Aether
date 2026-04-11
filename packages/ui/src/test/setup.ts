import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"

const root = path.resolve(import.meta.dirname, "../../../../node_modules/.bun")

const pick = (prefix: string, file: string) => {
  const dir = fs
    .readdirSync(root)
    .filter((item) => item.startsWith(prefix))
    .toSorted()
    .at(-1)
  if (!dir) throw new Error(`missing ${prefix} in ${root}`)
  return path.join(root, dir, file)
}

const mod = await import(
  pathToFileURL(pick("@happy-dom+global-registrator@", "node_modules/@happy-dom/global-registrator/lib/index.js")).href
)

mod.GlobalRegistrator.register()

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver
}

if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {}
}

if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {}
}

if (!HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function (input?: ScrollToOptions | number, y?: number) {
    if (typeof input === "number") {
      this.scrollLeft = input
      this.scrollTop = y ?? 0
      return
    }
    this.scrollLeft = input?.left ?? this.scrollLeft
    this.scrollTop = input?.top ?? this.scrollTop
  }
}

if (!HTMLElement.prototype.scrollBy) {
  HTMLElement.prototype.scrollBy = function (input?: ScrollToOptions | number, y?: number) {
    if (typeof input === "number") {
      this.scrollLeft += input
      this.scrollTop += y ?? 0
      return
    }
    this.scrollLeft += input?.left ?? 0
    this.scrollTop += input?.top ?? 0
  }
}
