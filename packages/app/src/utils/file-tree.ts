import type { FileNode } from "@opencode-ai/sdk/v2"

export const parentDir = (path: string) => {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return idx === -1 ? "" : path.slice(0, idx)
}

export const affectedTabs = (
  tabs: readonly string[],
  pathFromTab: (tab: string) => string | undefined,
  node: Pick<FileNode, "path" | "type">,
) =>
  tabs.filter((tab) => {
    const path = pathFromTab(tab)
    if (!path) return false
    if (node.type === "directory")
      return path === node.path || path.startsWith(node.path + "/") || path.startsWith(node.path + "\\")
    return path === node.path
  })
