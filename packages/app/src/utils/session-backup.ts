import {
  createSessionBackup,
  formatTranscript,
  SessionBackupSchema,
  type TranscriptOptions,
} from "@opencode-ai/util/session-backup"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

type Row = {
  info: Message
  parts: Part[]
}

export type BackupFile = {
  path: string
  content: string
  type: string
}

export const BACKUP_WARN_BYTES = 50 * 1024 * 1024

export function sessionExportBlocked(status: { type: string }, pending: boolean) {
  return status.type !== "idle" || pending
}

export function formatBackupSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

export function backupStamp(date: Date) {
  const pad = (value: number) => value.toString().padStart(2, "0")
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("-")
}

export function backupStem(sessionID: string, date = new Date()) {
  return `session-${sessionID.slice(0, 8)}-${backupStamp(date)}`
}

export function buildBackupFiles(
  session: Session,
  messages: Row[],
  opts: {
    markdown: boolean
    transcript: TranscriptOptions
    date?: Date
  },
) {
  const stem = backupStem(session.id, opts.date)
  const files: BackupFile[] = [
    {
      path: `${stem}.json`,
      content: JSON.stringify(createSessionBackup(session, messages), null, 2) + "\n",
      type: "application/json",
    },
  ]
  if (!opts.markdown) return files
  return [
    ...files,
    {
      path: `${stem}.md`,
      content: formatTranscript(session, messages, opts.transcript),
      type: "text/markdown",
    },
  ]
}

export function parseBackup(text: string) {
  return SessionBackupSchema.parse(JSON.parse(text))
}

export function downloadBackup(file: BackupFile) {
  const url = URL.createObjectURL(new Blob([file.content], { type: `${file.type};charset=utf-8` }))
  const link = document.createElement("a")
  link.href = url
  link.download = file.path
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
