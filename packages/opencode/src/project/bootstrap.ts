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
import { SessionSummary } from "../session/summary"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await fs.mkdir(path.join(Instance.directory, PROJECT), { recursive: true })
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  File.init()
  FileWatcher.init()
  Vcs.init()
  Snapshot.init()
  await SessionRecovery.repairInterrupted().catch((error) => {
    Log.Default.warn("failed to repair interrupted assistant messages", { error })
  })
  SessionSummary.init()

  DbRecovery.runAfterStartup().catch((error) => {
    Log.Default.warn("db recovery failed", { error })
  })

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
