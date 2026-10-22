import type { CliOptions } from "./opencode"
import * as opencode from "./opencode"

export const pinned = opencode.pinned.kilo

export function parse(path: string) {
  return opencode.parse(path, "kilo")
}

export function list(options?: CliOptions) {
  return opencode.list("kilo", options)
}

export function exportSession(id: string, options?: CliOptions) {
  return opencode.exportSession(id, "kilo", options)
}
