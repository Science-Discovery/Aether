import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"
import { SyncEvent } from "../sync"
import { Storage } from "@/storage/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  const pending: Record<string, Promise<void>> = {}

  export function awaitPending(sessionID: SessionID) {
    return pending[sessionID] ?? Promise.resolve()
  }

  export const RevertInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  export async function revert(input: RevertInput) {
    SessionPrompt.assertNotBusy(input.sessionID)
    const done = Promise.withResolvers<void>()
    pending[input.sessionID] = done.promise
    try {
      const result = await revertInner(input)
      return result
    } finally {
      delete pending[input.sessionID]
      done.resolve()
    }
  }

  async function revertInner(input: RevertInput) {
    const all = await Session.messages({ sessionID: input.sessionID })
    let lastUser: MessageV2.User | undefined
    const session = await Session.get(input.sessionID)

    let revert: Session.Info["revert"]
    const patches: Snapshot.Patch[] = []
    for (const msg of all) {
      if (msg.info.role === "user") lastUser = msg.info
      const remaining = []
      for (const part of msg.parts) {
        if (revert) {
          if (part.type === "patch") {
            patches.push(part)
          }
          continue
        }

        if (!revert) {
          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // if no useful parts left in message, same as reverting whole message
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    if (revert) {
      const session = await Session.get(input.sessionID)
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track())
      await Snapshot.revert(patches)
      if (revert.snapshot) revert.diff = await Snapshot.diff(revert.snapshot)
      // Compute diffs matching what SessionSummary.diff() returns on refresh:
      // use session_diff_from → current working tree when available,
      // otherwise fall back to computing from remaining (non-reverted) messages.
      const from = await Storage.read<string>(["session_diff_from", input.sessionID]).catch(() => undefined)
      let diffs: Snapshot.FileDiff[]
      if (from) {
        const to = await Snapshot.track()
        diffs = to ? await Snapshot.diffFull(from, to) : []
      } else {
        const remaining = all.filter((msg) => msg.info.id < revert!.messageID)
        diffs = await SessionSummary.computeDiff({ messages: remaining })
      }
      await Storage.write(["session_diff", input.sessionID], diffs)
      // Refresh SessionSummary's dedup cache so the next summarize() with the
      // post-revert payload doesn't get falsely matched against the pre-revert
      // fingerprint and silently dropped on the way to the web UI.
      SessionSummary.invalidate(input.sessionID, diffs)
      Bus.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: diffs,
      })
      return Session.setRevert({
        sessionID: input.sessionID,
        revert,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
    }
    return session
  }

  export async function unrevert(input: { sessionID: SessionID }) {
    log.info("unreverting", input)
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    if (session.revert.snapshot) await Snapshot.restore(session.revert.snapshot)
    const all = await Session.messages({ sessionID: input.sessionID })
    const from = await Storage.read<string>(["session_diff_from", input.sessionID]).catch(() => undefined)
    let diffs: Snapshot.FileDiff[]
    if (from) {
      const to = await Snapshot.track()
      diffs = to ? await Snapshot.diffFull(from, to) : []
    } else {
      diffs = await SessionSummary.computeDiff({ messages: all })
    }
    await Storage.write(["session_diff", input.sessionID], diffs)
    SessionSummary.invalidate(input.sessionID, diffs)
    Bus.publish(Session.Event.Diff, {
      sessionID: input.sessionID,
      diff: diffs,
    })
    return Session.clearRevert(input.sessionID)
  }

  export async function cleanup(session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id
    const msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID
    const preserve = [] as MessageV2.WithParts[]
    const remove = [] as MessageV2.WithParts[]
    let target: MessageV2.WithParts | undefined
    for (const msg of msgs) {
      if (msg.info.id < messageID) {
        preserve.push(msg)
        continue
      }
      if (msg.info.id > messageID) {
        remove.push(msg)
        continue
      }
      if (session.revert.partID) {
        preserve.push(msg)
        target = msg
        continue
      }
      remove.push(msg)
    }
    for (const msg of remove) {
      SyncEvent.run(MessageV2.Event.Removed, {
        sessionID: sessionID,
        messageID: msg.info.id,
      })
    }
    const completedCompactionTriggers = new Set<string>()
    for (const msg of preserve) {
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
        completedCompactionTriggers.add(msg.info.parentID)
    }
    const orphanedCompactionTriggers: MessageV2.WithParts[] = []
    for (const msg of preserve) {
      if (
        msg.info.role === "user" &&
        msg.parts.some((part) => part.type === "compaction") &&
        !completedCompactionTriggers.has(msg.info.id)
      )
        orphanedCompactionTriggers.push(msg)
    }
    for (const msg of orphanedCompactionTriggers) {
      preserve.splice(preserve.indexOf(msg), 1)
      SyncEvent.run(MessageV2.Event.Removed, {
        sessionID: sessionID,
        messageID: msg.info.id,
      })
      if (msg === target) target = undefined
    }
    for (const msg of preserve) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state.status === "completed" && part.state.time.compacted) {
          const time = { ...part.state.time }
          delete time.compacted
          await Session.updatePart({ ...part, state: { ...part.state, time } })
        }
      }
    }
    if (session.revert.partID && target) {
      const partID = session.revert.partID
      const removeStart = target.parts.findIndex((part) => part.id === partID)
      if (removeStart >= 0) {
        const preserveParts = target.parts.slice(0, removeStart)
        const removeParts = target.parts.slice(removeStart)
        target.parts = preserveParts
        for (const part of removeParts) {
          SyncEvent.run(MessageV2.Event.PartRemoved, {
            sessionID: sessionID,
            messageID: target.info.id,
            partID: part.id,
          })
        }
      }
    }
    await Session.clearRevert(sessionID)
  }
}
