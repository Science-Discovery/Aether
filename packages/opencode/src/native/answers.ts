import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { NativeQuestion } from "./questions"
import { NativeStore } from "./store"

/** Durable answer receipts, independent of the replaceable native history view. */
export namespace NativeAnswers {
  export const Input = z.object({
    sessionID: SessionID.zod,
    itemID: z.string().min(1).max(500),
    threadID: z.string().min(1).max(200),
    answers: z.array(z.string().trim().min(1).max(100_000)).min(1).max(32),
  })
  export const Skip = Input.omit({ answers: true })
  export const Pending = z
    .array(
      z.object({
        messageID: MessageID.zod,
        parentID: MessageID.zod,
        partID: PartID.zod,
        question: NativeQuestion.Info,
      }),
    )
    .meta({ ref: "NativePendingQuestions" })
  const Record = z.object({
    question: NativeQuestion.Info,
    message: MessageID.zod.optional(),
  })
  type Record = z.infer<typeof Record>
  const Saved = z.array(Record)
  const log = Log.create({ service: "native.answers" })
  const state = Instance.state(
    () => ({
      closed: false,
      jobs: new Map<string, Promise<void>>(),
      epochs: new Map<SessionID, number>(),
      removed: new Set<SessionID>(),
    }),
    async (value) => {
      value.closed = true
    },
  )
  const identity = (id: SessionID, thread: string, item: string) => `${id}\n${thread}\n${item}`

  export function active(id: SessionID) {
    return [...state().jobs.keys()].some((key) => key.startsWith(`${id}\n`))
  }

  /** Rebuild answer evidence from retained native user messages after a verified revert. */
  export async function reset(id: SessionID) {
    using lock = await Lock.write(file(id))
    if (active(id)) throw new Error("Wait for the submitted answer before editing this conversation.")
    cancel(id)
    await write(id, [])
  }

  function file(id: SessionID) {
    return path.join(Global.Path.data, "native-answers", Instance.project.id, `${SessionID.zod.parse(id)}.json`)
  }

  async function read(id: SessionID) {
    const text = await fs.readFile(file(id), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined
      throw err
    })
    return text === undefined ? [] : Saved.parse(JSON.parse(text))
  }

  async function write(id: SessionID, records: Record[]) {
    const target = file(id)
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await fs.writeFile(temp, JSON.stringify(records), { flag: "wx", mode: 0o600 })
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  function status(id: SessionID, record: Record): NativeQuestion.Info {
    if (!record.message || record.question.state === "answered") return record.question
    const receipt = NativeStore.dispatches(id).find((entry) => entry.id === record.message)
    if (receipt?.state === "accepted") return { ...record.question, state: "answered", error: undefined }
    if (
      record.question.state !== "sending" ||
      state().jobs.has(identity(id, record.question.thread, record.question.item))
    )
      return record.question
    return {
      ...record.question,
      state: "uncertain",
      error:
        "The service stopped before answer delivery was confirmed. This answer will not be sent again automatically.",
    }
  }

  export async function decorate(
    id: SessionID,
    question: NativeQuestion.Info,
    opts: { persist?: boolean; ready?: () => boolean } = {},
  ): Promise<NativeQuestion.Info> {
    using lock = await Lock.write(file(id))
    if (state().removed.has(id) || opts.ready?.() === false) return question
    const records = await read(id)
    if (opts.ready?.() === false) return question
    const record = records.find(
      (entry) => entry.question.thread === question.thread && entry.question.item === question.item,
    )
    // An exact native user reply is evidence even when another client sent it.
    // Keep that evidence across later partial snapshots or service restarts.
    if (question.state === "answered" && record?.question.state !== "answered") {
      if (record) record.question = question
      if (!record) records.push({ question })
      if (opts.persist !== false) await write(id, records)
      return question
    }
    if (!record) return question
    const result = status(id, record)
    if (JSON.stringify(record.question) !== JSON.stringify(result)) {
      record.question = result
      if (opts.persist !== false) await write(id, records)
    }
    return { ...question, state: result.state, answers: result.answers, skipped: result.skipped, error: result.error }
  }

  export async function pending(id: SessionID): Promise<z.infer<typeof Pending>> {
    const session = await Session.getGlobal(id)
    if (Filesystem.resolve(session.directory) !== Instance.directory)
      return Instance.provide({ directory: session.directory, fn: () => pending(id) })
    if (session.engine?.type !== "codex" || state().removed.has(id)) return []
    const epoch = state().epochs.get(id) ?? 0
    const items = new Map<string, z.infer<typeof Pending>[number]>()
    for (const message of await NativeStore.history(id)) {
      if (message.info.role !== "assistant" || message.info.providerID !== "codex-native") continue
      for (const part of message.parts) {
        if (part.type !== "text" || !part.nativeQuestion || part.nativeQuestion.thread !== session.engine.thread)
          continue
        const question = await decorate(id, part.nativeQuestion, { persist: false })
        if (question.state !== "pending" || question.answers) {
          items.delete(question.item)
          continue
        }
        items.set(question.item, {
          messageID: message.info.id,
          parentID: message.info.parentID,
          partID: part.id,
          question,
        })
      }
    }
    return state().removed.has(id) || (state().epochs.get(id) ?? 0) !== epoch ? [] : [...items.values()]
  }

  async function publish(id: SessionID, question: NativeQuestion.Info, ready?: () => boolean) {
    const current = await decorate(id, question, { ready })
    if (ready?.() === false) return
    for (const message of await NativeStore.history(id)) {
      if (message.info.role !== "assistant" || message.info.providerID !== "codex-native") continue
      for (const part of message.parts) {
        if (
          part.type !== "text" ||
          part.nativeQuestion?.thread !== question.thread ||
          part.nativeQuestion.item !== question.item
        )
          continue
        if (ready?.() === false) return
        await Session.updatePart({ ...part, nativeQuestion: current })
      }
    }
  }

  async function finish(id: SessionID, thread: string, item: string, error?: string) {
    const question = await (async () => {
      using lock = await Lock.write(file(id))
      const records = await read(id)
      const record = records.find((entry) => entry.question.thread === thread && entry.question.item === item)
      if (!record || record.question.state === "answered") return record?.question
      const receipt = NativeStore.dispatches(id).find((entry) => entry.id === record.message)
      const stored = NativeStore.inputs(id).some((entry) => entry.id === record.message)
      record.question = {
        ...record.question,
        state: receipt?.state === "accepted" ? "answered" : stored || receipt ? "uncertain" : "failed",
        error: receipt?.state === "accepted" ? undefined : (error ?? "Answer delivery could not be confirmed."),
      }
      await write(id, records)
      return record.question
    })()
    if (question) await publish(id, question)
  }

  export async function reply(value: z.infer<typeof Input>): Promise<NativeQuestion.Info> {
    return submit(Input.parse(value))
  }

  export async function skip(value: z.infer<typeof Skip>): Promise<NativeQuestion.Info> {
    return submit({ ...Skip.parse(value), skipped: true })
  }

  async function submit(
    input: z.infer<typeof Input> | (z.infer<typeof Skip> & { skipped: true }),
  ): Promise<NativeQuestion.Info> {
    const session = await Session.getGlobal(input.sessionID)
    if (Filesystem.resolve(session.directory) !== Instance.directory)
      return Instance.provide({ directory: session.directory, fn: () => submit(input) })
    if (session.engine?.type !== "codex" || session.engine.thread !== input.threadID)
      throw new Error("This question does not belong to the current Codex thread.")
    const current = state()
    const epoch = current.epochs.get(input.sessionID) ?? 0
    const ready = () =>
      !current.closed && !current.removed.has(input.sessionID) && (current.epochs.get(input.sessionID) ?? 0) === epoch
    const key = identity(input.sessionID, input.threadID, input.itemID)
    const saved = await (async () => {
      using lock = await Lock.write(file(input.sessionID))
      const { NativeRevert } = await import("./revert")
      await NativeRevert.guard(input.sessionID)
      if (!ready()) throw new Error("This answer was cancelled before submission.")
      const history = await NativeStore.history(input.sessionID)
      const question = history
        .filter((entry) => entry.info.role === "assistant" && entry.info.providerID === "codex-native")
        .flatMap((entry) => entry.parts)
        .find(
          (part) =>
            part.type === "text" &&
            part.nativeQuestion?.thread === input.threadID &&
            part.nativeQuestion.item === input.itemID,
        )
      if (question?.type !== "text" || !question.nativeQuestion)
        throw new Error("This question is no longer available. Refresh the conversation.")
      const answers =
        "skipped" in input ? question.nativeQuestion.questions.map(() => NativeQuestion.skipped) : input.answers
      if (question.nativeQuestion.questions.length !== answers.length)
        throw new Error("Answer every question before submitting.")
      const text = NativeQuestion.reply(question.nativeQuestion, answers)
      if (Buffer.byteLength(text) > 1_000_000) throw new Error("These answers are too long to submit.")
      const records = await read(input.sessionID)
      const prior = records.find(
        (entry) => entry.question.thread === input.threadID && entry.question.item === input.itemID,
      )
      if (prior) {
        if (JSON.stringify(prior.question.questions) !== JSON.stringify(question.nativeQuestion.questions))
          throw new Error("This question group changed after submission. Refresh the conversation before continuing.")
        if (JSON.stringify(prior.question.answers) !== JSON.stringify(answers))
          throw new Error("This question already has a submitted answer. Check its saved result before continuing.")
        const result = status(input.sessionID, prior)
        if (result.state !== "failed" || current.jobs.has(key)) return { question: result }
        if (prior.message && NativeStore.inputs(input.sessionID).some((entry) => entry.id === prior.message))
          return { question: { ...result, state: "uncertain" as const } }
      }
      if (question.nativeQuestion.state === "answered") return { question: question.nativeQuestion }
      if (current.closed || (await Config.getGlobal()).native?.codex?.enabled === false)
        throw new Error("Codex is not available. Enable it before submitting an answer.")
      const { NativeSession } = await import("./session")
      const active = NativeSession.active(input.sessionID)
      if (active && (!active.steer || !active.turnID))
        throw new Error("Codex is starting or stopping. Please submit the answer when it is ready.")
      if (!active && (await SessionStatus.get(input.sessionID)).type !== "idle")
        throw new Error("The current task is still finishing. Please submit the answer again shortly.")
      const record: Record = {
        question: {
          ...question.nativeQuestion,
          state: "sending",
          answers,
          skipped: answers.every((answer) => answer === NativeQuestion.skipped) ? true : undefined,
          error: undefined,
        },
        message: prior?.message ?? MessageID.ascending(),
      }
      if (prior) Object.assign(prior, record)
      if (!prior) records.push(record)
      if (!ready()) throw new Error("This answer was cancelled before submission.")
      await write(input.sessionID, records)
      // Reserve the durable identity before any native RPC. A lost HTTP response
      // can only inspect the same receipt, never start a second answer turn.
      const gate = Promise.withResolvers<void>()
      const work = gate.promise
        .then(async () => {
          if (!ready()) throw new Error("This answer was cancelled before submission.")
          if (active?.turnID) {
            const result = await NativeSession.steer({
              sessionID: input.sessionID,
              messageID: record.message!,
              turnID: active.turnID,
              text,
            })
            return finish(input.sessionID, input.threadID, input.itemID, result.error)
          }
          const { SessionPrompt } = await import("@/session/prompt")
          await SessionPrompt.queued(
            {
              sessionID: input.sessionID,
              messageID: record.message,
              parts: [{ type: "text", text }],
            },
            ready,
          )
          await finish(input.sessionID, input.threadID, input.itemID)
        })
        .catch((err: unknown) =>
          finish(input.sessionID, input.threadID, input.itemID, err instanceof Error ? err.message : String(err)),
        )
        .catch((err: unknown) =>
          log.error("answer receipt update failed", { session: input.sessionID, item: input.itemID, error: err }),
        )
        .finally(() => current.jobs.delete(key))
      current.jobs.set(key, work)
      return { question: record.question, start: () => gate.resolve() }
    })()
    // Do not keep the file mutex while dispatch or message events run.
    await publish(input.sessionID, saved.question, ready).finally(() => saved.start?.())
    return saved.question
  }

  export function cancel(id: SessionID) {
    state().epochs.set(id, (state().epochs.get(id) ?? 0) + 1)
  }

  export function close(id: SessionID) {
    state().removed.add(id)
    cancel(id)
  }

  export async function clear(id: SessionID) {
    close(id)
    const jobs = await (async () => {
      using lock = await Lock.write(file(id))
      return [...state().jobs].filter(([key]) => key.startsWith(`${id}\n`)).map(([, job]) => job)
    })()
    await Promise.allSettled(jobs)
    using lock = await Lock.write(file(id))
    await fs.rm(file(id), { force: true })
  }
}
