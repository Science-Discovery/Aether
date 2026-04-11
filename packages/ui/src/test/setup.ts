import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"

const modules = path.resolve(import.meta.dirname, "../../../../node_modules")

function findPackage(prefix: string, file: string): string {
  // Standard node_modules path (Windows Bun installs here directly)
  const standard = path.join(modules, file)
  if (fs.existsSync(standard)) return standard

  // Bun cache directory (Linux/macOS uses .bun for hoisted packages)
  const bunDir = path.join(modules, ".bun")
  const dir = fs
    .readdirSync(bunDir)
    .filter((item) => item.startsWith(prefix))
    .toSorted()
    .at(-1)
  if (!dir) throw new Error(`missing ${prefix} in ${bunDir}`)
  return path.join(bunDir, dir, "node_modules", file)
}

const mod = await import(
  pathToFileURL(findPackage("@happy-dom+global-registrator@", "@happy-dom/global-registrator/lib/index.js")).href
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
