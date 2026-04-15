import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "../util/filesystem"
import { Persist } from "@/persist/naming"

const data = Persist.current.data
const cache = Persist.current.cache
const config = Persist.current.config
const state = Persist.current.state

export namespace Global {
  export const Path = {
    // Allow override via OPENCODE_TEST_HOME for test isolation
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
  }

  export async function ensureDirs() {
    await Promise.all([
      fs.mkdir(Path.data, { recursive: true }),
      fs.mkdir(Path.config, { recursive: true }),
      fs.mkdir(Path.state, { recursive: true }),
      fs.mkdir(Path.log, { recursive: true }),
      fs.mkdir(Path.bin, { recursive: true }),
    ])

    const version = await Filesystem.readText(path.join(Path.cache, "version")).catch(() => "0")
    if (version === CACHE_VERSION) return

    try {
      const rows = await fs.readdir(Path.cache)
      await Promise.all(
        rows.map((row) =>
          fs.rm(path.join(Path.cache, row), {
            recursive: true,
            force: true,
          }),
        ),
      )
    } catch {}

    await Filesystem.write(path.join(Path.cache, "version"), CACHE_VERSION)
  }
}

const CACHE_VERSION = "21"
