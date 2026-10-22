import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import { parseSessionBackup } from "@opencode-ai/util/session-backup"
import { Session } from "../../session"
import { importSessionBackup } from "../../session/backup"
import { MessageV2 } from "../../session/message-v2"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { detect, detectFile, inspect, list, name, read } from "../../migrate"
import { MigrateError } from "../../migrate/error"
import { sourceFormats as sources, type ParsedSession, type SessionRef, type SourceFormat } from "../../migrate/model"
import { buildBackup } from "../../migrate/target"
import { cmd } from "./cmd"
import { resolve } from "node:path"



function source(value: unknown): SourceFormat | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string" && (sources as readonly string[]).includes(value)) return value as SourceFormat
  throw new MigrateError(`unknown source: ${String(value)}`)
}

export const MigrateCommand = cmd({
  command: "migrate",
  describe: "import sessions from other AI coding apps",
  builder: (yargs: Argv) =>
    yargs
      .command(MigrateSourcesCommand)
      .command(MigrateListCommand)
      .command(MigrateInspectCommand)
      .command(MigrateImportCommand)
      .demandCommand(),
  async handler() {},
})

export const MigrateSourcesCommand = cmd({
  command: "sources",
  describe: "show detected source data directories",
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", describe: "output JSON" }),
  async handler(args) {
    try {
      const result = await detect()
      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (!result.length) {
        UI.println("No supported source data directories found.")
        return
      }
      for (const item of result) {
        UI.println(`${item.name} (${item.id})`)
        for (const root of item.roots) {
          const count = item.sessions === undefined ? "?" : String(item.sessions)
          UI.println(`  ${root.path} [${root.origin}] ${count} session(s)`)
        }
      }
    } catch (error) {
      fail(error)
    }
  },
})

export const MigrateListCommand = cmd({
  command: "list",
  describe: "list importable sessions",
  builder: (yargs: Argv) =>
    yargs
      .option("source", { type: "string", choices: sources, describe: "source app" })
      .option("root", { type: "string", describe: "explicit source data root" })
      .option("limit", { type: "number", default: 20, describe: "maximum sessions to show" })
      .option("json", { type: "boolean", describe: "output JSON" }),
  async handler(args) {
    try {
      const selected = source(args.source)
      if (args.root && !selected) throw new MigrateError("--root requires --source")
      const targets = selected ? [selected] : (await detect()).map((item) => item.id)
      const found: SessionRef[] = []
      for (const item of targets) {
        try {
          found.push(...(await list(item, undefined, { root: args.root, limit: args.limit, titles: true })))
        } catch (error) {
          if (selected) throw error
        }
      }
      found.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      const limited = found.slice(0, args.limit)
      if (args.json) {
        console.log(JSON.stringify(limited, null, 2))
        return
      }
      if (!limited.length) {
        UI.println("No sessions found.")
        return
      }
      for (const ref of limited) {
        const updated = ref.updated ? new Date(ref.updated).toLocaleString() : "unknown"
        UI.println(`${ref.source}\t${ref.id}\t${ref.title ?? ""}\t${updated}\t${ref.path}`)
      }
    } catch (error) {
      fail(error)
    }
  },
})

export const MigrateInspectCommand = cmd({
  command: "inspect <path>",
  describe: "inspect a source session without importing it",
  builder: (yargs: Argv) =>
    yargs
      .positional("path", { type: "string", demandOption: true, describe: "source session file" })
      .option("source", { type: "string", choices: sources, describe: "source app" })
      .option("json", { type: "boolean", describe: "output JSON" }),
  async handler(args) {
    try {
      const session = await inspect(resolve(args.path), source(args.source))
      const summary = summarize(session)
      if (args.json) {
        console.log(JSON.stringify(summary, null, 2))
        return
      }
      UI.println(`Source: ${summary.source}`)
      UI.println(`Session: ${summary.sessionID ?? "unknown"}`)
      UI.println(`Title: ${summary.title ?? ""}`)
      UI.println(`CWD: ${summary.cwd ?? ""}`)
      UI.println(`Started: ${summary.startedAt ?? ""}`)
      UI.println(`CLI version: ${summary.cliVersion ?? ""}`)
      UI.println(`Events: ${summary.events}`)
      UI.println(`Kinds: ${JSON.stringify(summary.kinds)}`)
      UI.println(`Opaque: ${JSON.stringify(summary.opaque)}`)
    } catch (error) {
      fail(error)
    }
  },
})

export const MigrateImportCommand = cmd({
  command: "import",
  describe: "import a session from another AI coding app",
  builder: (yargs: Argv) =>
    yargs
      .option("source", { type: "string", choices: sources, describe: "source app" })
      .option("session", { type: "string", describe: "source session ID" })
      .option("path", { type: "string", describe: "source session file" })
      .option("root", { type: "string", describe: "explicit source data root" })
      .option("source-cli", { type: "string", describe: "OpenCode/Kilo CLI executable used for export" })
      .option("project-dir", { type: "string", describe: "target project directory (defaults to cwd)" })
      .option("dry-run", { type: "boolean", describe: "parse and validate without writing" })
      .option("json", { type: "boolean", describe: "output JSON" }),
  async handler(args) {
    try {
      const path = args.path ? resolve(args.path) : undefined
      const selected = source(args.source) ?? (path ? await detectFile(path) : undefined)
      if (!selected) throw new MigrateError("pass --source when the source format cannot be detected")

      let id = args.session
      if (!path && !id) {
        if (!process.stdin.isTTY) throw new MigrateError("pass --session or --path when not running interactively")
        const refs = await list(selected, undefined, { root: args.root, limit: 100, titles: true })
        if (!refs.length) throw new MigrateError(`no ${name(selected)} sessions found`)
        const value = await prompts.autocomplete({
          message: `Select ${name(selected)} session`,
          maxItems: 15,
          options: refs.slice(0, 100).map((ref) => ({
            label: ref.title ?? ref.id,
            value: ref.id,
            hint: `${ref.id}${ref.updated ? ` • ${new Date(ref.updated).toLocaleString()}` : ""}`,
          })),
          output: process.stderr,
        })
        if (prompts.isCancel(value)) return
        id = value
      }

      const session = await read(selected, {
        path,
        id,
        root: args.root,
        cli: args.sourceCli,
      })
      const projectDir = resolve(args.projectDir ?? process.cwd())
      const result = buildBackup(session, { directory: projectDir })

      validate(result.backup)
      if (args.json) {
        if (args.dryRun) console.log(JSON.stringify({ manifest: result.manifest, dryRun: true }, null, 2))
      } else {
        UI.println(`Source: ${result.manifest.source}`)
        UI.println(`Session: ${result.manifest.sessionID ?? "unknown"}`)
        UI.println(`Title: ${result.manifest.title ?? ""}`)
        UI.println(`Messages: ${result.manifest.messages}`)
        UI.println(`Parts: ${result.manifest.parts}`)
        UI.println(`Events: ${result.manifest.events}`)
        UI.println(`Loss: ${JSON.stringify(result.manifest.loss)}`)
      }
      if (args.dryRun) return

      const imported = await bootstrap(projectDir, () => importSessionBackup(result.backup))
      if (args.json) {
        console.log(JSON.stringify({ manifest: result.manifest, imported }, null, 2))
      } else {
        UI.println(`Imported session: ${imported.sessionID} (${imported.title})`)
      }
    } catch (error) {
      fail(error)
    }
  },
})

function validate(backup: ReturnType<typeof buildBackup>["backup"]) {
  const data = parseSessionBackup(backup)
  Session.Info.parse(data.info)
  for (const message of data.messages) {
    MessageV2.Info.parse(message.info)
    for (const part of message.parts) MessageV2.Part.parse(part)
  }
}

function summarize(session: ParsedSession) {
  const kinds: Record<string, number> = {}
  const opaque: Record<string, number> = {}
  for (const event of session.events) {
    kinds[event.kind] = (kinds[event.kind] ?? 0) + 1
    if (event.kind !== "opaque") continue
    const reason = typeof event.payload.reason === "string" ? event.payload.reason : "unknown"
    opaque[reason] = (opaque[reason] ?? 0) + 1
  }
  return {
    source: session.source,
    path: session.path,
    sha256: session.sha256,
    sessionID: session.sessionID,
    title: session.title,
    cwd: session.cwd,
    startedAt: session.startedAt,
    cliVersion: session.cliVersion,
    model: session.model,
    provider: session.provider,
    events: session.events.length,
    rawRecordCount: session.rawRecordCount,
    kinds,
    opaque,
  }
}

function fail(error: unknown) {
  UI.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
