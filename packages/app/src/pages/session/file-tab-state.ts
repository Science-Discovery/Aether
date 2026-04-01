import { checksum } from "@opencode-ai/util/encode"

export function canRestoreEditor(input: {
  ready: boolean
  loaded: boolean
  text: boolean
  editing: boolean
}) {
  if (!input.ready) return false
  if (!input.loaded) return false
  if (!input.text) return false
  return input.editing
}

function sum(content: string) {
  return checksum(content) ?? ""
}

export function draftState(input: {
  ready: boolean
  loaded: boolean
  text: boolean
  editing: boolean
  draft?: string
  draftBase?: string
  content: string
}) {
  if (!canRestoreEditor(input)) return "closed" as const
  if (input.draft === undefined) return "fresh" as const
  if (input.draftBase === undefined) return "stale" as const
  if (input.draftBase !== sum(input.content)) return "stale" as const
  return "fresh" as const
}

export function editorValue(input: {
  draft?: string
  content: string
}) {
  if (input.draft !== undefined) return input.draft
  return input.content
}
