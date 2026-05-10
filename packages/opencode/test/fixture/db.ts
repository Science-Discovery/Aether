import { rm } from "fs/promises"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"

export async function resetDatabase() {
  await Instance.disposeAll().catch(() => undefined)
  Database.close()
  await rm(Database.Path, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-wal`, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-shm`, { force: true }).catch(() => undefined)
  const channelDir = Database.channelDir()
  for (const p of Database.projectPaths()) {
    await rm(p, { force: true }).catch(() => undefined)
    await rm(`${p}-wal`, { force: true }).catch(() => undefined)
    await rm(`${p}-shm`, { force: true }).catch(() => undefined)
  }
  const cronPath = Database.cronPath()
  await rm(cronPath, { force: true }).catch(() => undefined)
  await rm(`${cronPath}-wal`, { force: true }).catch(() => undefined)
  await rm(`${cronPath}-shm`, { force: true }).catch(() => undefined)
  await rm(channelDir, { force: true, recursive: true }).catch(() => undefined)
}
