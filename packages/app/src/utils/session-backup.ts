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

export function backupStem(sessionID: string) {
  return `session-${sessionID.slice(0, 8)}`
}

export function buildBackupFiles(
  session: Session,
  messages: Row[],
  opts: {
    markdown: boolean
    transcript: TranscriptOptions
  },
) {
  const stem = backupStem(session.id)
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
