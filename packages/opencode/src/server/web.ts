import nodePath from "path"

export function resolve(root: string, localPath: string) {
  const target = nodePath.resolve(nodePath.join(root, localPath === "/" ? "index.html" : localPath))
  const rel = nodePath.relative(nodePath.resolve(root), target)
  if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) return
  return target
}
