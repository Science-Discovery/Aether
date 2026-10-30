import { Instance } from "@/project/instance"
import { Session } from "@/session"
import type { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Filesystem } from "@/util/filesystem"
import z from "zod"
import { NativeAnswers } from "./answers"
import { NativeElicitation } from "./elicitation"
import { NativeInteraction } from "./interaction"
import { NativeLock } from "./lock"
import { NativeQueue } from "./queue"
import { NativeRuntime } from "./runtime"
import { NativeStore } from "./store"
import { NativeTasks } from "./tasks"
import { Protocol } from "./protocol"

/** Native writer ownership belongs to Codex, not to Aether's local history lock. */
export namespace NativeOwnership {
  export function resume(
    client: Pick<Protocol.Client, "request">,
    thread: string,
    params: Record<string, unknown> = {},
    opts?: { signal?: AbortSignal; timeout?: number },
  ) {
    return client
      .request("thread/resume", { ...params, threadId: thread, excludeTurns: true }, opts)
      .catch((err: unknown) => {
        if (err instanceof Protocol.RpcError && err.message === `thread ${thread} already has an active writer`)
          throw new Error(
            "This Codex chat is held by another client. Finish its task and release or close the chat there before retrying. No new task was sent.",
            { cause: err },
          )
        throw err
      })
  }

  /** Release only our idle process; never stop or take over another client's task. */
  export async function release(id: SessionID) {
    const session = await Session.get(id)
    if (session.engine?.type !== "codex" || Filesystem.resolve(session.directory) !== Instance.directory)
      throw new Error("This Codex conversation is not available in this project.")
    if (NativeLock.busy(id)) throw new Error("Wait for this Codex operation to finish before releasing the chat.")
    return NativeLock.run(id, async () => {
      const { NativeRevert } = await import("./revert")
      await NativeRevert.guard(id)
      const current = await Session.get(id)
      if (current.engine?.thread !== session.engine?.thread || current.directory !== session.directory)
        throw new Error("This Codex conversation changed. Refresh it before releasing the chat.")
      if (NativeInteraction.active(id) || (await SessionStatus.get(id)).type !== "idle")
        throw new Error("Finish the current Codex task before releasing the chat.")
      using answers = NativeAnswers.block(id)
      if (NativeQueue.active(id) || (await NativeQueue.list(id)).items.length)
        throw new Error("Clear queued messages before releasing this Codex chat.")
      if ((await NativeAnswers.pending(id)).length || (await NativeElicitation.list(id)).length)
        throw new Error("Answer or skip pending questions before releasing this Codex chat.")
      if (
        (await NativeTasks.list(id)).some(
          (task) =>
            !["completed", "failed"].includes(task.state) ||
            task.questions.some((question) => question.state !== "answered"),
        )
      )
        throw new Error("Finish or verify child tasks and their questions before releasing this Codex chat.")
      if (NativeStore.dispatches(id).some((entry) => entry.state !== "accepted" && entry.state !== "rejected"))
        throw new Error("Verify the previously submitted Codex message before releasing the chat.")
      return { released: await handoff(current) }
    })
  }

  /** Call only while holding the session's local operation lock. */
  export function handoff(session: Session.Info) {
    return NativeRuntime.handoff(session.id, async (entry) => {
      if (entry.directory !== session.directory) throw new Error("This Codex process belongs to another project.")
      if (!entry.thread) return
      if (entry.thread !== session.engine?.thread || !entry.home || entry.home !== NativeStore.state(session.id)?.home)
        throw new Error("The original Codex connection could not be verified. Refresh this conversation.")
      if (entry.client.busy) throw new Error("Wait for the current Codex request before releasing the chat.")
      const signal = AbortSignal.timeout(15_000)
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = z
          .object({ data: z.string().array().max(100), nextCursor: z.string().nullable() })
          .parse(
            await entry.client.request(
              "thread/loaded/list",
              { limit: 100, ...(cursor ? { cursor } : {}) },
              { timeout: 10_000, signal },
            ),
          )
        for (const thread of page.data) {
          const goal = z
            .object({ goal: z.object({ status: z.string() }).nullable() })
            .parse(
              await entry.client.request("thread/goal/get", { threadId: thread }, { timeout: 10_000, signal }),
            ).goal
          if (goal && goal.status !== "complete")
            throw new Error("This Codex chat has a goal. Finish or clear it before releasing the chat.")
          const item = z
            .object({ thread: z.object({ id: z.string(), status: z.object({ type: z.string() }) }) })
            .parse(
              await entry.client.request(
                "thread/read",
                { threadId: thread, includeTurns: false },
                { timeout: 10_000, signal },
              ),
            ).thread
          if (item.id !== thread || !["idle", "notLoaded"].includes(item.status.type))
            throw new Error("A Codex task is still running or waiting; finish it before releasing this chat.")
        }
        cursor = page.nextCursor ?? undefined
        if (cursor && (seen.has(cursor) || seen.size >= 16))
          throw new Error("Codex's loaded tasks could not be checked completely. Try again shortly.")
        if (cursor) seen.add(cursor)
      } while (cursor)
    })
  }
}
