import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Lock } from "@/util/lock"
import { NativeAnswers } from "./answers"
import { NativeQuestion } from "./questions"
import { NativeStore } from "./store"
import { NativeLock } from "./lock"
import { Protocol } from "./protocol"

/** Child observations are independent of the replaceable root-thread transcript. */
export namespace NativeTasks {
  const Item = z.object({
    thread: z.string(),
    root: z.string(),
    origin: z.string(),
    parent: z.string(),
    turn: z.string(),
    name: z.string(),
    state: z.enum(["running", "completed", "failed", "unknown"]),
    output: z.string(),
    updated: z.number(),
    session: SessionID.zod.optional(),
    questions: z.array(NativeQuestion.Info),
  })
  export const List = z.array(Item).meta({ ref: "NativeTasks" })
  export const Input = z.object({
    sessionID: SessionID.zod,
    threadID: z.string().min(1).max(200),
    itemID: z.string().min(1).max(500),
    answers: z.array(z.string().trim().min(1).max(100_000)).min(1).max(32).optional(),
  })
  const Receipt = z.object({
    thread: z.string(),
    item: z.string(),
    id: z.string(),
    question: NativeQuestion.Info,
  })
  const Saved = z.object({ tasks: List, receipts: z.array(Receipt) })
  const Agent = z.object({
    threadId: z.string(),
    turnId: z.string(),
    parentThreadId: z.string(),
    name: z.string(),
    itemId: z.string(),
  })
  const runs = Instance.state(
    () => new Map<SessionID, (input: { thread: string; text: string; id: string }) => Promise<void>>(),
  )
  const closed = Instance.state(() => new Set<SessionID>())
  const jobs = Instance.state(() => new Set<string>())
  const object = z.record(z.string(), z.unknown())
  const file = (id: SessionID) =>
    path.join(Global.Path.data, "native-tasks", Instance.project.id, `${SessionID.zod.parse(id)}.json`)

  export function active(id: SessionID) {
    return [...jobs()].some((key) => key.startsWith(`${id}\n`))
  }

  export async function guard(id: SessionID, except?: string) {
    if (active(id)) throw new Error("Wait for the child-task answer to be delivered before changing this conversation.")
    const saved = await read(id)
    if (!saved.tasks.length) return
    for (const task of await valid(id, saved)) {
      if (!task.session || task.thread === except) continue
      if (NativeLock.busy(task.session) || (await SessionStatus.get(task.session)).type !== "idle")
        throw new Error("A linked child task is still running. Finish it before continuing the parent conversation.")
    }
  }

  async function read(id: SessionID) {
    const value = await fs.readFile(file(id), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined
      throw err
    })
    return value === undefined ? { tasks: [], receipts: [] } : Saved.parse(JSON.parse(value))
  }

  async function write(id: SessionID, value: z.infer<typeof Saved>) {
    if (closed().has(id)) throw new Error("This conversation is being removed.")
    const target = file(id)
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await fs.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  export function open(id: SessionID, reply: (input: { thread: string; text: string; id: string }) => Promise<void>) {
    if (runs().has(id)) throw new Error("The child-task connection is already registered.")
    runs().set(id, reply)
    return {
      [Symbol.dispose]: () => {
        if (runs().get(id) === reply) runs().delete(id)
      },
    }
  }

  export async function observe(id: SessionID, method: string, value: unknown) {
    if (!["item/started", "item/completed"].includes(method) || closed().has(id)) return
    const data = object.safeParse(value)
    if (!data.success) return
    const agent = Agent.safeParse(data.data.nativeAgent)
    const item = object.safeParse(data.data.item)
    if (
      !agent.success ||
      !item.success ||
      typeof data.data.threadId !== "string" ||
      typeof data.data.turnId !== "string"
    )
      return
    if (item.data.type !== "nativeAgent" && !(method === "item/completed" && item.data.type === "agentMessage")) return
    using lock = await Lock.write(file(id))
    const saved = await read(id)
    let task = saved.tasks.find((entry) => entry.thread === agent.data.threadId && entry.origin === data.data.turnId)
    if (!task) {
      if (saved.tasks.length >= 512) throw new Error("This conversation has reached the child-task observation limit.")
      task = {
        thread: agent.data.threadId,
        root: data.data.threadId,
        origin: data.data.turnId,
        parent: agent.data.parentThreadId,
        turn: agent.data.turnId,
        name: agent.data.name,
        state: "running",
        output: "",
        updated: Date.now(),
        questions: [],
      }
      saved.tasks.push(task)
    }
    task.turn = agent.data.turnId
    task.updated = Date.now()
    if (item.data.type === "nativeAgent")
      task.state = method === "item/started" ? "running" : item.data.status === "completed" ? "completed" : "failed"
    if (item.data.type === "agentMessage") {
      if (typeof item.data.text === "string" && item.data.text) task.output = item.data.text.slice(-32_000)
      const question = NativeQuestion.parse(
        { ...item.data, id: agent.data.itemId },
        { thread: task.thread, turn: task.turn },
      )
      if (question && !task.questions.some((entry) => entry.item === question.item)) {
        if (task.questions.length >= 64) throw new Error("This child task has too many question groups.")
        task.questions.push(question)
      }
    }
    await write(id, saved)
  }

  async function valid(id: SessionID, saved: z.infer<typeof Saved>) {
    const session = await Session.get(id)
    if (session.engine?.type !== "codex" || session.directory !== Instance.directory)
      throw new Error("Open this Codex conversation in its own project.")
    const turns = new Set(
      NativeStore.dispatches(id).flatMap((row) => (row.state === "accepted" && row.turn_id ? [row.turn_id] : [])),
    )
    const candidates = saved.tasks.filter((entry) => entry.root === session.engine?.thread)
    if (candidates.every((entry) => turns.has(entry.origin))) return candidates
    for (const entry of await NativeStore.history(id)) {
      for (const part of entry.parts) {
        const metadata = "metadata" in part ? part.metadata : undefined
        const native = object.safeParse(metadata?.native)
        if (native.success && typeof native.data.turn === "string") turns.add(native.data.turn)
      }
    }
    return candidates.filter((entry) => turns.has(entry.origin))
  }

  export async function list(id: SessionID): Promise<z.infer<typeof List>> {
    using lock = await Lock.write(file(id))
    const saved = await read(id)
    if (!saved.tasks.length) return []
    const grouped = new Map<string, z.infer<typeof Item>>()
    for (const task of (await valid(id, saved)).toSorted((a, b) => a.updated - b.updated)) {
      const previous = grouped.get(task.thread)
      grouped.set(task.thread, {
        ...task,
        session: task.session ?? previous?.session,
        questions: [
          ...new Map(
            [...(previous?.questions ?? []), ...task.questions].map((question) => [question.item, question]),
          ).values(),
        ],
      })
    }
    for (const task of grouped.values()) {
      for (let index = 0; index < task.questions.length; index++) {
        const question = task.questions[index]
        const receipt = saved.receipts.find((entry) => entry.thread === task.thread && entry.item === question.item)
        if (receipt) task.questions[index] = receipt.question
        if (task.session)
          task.questions[index] = await NativeAnswers.decorate(task.session, task.questions[index], { persist: false })
        if (
          task.questions[index].state === "sending" &&
          !jobs().has(`${id}\n${task.thread}\n${question.item}`) &&
          !task.session
        )
          task.questions[index] = {
            ...task.questions[index],
            state: "uncertain",
            error: "Answer delivery could not be confirmed; it will not be sent again automatically.",
          }
      }
      if (!runs().has(id) && task.state === "running") task.state = "unknown"
      if (task.session && !runs().has(id)) {
        const child = await Session.get(task.session).catch(() => undefined)
        if (child?.engine?.thread === task.thread && child.directory === Instance.directory) {
          const busy = (await SessionStatus.get(child.id)).type !== "idle"
          if (busy) task.state = "running"
          const rows = await Session.messages({ sessionID: child.id, limit: 10 })
          const turns = rows.map((entry) =>
            entry.parts.flatMap((part) => {
              const metadata = "metadata" in part ? part.metadata : undefined
              if (metadata?.nativeAgent) return []
              const native = object.safeParse(metadata?.native)
              if (
                !native.success ||
                typeof native.data.turn !== "string" ||
                (native.data.thread !== undefined && native.data.thread !== task.thread)
              )
                return []
              return [native.data.turn]
            }),
          )
          // Linked history can lag behind a reused child. Only a matching
          // native turn proves that the following records are current or newer.
          const start = turns.findIndex((turns) => turns.includes(task.turn))
          if (start < 0) continue
          const latest = rows.findLast(
            (entry, index) => index >= start && turns[index].length && entry.info.role === "assistant",
          )
          const text = latest?.parts
            .flatMap((part) =>
              part.type === "text" && !part.nativeQuestion && !part.ignored && !part.synthetic ? [part.text] : [],
            )
            .join("\n\n")
          if (text) task.output = text.slice(-32_000)
          task.state = busy
            ? "running"
            : latest?.info.role === "assistant" && latest.info.error
              ? "failed"
              : latest?.info.role === "assistant" && latest.info.time.completed
                ? "completed"
                : task.state
        }
      }
    }
    return [...grouped.values()]
  }

  export async function attach(id: SessionID, thread: string) {
    if (NativeLock.busy(id) || active(id))
      throw new Error("Wait for the parent task to finish before opening a child task.")
    return NativeLock.run(id, async () => {
      const { NativeRevert } = await import("./revert")
      await NativeRevert.guard(id)
      if (runs().has(id) || (await SessionStatus.get(id)).type !== "idle")
        throw new Error("The parent task is still running.")
      using lock = await Lock.write(file(id))
      const saved = await read(id)
      const task = (await valid(id, saved)).find((entry) => entry.thread === thread)
      const home = NativeStore.state(id)?.home
      if (!task || !home) throw new Error("The child task is no longer available in this conversation.")
      const { NativeChats } = await import("./chats")
      const session = await NativeChats.child(thread, task.root, home)
      task.session = session.id
      await write(id, saved)
      return session
    })
  }

  export async function reply(value: z.infer<typeof Input>): Promise<NativeQuestion.Info> {
    const input = Input.parse(value)
    const id = input.sessionID
    const key = `${id}\n${input.threadID}\n${input.itemID}`
    const pending = await (async () => {
      using lock = await Lock.write(file(id))
      if ((await Config.getGlobal()).native?.codex?.enabled === false) throw new Error("Codex is disabled.")
      const saved = await read(id)
      const task = (await valid(id, saved)).find(
        (entry) =>
          entry.thread === input.threadID && entry.questions.some((question) => question.item === input.itemID),
      )
      const question = task?.questions.find((entry) => entry.item === input.itemID)
      if (!task || !question) throw new Error("This child question is no longer part of the conversation.")
      const answers = input.answers ?? question.questions.map(() => NativeQuestion.skipped)
      const text = NativeQuestion.reply(question, answers)
      if (Buffer.byteLength(text) > 1_000_000) throw new Error("These answers are too long to submit.")
      const prior = saved.receipts.find((entry) => entry.thread === input.threadID && entry.item === input.itemID)
      if (prior) {
        if (JSON.stringify(prior.question.questions) !== JSON.stringify(question.questions))
          throw new Error("The child question changed after submission. Open the child task to review it.")
        if (JSON.stringify(prior.question.answers) !== JSON.stringify(answers))
          throw new Error("This question already has a different submitted answer.")
        // A lost response can inspect the same receipt, never send it again.
        if (prior.question.state !== "failed" || jobs().has(key)) {
          const result = await (task.session
            ? NativeAnswers.decorate(task.session, prior.question, { persist: false })
            : Promise.resolve(prior.question))
          return {
            question:
              result.state === "sending" && !jobs().has(key) && !task.session
                ? { ...result, state: "uncertain" as const }
                : result,
          }
        }
      }
      if (jobs().has(key)) throw new Error("The answer is already being submitted.")
      const { NativeRevert } = await import("./revert")
      await NativeRevert.guard(id, { child: input.threadID })
      const handler = runs().get(id)
      if (!handler && (NativeLock.busy(id) || (await SessionStatus.get(id)).type !== "idle"))
        throw new Error("Wait for the parent task to finish before continuing this child task.")
      const receipt = {
        thread: task.thread,
        item: question.item,
        id: prior?.id ?? MessageID.ascending(),
        question: {
          ...question,
          state: "sending" as const,
          answers,
          skipped: input.answers ? undefined : (true as const),
          error: undefined,
        },
      }
      if (prior) Object.assign(prior, receipt)
      if (!prior) saved.receipts.push(receipt)
      await write(id, saved)
      jobs().add(key)
      return { task, receipt, handler, text }
    })()
    if ("question" in pending) {
      if (!pending.question) throw new Error("The saved answer is unavailable.")
      return pending.question
    }
    let dispatched = false
    const result = await (async () => {
      if (pending.handler) {
        if (runs().get(id) !== pending.handler)
          throw new Protocol.RpcError(-32602, "The child connection closed before submission.")
        dispatched = true
        await pending.handler({ thread: input.threadID, text: pending.text, id: pending.receipt.id })
        return { ...pending.receipt.question, state: "answered" as const }
      }
      const { NativeChats } = await import("./chats")
      const session = await Session.get(id)
      const home = NativeStore.state(id)?.home
      if (!session.engine?.thread || !home) throw new Error("The native thread location is unavailable.")
      return NativeLock.run(id, async () => {
        if (runs().has(id) || (await SessionStatus.get(id)).type !== "idle")
          throw new Error("The parent task is running again.")
        const child = await NativeChats.child(input.threadID, session.engine!.thread!, home)
        using lock = await Lock.write(file(id))
        const saved = await read(id)
        const task = (await valid(id, saved)).find(
          (entry) => entry.thread === input.threadID && entry.origin === pending.task.origin,
        )
        if (!task || closed().has(id)) throw new Error("This child task was removed before submission.")
        task.session = child.id
        await write(id, saved)
        dispatched = true
        return input.answers
          ? NativeAnswers.reply({ ...input, sessionID: child.id, answers: input.answers })
          : NativeAnswers.skip({ ...input, sessionID: child.id })
      })
    })().catch(
      (err: unknown): NativeQuestion.Info => ({
        ...pending.receipt.question,
        state: !dispatched || err instanceof Protocol.RpcError ? "failed" : "uncertain",
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    try {
      using lock = await Lock.write(file(id))
      const saved = await read(id)
      const receipt = saved.receipts.find((entry) => entry.thread === input.threadID && entry.item === input.itemID)
      if (receipt) receipt.question = result
      await write(id, saved)
      return result
    } finally {
      jobs().delete(key)
    }
  }

  export async function clear(id: SessionID) {
    closed().add(id)
    runs().delete(id)
    using lock = await Lock.write(file(id))
    await fs.rm(file(id), { force: true })
  }
}
