import { release } from "os"
import path from "path"

export function wsl(input: string, rel = release()) {
  if (!rel.toUpperCase().includes("WSL")) return input

  const next = input.replaceAll("\\", "/")
  const match = next.match(/^([a-zA-Z]):(?:\/(.*))?$/)
  if (!match) return input

  const rest = match[2] ? `/${match[2]}` : ""
  return `/mnt/${match[1].toLowerCase()}${rest}`
}

export function resolveInput(root: string, input: string, rel = release()) {
  const next = wsl(input, rel)
  if (path.isAbsolute(next)) return next
  return path.resolve(root, next)
}
