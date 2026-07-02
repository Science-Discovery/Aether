import fs from "fs/promises"
import path from "path"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Snapshot } from "../snapshot"
import { Project } from "./project"
import { Vcs } from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { PROJECT } from "@/persist/naming"
import { SessionRecovery } from "@/session/recovery"
import { DbRecovery } from "@/storage/db-recovery"
import { ActiveInstance } from "@/project/active-instance"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await fs.mkdir(path.join(Instance.directory, PROJECT), { recursive: true })

  ShareNext.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  FileWatcher.initGit()

  await SessionRecovery.repairInterrupted().catch((error) => {
    Log.Default.warn("failed to repair interrupted assistant messages", { error })
  })

  const dir = Instance.directory
  const cleanups = Instance.state(
    () => [] as Array<() => void>,
    async (list) => {
      list.forEach((fn) => fn())
    },
  )()
  const deferred = () => {
    Format.init()
    Plugin.init()
    LSP.init()
    FileWatcher.initFull()
  }

  if (ActiveInstance.is(dir)) {
    deferred()
  } else {
    cleanups.push(
      ActiveInstance.subscribe((activated) => {
        if (activated !== dir) return
        Instance.provide({ directory: dir, fn: deferred, create: false })
      }),
    )
  }

  cleanups.push(
    ActiveInstance.onDeactivate((deactivated) => {
      if (deactivated !== dir) return
      Instance.provide({ directory: dir, fn: () => FileWatcher.deactivateFull(), create: false })
    }),
  )

  DbRecovery.runAfterStartup().catch((error) => {
    Log.Default.warn("db recovery failed", { error })
  })

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
