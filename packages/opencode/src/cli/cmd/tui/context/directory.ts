import { createMemo } from "solid-js"
import { useSync } from "./sync"
import { Global } from "@/global"

function tuiDisplayPath(directory: string, home: string) {
  const normDir = directory.replace(/\\/g, "/")
  const normHome = home.replace(/\\/g, "/")
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
