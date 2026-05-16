export function buildWatcherHint(input: {
  tabs: string[]
  expanded?: string[]
  pathFromTab: (tab: string) => string | undefined
}) {
  const files = [...new Set(input.tabs.map((tab) => input.pathFromTab(tab)).filter((item): item is string => !!item))].sort()
  const dirs = [...new Set((input.expanded ?? []).filter((item) => item !== ""))].sort()
  return {
    files,
    dirs,
  }
}

export function watcherHintKey(input: {
  directory: string
  files: string[]
  dirs: string[]
}) {
  return JSON.stringify({
    directory: input.directory,
    files: input.files,
    dirs: input.dirs,
  })
}
