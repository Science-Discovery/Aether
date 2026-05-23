import { createMemo } from "solid-js"
import { useSync } from "./sync"
import { Global } from "@/global"
import { ProjectIdentity } from "@/project/identity"

function tuiDisplayPath(directory: string, home: string) {
  const normDir = ProjectIdentity.norm(directory)
  const normHome = ProjectIdentity.norm(home)
  return normDir.startsWith(normHome) ? "~" + normDir.slice(normHome.length) : normDir
}

export function useDirectory() {
  const sync = useSync()
  return createMemo(() => {
    const directory = sync.data.path.directory || process.cwd()
    const result = tuiDisplayPath(directory, Global.Path.home)
    if (sync.data.vcs?.branch) return result + ":" + sync.data.vcs.branch
    return result
  })
}
