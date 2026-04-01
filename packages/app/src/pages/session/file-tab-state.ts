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

export function editorValue(input: {
  draft?: string
  content: string
}) {
  if (input.draft !== undefined) return input.draft
  return input.content
}
