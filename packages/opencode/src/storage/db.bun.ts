import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { mkdirSync } from "fs"
import path from "path"

function dir(file: string) {
  if (file === ":memory:") return
  mkdirSync(path.dirname(file), { recursive: true })
}

export function init(path: string) {
  dir(path)
  const sqlite = new Database(path, { create: true })
  const db = drizzle({ client: sqlite })
  return db
}
