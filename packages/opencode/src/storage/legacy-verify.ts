import { Database as Sqlite } from "bun:sqlite"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { LegacyDB } from "@/storage/legacy-db"

const ranks = {
  local: 0,
  dev: 1,
  beta: 2,
  latest: 3,
}

function source(name: string) {
  return /^opencode.*\.db$/i.test(name)
}

function rank(name: string) {
  const file = path.basename(name).toLowerCase()
  if (file === "opencode.db") return ranks.latest
  const hit = /^opencode-(.+)\.db$/i.exec(file)?.[1] || ""
  return ranks[hit as keyof typeof ranks] ?? 2
}

function has(db: Sqlite, name: string) {
  const row = db.query("select 1 as ok from sqlite_master where type='table' and name=?").get(name) as { ok: number } | null
  return !!row
}

function open(file: string) {
  return new Sqlite(file, { readonly: true })
}

function sessionRows(db: Sqlite) {
  if (!has(db, "session")) return []
  return db.query("select id, project_id, workspace_id, directory, title, version, time_created, time_updated from session").all() as {
    id: string
    project_id: string
    workspace_id: string | null
    directory: string
    title: string
    version: string
    time_created: number
    time_updated: number
  }[]
}

function projectRows(db: Sqlite) {
  if (!has(db, "project")) return []
  return db.query("select id, worktree, vcs, name from project").all() as {
    id: string
    worktree: string
    vcs: string | null
    name: string | null
  }[]
}

function workspaceRows(db: Sqlite) {
  if (!has(db, "workspace")) return []
  return db.query("select id, project_id, type, branch, name, directory from workspace").all() as {
    id: string
    project_id: string
    type: string
    branch: string | null
    name: string | null
    directory: string | null
  }[]
}

function messageCount(db: Sqlite) {
  if (!has(db, "message")) return new Map<string, number>()
  const rows = db.query("select session_id, count(*) as count from message group by session_id").all() as {
    session_id: string
    count: number
  }[]
  return new Map(rows.map((row) => [row.session_id, row.count]))
}

function better(a: Candidate, b: Candidate) {
  if (a.row.time_updated !== b.row.time_updated) return a.row.time_updated > b.row.time_updated
  if (a.row.time_created !== b.row.time_created) return a.row.time_created > b.row.time_created
  if (rank(a.file) !== rank(b.file)) return rank(a.file) > rank(b.file)
  return a.file.localeCompare(b.file) > 0
}

type Candidate = {
  file: string
  row: ReturnType<typeof sessionRows>[number]
  project?: ReturnType<typeof projectRows>[number]
  workspace?: ReturnType<typeof workspaceRows>[number]
  messages: number
}

export namespace LegacyVerify {
  export const Report = z.object({
    ok: z.boolean(),
    sessions: z.number(),
    checked: z.number(),
    errors: z.array(z.string()),
  })
  export type Report = z.infer<typeof Report>

  export async function run(): Promise<Report> {
    const dir = Global.Path.data
    const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const files = rows.filter((row) => row.isFile() && source(row.name)).map((row) => path.join(dir, row.name))
    const target = LegacyDB.targetPath()
    const targetDb = open(target)
    try {
      const targetSessions = new Map(sessionRows(targetDb).map((row) => [row.id, row]))
      const targetProjects = new Map(projectRows(targetDb).map((row) => [row.id, row]))
      const targetWorkspaces = new Map(workspaceRows(targetDb).map((row) => [row.id, row]))
      const targetMessages = messageCount(targetDb)
      const all = new Map<string, Candidate[]>()

      for (const file of files) {
        const db = open(file)
        try {
          const projects = new Map(projectRows(db).map((row) => [row.id, row]))
          const spaces = new Map(workspaceRows(db).map((row) => [row.id, row]))
          const counts = messageCount(db)
          for (const row of sessionRows(db)) {
            const item: Candidate = {
              file,
              row,
              project: projects.get(row.project_id),
              workspace: row.workspace_id ? spaces.get(row.workspace_id) : undefined,
              messages: counts.get(row.id) ?? 0,
            }
            const list = all.get(row.id) ?? []
            list.push(item)
            all.set(row.id, list)
          }
        } finally {
          db.close()
        }
      }

      const errors: string[] = []
      for (const [id, list] of all) {
        const win = list.reduce((best, item) => (better(item, best) ? item : best))
        const row = targetSessions.get(id)
        if (!row) {
          errors.push(`missing-session:${id}`)
          continue
        }
        if (row.directory !== win.row.directory) errors.push(`session-directory-mismatch:${id}`)
        if (row.title !== win.row.title) errors.push(`session-title-mismatch:${id}`)
        if (row.version !== win.row.version) errors.push(`session-version-mismatch:${id}`)

        const project = targetProjects.get(row.project_id)
        if (!project) {
          errors.push(`missing-project:${id}`)
          continue
        }
        if (win.project && project.worktree !== win.project.worktree) {
          errors.push(`project-worktree-mismatch:${id}`)
        }

        if (win.workspace) {
          const space = row.workspace_id ? targetWorkspaces.get(row.workspace_id) : undefined
          if (!space) {
            errors.push(`missing-workspace:${id}`)
          } else {
            if (space.type !== win.workspace.type) errors.push(`workspace-type-mismatch:${id}`)
            if ((space.branch || "") !== (win.workspace.branch || "")) errors.push(`workspace-branch-mismatch:${id}`)
            if ((space.directory || "") !== (win.workspace.directory || "")) errors.push(`workspace-directory-mismatch:${id}`)
            const parent = targetProjects.get(space.project_id)
            if (!parent || win.project?.worktree && parent.worktree !== win.project.worktree) {
              errors.push(`workspace-project-mismatch:${id}`)
            }
          }
        }

        const targetCount = targetMessages.get(id) ?? 0
        if (targetCount < win.messages) errors.push(`message-count-mismatch:${id}`)
      }

      return {
        ok: errors.length === 0,
        sessions: all.size,
        checked: all.size - errors.filter((item) => item.startsWith("missing-session:")).length,
        errors,
      }
    } finally {
      targetDb.close()
    }
  }
}
