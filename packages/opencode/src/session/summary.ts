import { fn } from "@/util/fn"
import z from "zod"
import { Session } from "."

import { MessageV2 } from "./message-v2"
import { Identifier } from "@/id/id"
import { SessionID, MessageID } from "./schema"
import { Snapshot } from "@/snapshot"

import { Storage } from "@/storage/storage"
import { Bus } from "@/bus"
import { NotFoundError } from "@/storage/db"

export namespace SessionSummary {
  // In-memory dedup: skip setSummary + Storage.write + Bus.publish when the
  // new summary tuple AND the structural diff fingerprint both match the last
  // values published for this session. Without dedup, every step-finish inside
  // the prompt loop republishes an unchanged session.diff plus a session.updated,
  // which on the web UI triggers review/VCS refetch cascades and re-renders.
  //
  // The cache is invalidated/refreshed by `invalidate()` so that any other path
  // publishing Session.Event.Diff (revert, unrevert, manual diff API) keeps the
  // dedup state honest. Entries are removed on Session.Event.Deleted; see init().
  type DiffCacheEntry = {
    additions: number
    deletions: number
    files: number
    fingerprint: string
  }
  const lastDiff = new Map<SessionID, DiffCacheEntry>()

  function fingerprintDiffs(diffs: Snapshot.FileDiff[]): string {
    // Order-independent: callers do not guarantee a stable file order across
    // runs. Each tuple is JSON-encoded so file names containing whitespace,
    // numbers, or other separators cannot collide with adjacent fields.
    return diffs
      .map((d) => JSON.stringify([d.file, d.additions, d.deletions]))
      .sort()
      .join("\n")
  }

  function summaryOf(diffs: Snapshot.FileDiff[]) {
    return {
      additions: diffs.reduce((sum, x) => sum + x.additions, 0),
      deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
      files: diffs.length,
    }
  }

  /**
   * Refresh or drop the dedup state for `sessionID`.
   *
   * Call from any path that publishes Session.Event.Diff *outside*
   * summarizeSession (revert, unrevert, manual diff API). Passing `latest`
   * advances the cache to that payload so a follow-up summarize() with the
   * same content correctly dedupes; omitting `latest` clears the entry.
   */
  export function invalidate(sessionID: SessionID, latest?: Snapshot.FileDiff[]) {
    if (!latest) {
      lastDiff.delete(sessionID)
      return
    }
    lastDiff.set(sessionID, {
      ...summaryOf(latest),
      fingerprint: fingerprintDiffs(latest),
    })
  }

  export function init() {
    Bus.subscribe(Session.Event.Deleted, ({ properties }) => {
      lastDiff.delete(properties.sessionID)
    })
  }

  function unquoteGitPath(input: string) {
    if (!input.startsWith('"')) return input
    if (!input.endsWith('"')) return input
    const body = input.slice(1, -1)
    const bytes: number[] = []

    for (let i = 0; i < body.length; i++) {
      const char = body[i]!
      if (char !== "\\") {
        bytes.push(char.charCodeAt(0))
        continue
      }

      const next = body[i + 1]
      if (!next) {
        bytes.push("\\".charCodeAt(0))
        continue
      }

      if (next >= "0" && next <= "7") {
        const chunk = body.slice(i + 1, i + 4)
        const match = chunk.match(/^[0-7]{1,3}/)
        if (!match) {
          bytes.push(next.charCodeAt(0))
          i++
          continue
        }
        bytes.push(parseInt(match[0], 8))
        i += match[0].length
        continue
      }

      const escaped =
        next === "n"
          ? "\n"
          : next === "r"
            ? "\r"
            : next === "t"
              ? "\t"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next === "v"
                    ? "\v"
                    : next === "\\" || next === '"'
                      ? next
                      : undefined

      bytes.push((escaped ?? next).charCodeAt(0))
      i++
    }

    return Buffer.from(bytes).toString()
  }

  export const summarize = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
    async (input) => {
      await Session.messages({ sessionID: input.sessionID })
        .then((all) =>
          Promise.all([
            summarizeSession({ sessionID: input.sessionID, messages: all }),
            summarizeMessage({ messageID: input.messageID, messages: all }),
          ]),
        )
        .catch((err) => {
          if (NotFoundError.isInstance(err)) return
          throw err
        })
    },
  )

  async function summarizeSession(input: { sessionID: SessionID; messages: MessageV2.WithParts[] }) {
    // Only store session_diff_from when it does not already exist.
    // A baseline snapshot is recorded at session creation; preserving it
    // ensures human edits made before the first AI step are included.
    const existing = await Storage.read<string>(["session_diff_from", input.sessionID]).catch(() => undefined)
    const from = firstSnapshot(input.messages)
    if (from && !existing) {
      await Storage.write(["session_diff_from", input.sessionID], from).catch(() => {})
    }

    // Prefer a full diff from the session baseline to the current working
    // tree so that human edits made before the first AI step are included.
    const baseline = existing ?? from
    let diffs: Snapshot.FileDiff[]
    if (baseline) {
      const to = await Snapshot.track()
      diffs = to ? await Snapshot.diffFull(baseline, to) : await computeDiff({ messages: input.messages })
    } else {
      diffs = await computeDiff({ messages: input.messages })
    }

    const summary = summaryOf(diffs)
    const fingerprint = fingerprintDiffs(diffs)
    const prev = lastDiff.get(input.sessionID)
    if (
      prev &&
      prev.fingerprint === fingerprint &&
      prev.additions === summary.additions &&
      prev.deletions === summary.deletions &&
      prev.files === summary.files
    ) {
      // Identical to the last published payload; skip both setSummary and
      // session.diff so we don't storm the web UI during step-finish bursts.
      // session.updated still ticks via message/part updates from the same loop.
      return
    }

    await Session.setSummary({ sessionID: input.sessionID, summary })
    await Storage.write(["session_diff", input.sessionID], diffs)
    lastDiff.set(input.sessionID, { ...summary, fingerprint })
    Bus.publish(Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
  }

  async function summarizeMessage(input: { messageID: string; messages: MessageV2.WithParts[] }) {
    const messages = input.messages.filter(
      (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
    )
    const msgWithParts = messages.find((m) => m.info.id === input.messageID)
    if (!msgWithParts) return
    const userMsg = msgWithParts.info as MessageV2.User
    const diffs = await computeDiff({ messages })
    userMsg.summary = {
      ...userMsg.summary,
      diffs,
    }
    await Session.updateMessage(userMsg)
  }

  function firstSnapshot(messages: MessageV2.WithParts[]) {
    for (const item of messages) {
      for (const part of item.parts) {
        if (part.type === "step-start" && part.snapshot) return part.snapshot
      }
    }
    return undefined
  }

  export const diff = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod.optional(),
    }),
    async (input) => {
      let from = await Storage.read<string>(["session_diff_from", input.sessionID]).catch(() => undefined)

      // Backward-compat: for sessions created before the baseline snapshot
      // was recorded at creation time, try to derive one from messages.
      if (!from) {
        const msgs = await Session.messages({ sessionID: input.sessionID })
        from = firstSnapshot(msgs)
        if (from) {
          await Storage.write(["session_diff_from", input.sessionID], from).catch(() => {})
        }
      }

      if (from) {
        const to = await Snapshot.track()
        if (to) {
          const diffs = await Snapshot.diffFull(from, to)
          await Storage.write(["session_diff", input.sessionID], diffs)
          // Keep the dedup cache in sync so the next summarize() with the
          // same payload correctly suppresses a duplicate session.diff.
          invalidate(input.sessionID, diffs)
          Bus.publish(Session.Event.Diff, {
            sessionID: input.sessionID,
            diff: diffs,
          })
          return diffs
        }
      }
      const diffs = await Storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).catch(() => [])
      const next = diffs.map((item) => {
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return {
          ...item,
          file,
        }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) Storage.write(["session_diff", input.sessionID], next).catch(() => {})
      return next
    },
  )

  export async function computeDiff(input: { messages: MessageV2.WithParts[] }) {
    let from: string | undefined
    let to: string | undefined

    // scan assistant messages to find earliest from and latest to
    // snapshot
    for (const item of input.messages) {
      if (!from) {
        for (const part of item.parts) {
          if (part.type === "step-start" && part.snapshot) {
            from = part.snapshot
            break
          }
        }
      }

      for (const part of item.parts) {
        if (part.type === "step-finish" && part.snapshot) {
          to = part.snapshot
        }
      }
    }

    if (from && to) return Snapshot.diffFull(from, to)
    return []
  }
}
