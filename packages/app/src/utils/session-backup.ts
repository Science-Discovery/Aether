import { createSessionBackup, formatTranscript, SessionBackupSchema, type TranscriptOptions } from "@opencode-ai/util/session-backup"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

type Row = {
  info: Message
  parts: Part[]
}

export function backupStem(sessionID: string) {
  return `session-${sessionID.slice(0, 8)}`
}

export function buildBackup(session: Session, messages: Row[]) {
  return createSessionBackup(
    session,
    messages.map((msg) => ({
      info: msg.info,
      parts: msg.parts,
    })),
  )
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
  const json = JSON.stringify(buildBackup(session, messages), null, 2) + "\n"
  const files = [
    {
      path: `${stem}.json`,
      content: json,
    },
  ]

  if (!opts.markdown) return files
  return [
    ...files,
    {
      path: `${stem}.md`,
      content: formatTranscript(session, messages, opts.transcript),
    },
  ]
}

export function parseBackup(text: string) {
  return SessionBackupSchema.parse(JSON.parse(text))
}
