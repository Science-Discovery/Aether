import {
  formatAssistantHeader,
  formatPart,
  formatTranscript as sharedFormatTranscript,
  formatMessage as sharedFormatMessage,
  type TranscriptMessage as MessageWithParts,
  type TranscriptOptions,
  type TranscriptSession as SessionInfo,
} from "@opencode-ai/util/session-backup"

export { formatAssistantHeader, formatPart, type MessageWithParts, type SessionInfo, type TranscriptOptions }

export function formatMessage(msg: MessageWithParts["info"], parts: MessageWithParts["parts"], opts: TranscriptOptions) {
  return sharedFormatMessage({ info: msg, parts }, opts)
}

export function formatTranscript(session: SessionInfo, messages: MessageWithParts[], opts: TranscriptOptions) {
  return sharedFormatTranscript(session, messages, opts)
}
