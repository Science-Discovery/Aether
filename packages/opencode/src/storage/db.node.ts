import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"
import { mkdirSync } from "fs"
import path from "path"

function dir(file: string) {
  if (file === ":memory:") return
  mkdirSync(path.dirname(file), { recursive: true })
}

export function init(path: string) {
  dir(path)
  const sqlite = new DatabaseSync(path)
  const db = drizzle({ client: sqlite })
  return db
}
