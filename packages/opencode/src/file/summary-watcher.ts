import * as path from "path"
import { Bus } from "../bus"
import { FileWatcher } from "./watcher"
import { FolderSummary } from "./summary"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

const log = Log.create({ service: "summary.watcher" })

const SUMMARY_FILE = ".summary"
const DEBOUNCE_MS = 2000

export namespace SummaryWatcher {
  export function init() {
    const pendingDirs = new Map<string, ReturnType<typeof setTimeout>>()

    Bus.subscribe(FileWatcher.Event.Updated, async ({ properties }) => {
      const file = properties.file

      // Don't react to .summary changes to avoid infinite loop
      if (path.basename(file) === SUMMARY_FILE) return

      const root = Instance.directory

      // Only care about files inside the project
      if (!file.startsWith(root)) return

      // Collect ancestor directories from the file's parent up to root
      const dirsToUpdate: string[] = []
      let dir = path.dirname(file)
      while (true) {
        dirsToUpdate.push(dir)
        if (dir === root) break
        const parent = path.dirname(dir)
        if (parent === dir) break // filesystem root, stop
        dir = parent
      }

      for (const targetDir of dirsToUpdate) {
        const summaryPath = path.join(targetDir, SUMMARY_FILE)
        const exists = await Filesystem.exists(summaryPath)
        if (!exists) continue

        // Debounce per directory
        const existing = pendingDirs.get(targetDir)
        if (existing !== undefined) clearTimeout(existing)

        pendingDirs.set(
          targetDir,
          setTimeout(async () => {
            pendingDirs.delete(targetDir)
            log.info("updating summary", { dir: targetDir })
            await FolderSummary.generate(targetDir, root).catch((err) => {
              log.error("failed to update summary", { dir: targetDir, error: err })
            })
          }, DEBOUNCE_MS),
        )
      }
    })

    log.info("init")
  }
}
