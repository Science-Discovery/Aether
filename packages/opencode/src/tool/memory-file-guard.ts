import path from "path"
import { Global } from "@/global"

const MEMORY_TOOL_HINT = "Use memory_search for memory recall instead of reading Aether memory files directly."

export function memoryStorageRoot() {
  return path.resolve(Global.Path.data, "memory")
}

function isSameOrChild(parent: string, target: string) {
  const relative = path.relative(parent, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function isMemoryStoragePath(target: string) {
  return isSameOrChild(memoryStorageRoot(), path.resolve(target))
}

export function assertNotMemoryStoragePath(tool: string, target: string) {
  if (!isMemoryStoragePath(target)) return
  throw new Error(`${tool} cannot access Aether memory storage. ${MEMORY_TOOL_HINT}`)
}

export function commandMentionsMemoryStorage(command: string) {
  const root = memoryStorageRoot()
  const home = path.resolve(Global.Path.home)
  const relativeToHome = isSameOrChild(home, root) ? path.relative(home, root).split(path.sep).join("/") : ""
  const normalized = command.replace(/\\/g, "/")
  const exactForms = [
    root.replace(/\\/g, "/"),
    relativeToHome ? `~/${relativeToHome}` : "",
    relativeToHome ? `$HOME/${relativeToHome}` : "",
    relativeToHome ? `\${HOME}/${relativeToHome}` : "",
  ].filter(Boolean)

  if (exactForms.some((item) => normalized.includes(item))) return true
  if (!/\.local\/share\/aether/.test(normalized)) return false
  if (/\b(USER|MEMORY)\.md\b/i.test(normalized)) return true
  return /\b(find|fd|rg|grep|ls|cat|stat|sed|awk|head|tail)\b/.test(normalized) && /memory|\.md|\*/i.test(normalized)
}

export function assertCommandDoesNotMentionMemoryStorage(tool: string, command: string) {
  if (!commandMentionsMemoryStorage(command)) return
  throw new Error(`${tool} cannot access Aether memory storage. ${MEMORY_TOOL_HINT}`)
}

export function memoryStorageExcludeGlobs(searchRoot: string) {
  const root = memoryStorageRoot()
  const search = path.resolve(searchRoot)
  if (isMemoryStoragePath(search)) return []
  if (!isSameOrChild(search, root)) return []

  const relative = path.relative(search, root).split(path.sep).join("/")
  if (!relative) return []
  return [`!${relative}/**`]
}
