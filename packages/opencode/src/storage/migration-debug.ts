import { appendFileSync, mkdirSync } from "fs"
import nodePath from "path"
import { Global } from "@/global"
import { Installation } from "@/installation"

export namespace MigrationDebug {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dir = nodePath.join(Global.Path.cache, "migration_debug_log")
  const file = nodePath.join(dir, `${stamp}-${process.pid}.jsonl`)

  function err(input: unknown) {
    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
        stack: input.stack,
        cause: input.cause instanceof Error ? input.cause.message : String(input.cause ?? ""),
      }
    }
    return input
  }

  function text(input: unknown) {
    return JSON.stringify(input, (_key, value) => {
      if (value instanceof Error) return err(value)
      if (typeof value === "bigint") return value.toString()
      return value
    })
  }

  export function filepath() {
    return file
  }

  export function write(event: string, data: Record<string, unknown> = {}) {
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(
        file,
        `${text({
          time: new Date().toISOString(),
          pid: process.pid,
          event,
          channel: Installation.CHANNEL,
          version: Installation.VERSION,
          cwd: process.cwd(),
          data: Global.Path.data,
          cache: Global.Path.cache,
          ...data,
        })}\n`,
      )
    } catch {}
  }

  export function error(event: string, error: unknown, data: Record<string, unknown> = {}) {
    write(event, { ...data, error: err(error) })
  }
}
