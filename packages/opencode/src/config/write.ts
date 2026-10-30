import fs from "fs/promises"
import path from "path"

type Change = { path: string; before?: string; after: string }

async function read(file: string) {
  return fs.readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined
    throw err
  })
}

// Stage every file before replacing any. The caller orders integrations before
// legacy config cleanup, so interruption cannot discard the migrated settings.
export async function write(changes: Change[]) {
  const files = await Promise.all(
    changes.map(async (file) => ({
      ...file,
      temp: `${file.path}.${crypto.randomUUID()}.tmp`,
      mode: await fs.stat(file.path).then(
        (stat) => stat.mode,
        () => 0o600,
      ),
    })),
  )
  const done: typeof files = []
  try {
    for (const file of files) {
      await fs.mkdir(path.dirname(file.path), { recursive: true })
      await fs.writeFile(file.temp, file.after, { mode: file.mode, flag: "wx" })
    }
    for (const file of files) {
      if ((await read(file.path)) !== file.before) throw new Error(`Config changed during save: ${file.path}`)
      await fs.rename(file.temp, file.path)
      done.push(file)
    }
  } catch (err) {
    const failures: unknown[] = []
    for (const file of done.toReversed()) {
      try {
        if ((await read(file.path)) !== file.after) throw new Error(`Config changed during rollback: ${file.path}`)
        if (file.before === undefined) {
          await fs.unlink(file.path)
          continue
        }
        await fs.writeFile(file.temp, file.before, { mode: file.mode, flag: "wx" })
        await fs.rename(file.temp, file.path)
      } catch (error) {
        failures.push(error)
        // Keep earlier writes, especially integrations, if a legacy copy could
        // not be restored. Removing them could discard the only surviving copy.
        break
      }
    }
    if (failures.length) throw new AggregateError([err, ...failures], "Config update and rollback failed")
    throw err
  } finally {
    await Promise.all(files.map((file) => fs.rm(file.temp, { force: true }).catch(() => undefined)))
  }
}
