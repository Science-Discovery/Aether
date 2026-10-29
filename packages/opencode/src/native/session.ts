import z from "zod"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { ModelID, ProviderID } from "@/provider/schema"
import { Question } from "@/question"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { NotFoundError } from "@/storage/db"
import { Codex } from "./codex"
import { NativeEvents } from "./events"
import { NativeInput } from "./input"
import { NativeSkills } from "./skills"
import { Protocol } from "./protocol"
import { NativeTree } from "./tree"
import { NativeRuntime } from "./runtime"
import { NativeStore } from "./store"
import { NativeLock } from "./lock"
import { NativePermissions } from "./permissions"
import { NativeModes } from "./modes"
import { NativeInteraction } from "./interaction"

export namespace NativeSession {
  export const active = NativeInteraction.active
  export const steer = NativeInteraction.steer
  const object = z.record(z.string(), z.unknown())
  const response = z.object({
    thread: z.object({ id: z.string().min(1), status: z.object({ type: z.string() }).optional() }).passthrough(),
    model: z.string().optional(),
  })
  const started = z.object({ turn: z.object({ id: z.string().min(1) }) })
  const questions = z.object({
    questions: z
      .array(
        z.object({
          id: z.string(),
          header: z.string(),
          question: z.string(),
          isOther: z.boolean().optional(),
          isSecret: z.boolean().optional(),
          options: z
            .array(z.object({ label: z.string(), description: z.string() }))
            .nullable()
            .optional(),
        }),
      )
      .min(1),
  })

  function message(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  async function request(
    method: string,
    value: unknown,
    info: MessageV2.Assistant,
    signal: AbortSignal,
    changes?: string,
    original?: { command: string; cwd: string; processId?: string | null },
  ) {
    const data = object.parse(value)
    const agent = object.safeParse(data.nativeAgent)
    const source = agent.success ? `Codex agent (${JSON.stringify(agent.data.name ?? agent.data.threadId)}):\n\n` : ""
    if (method === "item/tool/requestUserInput") {
      const items = questions.parse(data).questions
      if (items.some((item) => item.isSecret)) {
        throw new Protocol.RpcError(-32602, "Secret questions are not supported; enter credentials in Codex directly.")
      }
      const answers = await Question.runPromise(
        (service) =>
          service.ask({
            sessionID: info.sessionID,
            questions: items.map((item) => ({
              header: item.header,
              question: source + item.question,
              options: item.options ?? [],
              custom: item.isOther !== false || !item.options?.length,
            })),
            tool: typeof data.itemId === "string" ? { messageID: info.id, callID: data.itemId } : undefined,
          }),
        { signal },
      ).catch(() => [])
      return { answers: Object.fromEntries(items.map((item, index) => [item.id, { answers: answers[index] ?? [] }])) }
    }
    if (method === "item/permissions/requestApproval") {
      const permissions = object.parse(data.permissions)
      const details = JSON.stringify({ reason: data.reason, cwd: data.cwd, permissions }, null, 2)
      if (details.length > 30_000)
        throw new Protocol.RpcError(-32602, "The permission request is too large to review safely.")
      const answers = await Question.runPromise(
        (service) =>
          service.ask({
            sessionID: info.sessionID,
            questions: [
              {
                header: "Codex permissions",
                question: `${source}Codex requests additional access for this turn:\n\n${details}`,
                options: [
                  {
                    label: "Allow for this turn",
                    description: "Grant exactly the displayed access until this turn ends.",
                  },
                  { label: "Decline", description: "Do not grant additional access." },
                ],
                custom: false,
              },
            ],
            tool: typeof data.itemId === "string" ? { messageID: info.id, callID: data.itemId } : undefined,
          }),
        { signal },
      ).catch(() => [])
      return {
        permissions:
          answers[0]?.[0] === "Allow for this turn"
            ? {
                ...(permissions.network ? { network: permissions.network } : {}),
                ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
              }
            : {},
        scope: "turn",
      }
    }
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
      throw new Protocol.RpcError(-32601, `Aether does not support the Codex request ${method}.`)
    }
    if (method === "item/fileChange/requestApproval" && !changes) {
      throw new Protocol.RpcError(-32602, "Codex did not provide the proposed file changes for review.")
    }
    const execution = method === "item/commandExecution/requestApproval"
    const kind = data.kind ?? "command"
    if (execution && kind !== "command" && kind !== "writeStdin") {
      throw new Protocol.RpcError(-32602, "Aether does not support this Codex command approval kind.")
    }
    const network = z
      .object({ host: z.string().trim().min(1), protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]) })
      .safeParse(data.networkApprovalContext)
    if (execution && data.networkApprovalContext != null && !network.success) {
      throw new Protocol.RpcError(-32602, "Codex did not provide the network destination for review.")
    }
    const supplied = typeof data.command === "string" && data.command.trim() ? data.command : undefined
    const command = supplied ?? original?.command
    const cwd = typeof data.cwd === "string" && data.cwd.trim() ? data.cwd : original?.cwd
    if (execution && kind === "writeStdin" && (!supplied || !original)) {
      throw new Protocol.RpcError(
        -32602,
        "Codex did not provide both the terminal input and its existing command for review.",
      )
    }
    if (execution && !network.success && (!command || !cwd)) {
      throw new Protocol.RpcError(-32602, "Codex did not provide the command and working directory for review.")
    }
    const advertised = z.array(z.unknown()).safeParse(data.availableDecisions)
    const options = [
      { value: "accept", label: "Allow once", description: "Allow this Codex action once." },
      {
        value: "acceptForSession",
        label: "Allow for this run",
        description: "Remember this approval for the current run. Later messages may ask again.",
      },
      {
        value: "decline",
        label: "Decline",
        description: "Reject this action; Codex can continue with an alternative.",
      },
      { value: "cancel", label: "Cancel turn", description: "Stop the current Codex turn." },
    ].filter((item) => !advertised.success || advertised.data.includes(item.value))
    if (!options.length) return { decision: "cancel" }
    const details = [
      data.reason,
      execution && kind === "writeStdin"
        ? `Existing command:\n${original?.command}\n\nInput request:\n${supplied}`
        : command
          ? `Command:\n${command}`
          : undefined,
      cwd ? `Working directory:\n${cwd}` : undefined,
      execution && kind === "writeStdin" && original?.processId ? `Terminal ID: ${original.processId}` : undefined,
      data.environmentId != null ? `Execution environment: ${JSON.stringify(data.environmentId)}` : undefined,
      data.grantRoot,
      network.success ? `Network destination: ${network.data.host}\nProtocol: ${network.data.protocol}` : undefined,
      data.additionalPermissions,
      changes,
    ]
      .filter((item) => item !== undefined && item !== null)
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item, null, 2)))
      .join("\n\n")
    if (details.length > 30_000)
      throw new Protocol.RpcError(-32602, "The approval request is too large to review safely.")
    const answers = await Question.runPromise(
      (service) =>
        service.ask({
          sessionID: info.sessionID,
          questions: [
            {
              header: "Codex approval",
              question: `${source}${method === "item/fileChange/requestApproval" ? "Codex requests approval to change files." : kind === "writeStdin" ? "Codex requests approval to send input to an existing terminal." : network.success ? "Codex requests approval for network access." : "Codex requests approval to execute a command."}\n\n${details}`,
              options: options.map((item) => ({ label: item.label, description: item.description })),
              custom: false,
            },
          ],
          tool: typeof data.itemId === "string" ? { messageID: info.id, callID: data.itemId } : undefined,
        }),
      { signal },
    ).catch(() => [])
    return { decision: options.find((item) => item.label === answers[0]?.[0])?.value ?? "cancel" }
  }

  export async function prompt(
    input: SessionPrompt.PromptInput,
    session: Session.Info,
    signal: AbortSignal,
  ): Promise<MessageV2.WithParts> {
    const { NativeRevert } = await import("./revert")
    await NativeRevert.guard(session.id)
    return NativeLock.run(
      session.id,
      async () => {
        await NativeRevert.guard(session.id)
        return execute(input, await Session.get(session.id), signal)
      },
      signal,
    )
  }

  async function execute(
    input: SessionPrompt.PromptInput,
    session: Session.Info,
    signal: AbortSignal,
  ): Promise<MessageV2.WithParts> {
    if (session.engine?.type !== "codex") throw new Error("This session does not use the Codex native engine.")
    if (input.model && input.model.providerID !== "codex-native")
      throw new Error("Choose a native Codex model for this session.")
    if (Object.keys(input.tools ?? {}).length || input.knowledgeBase?.path || input.knowledgeBase?.paths?.length) {
      throw new Error("Aether tool overrides and knowledge-base retrieval are not supported in a Codex native session.")
    }
    signal.throwIfAborted()
    const cfg = await Config.getGlobal()
    if (cfg.native?.codex?.enabled === false)
      throw new Error("The native Codex backend is disabled in Aether settings.")
    await NativeStore.migrate(session)
    if (input.messageID) {
      const existing = await MessageV2.get({ sessionID: session.id, messageID: input.messageID }).catch(
        (err: unknown) => {
          if (NotFoundError.isInstance(err)) return undefined
          throw err
        },
      )
      if (existing || NativeStore.inputs(session.id, { retired: true }).some((entry) => entry.id === input.messageID))
        throw new Error("This message has already been submitted. Send a new message to continue.")
    }
    const user: MessageV2.User = {
      id: input.messageID ?? MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "codex",
      model: {
        providerID: ProviderID.make("codex-native"),
        modelID: ModelID.make(input.model?.modelID ?? session.engine.model ?? "default"),
      },
      variant: input.variant ?? session.engine.effort,
      system: input.system,
      format: input.format,
    }
    const parts = input.parts.map((part) => ({
      ...part,
      id: part.id ?? PartID.ascending(),
      messageID: user.id,
      sessionID: session.id,
    }))
    // Queued research context has no assistant response to retire invalid
    // input later, so validate it before making it part of the conversation.
    if (input.noReply) {
      if (parts.some((part) => part.type === "text" && part.metadata?.nativeSkill !== undefined))
        throw new Error("Send Codex skills with a message, not as deferred research context.")
      const pending = NativeStore.pending(session.id).flatMap((entry) => entry.data.parts)
      // Keep one MiB for the next normal message and its protocol fields so
      // saved context cannot fill an otherwise immutable native conversation.
      Protocol.check(
        "turn/start",
        { input: await NativeInput.build([...pending, ...parts], session.id, signal) },
        1024 * 1024,
      )
    }
    NativeStore.add({ info: user, parts }, input.noReply === true)
    await Session.updateMessage(user)
    for (const part of parts) await Session.updatePart(part)
    await Session.touch(session.id)
    if (Session.isDefaultTitle(session.title)) {
      const title = parts
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100)
      if (title) await Session.setTitle({ sessionID: session.id, title })
    }
    if (input.noReply) return { info: user, parts }
    const pending = NativeStore.pending(session.id)
    const assistant: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "assistant",
      parentID: user.id,
      agent: "codex",
      mode: "codex",
      modelID: user.model.modelID,
      providerID: user.model.providerID,
      path: { cwd: session.directory, root: Instance.worktree },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: user.variant,
    }
    await Session.updateMessage(assistant)
    const events = NativeEvents.create(assistant)
    const control = NativeInteraction.open({
      session,
      assistant,
      signal,
      ended: () => events.state.settled,
      steer: events.steer,
      mode: session.engine.mode ?? "default",
    })
    const controller = new AbortController()
    const state = {
      client: undefined as Protocol.Client | undefined,
      interrupt: undefined as Promise<void> | undefined,
      lease: undefined as Awaited<ReturnType<typeof NativeRuntime.acquire>> | undefined,
      keep: false,
      off: undefined as (() => void) | undefined,
    }
    const tree = NativeTree.create({
      request: (method, params) => {
        if (!state.client) return Promise.reject(new Error("The native connection is unavailable."))
        return state.client.request(method, params, { timeout: method === "turn/interrupt" ? 2_000 : 15_000 })
      },
      emit: events.notification,
      fail: (err) => events.settle({ status: "failed", error: err.message }),
      drain: async () => state.client?.drain(),
    })
    const abort = () => {
      state.interrupt ??= (async () => {
        await tree.interrupt()
        controller.abort()
        events.settle({ status: "interrupted" })
      })()
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      signal.throwIfAborted()
      const revision = NativeRuntime.revision()
      await NativeRuntime.configure((await Config.getGlobal()).native?.codex, revision)
      const connection = await NativeRuntime.acquire({
        id: session.id,
        directory: session.directory,
        signal: controller.signal,
        onNotification: (method, value) => {
          if (signal.aborted) return
          return tree.notification(method, value)
        },
        onRequest: async (method, value, cancelled) => {
          // Item notifications carry file diffs separately from their approval
          // request. Drain accepted notifications before inspecting that item.
          await state.client?.drain()
          signal.throwIfAborted()
          return control.wait(() =>
            tree.request(method, value, async (method, value) => {
              const data = object.parse(value)
              return request(
                method,
                value,
                events.owner(typeof data.itemId === "string" ? data.itemId : undefined),
                AbortSignal.any([signal, cancelled]),
                typeof data.itemId === "string" ? events.changes(data.itemId) : undefined,
                typeof data.itemId === "string" ? events.command(data.itemId) : undefined,
              )
            }),
          )
        },
      })
      state.lease = connection
      state.client = connection.client
      NativeStore.bind(session.id, connection.home, false)
      signal.throwIfAborted()
      const models = await Codex.models(connection.client)
      const selected = input.model?.modelID ?? session.engine.model
      const model = selected
        ? models.find((item) => item.id === selected)
        : (models.find((item) => item.default) ?? models[0])
      if (!model)
        throw new Error(
          selected
            ? `Codex did not advertise model ${selected}. Refresh its model list.`
            : "Codex did not advertise any available models.",
        )
      const effort =
        input.variant ?? (model.id === session.engine.model ? session.engine.effort : undefined) ?? model.effort
      if (effort && !model.efforts.includes(effort))
        throw new Error(`Codex model ${model.id} does not support reasoning effort ${effort}.`)
      const native = await NativeInput.build(
        pending.flatMap((entry) => entry.data.parts),
        session.id,
        signal,
      )
      await NativeSkills.validate(
        native.filter((item) => item.type === "skill"),
        connection.client,
        session.directory,
        signal,
      )
      if (model.images === false && native.some((item) => item.type === "image" || item.type === "localImage"))
        throw new Error(`Codex model ${model.id} does not support image input. Choose a model that supports images.`)
      if (input.system)
        native.unshift({
          type: "text",
          text: `Additional context supplied for this turn:\n${input.system}`,
          text_elements: [],
        })
      if (!native.length) throw new Error("The message has no supported content to send to Codex.")
      const file = await Codex.discover(cfg.native?.codex?.path)
      const capabilities = file ? await NativeModes.discover(file) : { steer: false, plan: false }
      const collaboration = await NativeModes.resolve(
        connection.client,
        {
          mode: session.engine.mode ?? "default",
          model: model.id,
          effort,
          previous: session.engine.collaboration,
        },
        capabilities,
      )
      const permissions = NativePermissions.resolve(
        session.engine.permission,
        session.directory,
        file && session.engine.permission === "auto" ? await NativePermissions.discover(file) : undefined,
      )
      const params = {
        model: model.id,
        cwd: session.directory,
        ...permissions.thread,
        ...(session.engine.thread
          ? { threadId: session.engine.thread, excludeTurns: true }
          : { serviceName: "aether" }),
      }
      if (connection.thread && connection.thread !== session.engine.thread)
        throw new Error("The native connection does not match this session's saved thread.")
      const metadata = response.parse(
        await connection.client.request(
          connection.thread ? "thread/read" : session.engine.thread ? "thread/resume" : "thread/start",
          connection.thread ? { threadId: connection.thread, includeTurns: false } : params,
          { signal },
        ),
      )
      const thread =
        connection.thread && metadata.thread.status?.type === "notLoaded"
          ? response.parse(await connection.client.request("thread/resume", params, { signal }))
          : metadata
      if (session.engine.thread && thread.thread.id !== session.engine.thread)
        throw new Error("Codex resumed a different thread; the conversation was not continued.")
      if (thread.thread.status?.type === "active")
        throw new Error("The native Codex thread is already active in this execution service.")
      if (thread.thread.status?.type === "systemError")
        throw new Error("The native Codex thread entered a system error.")
      NativeStore.bind(session.id, connection.home)
      connection.bind(thread.thread.id)
      events.state.thread = thread.thread.id
      tree.registerRoot(thread.thread)
      user.model.modelID = ModelID.make(model.id)
      user.variant = effort
      assistant.modelID = user.model.modelID
      assistant.variant = effort
      await Session.updateMessage(user)
      await Session.updateMessage(assistant)
      signal.throwIfAborted()
      await connection.client.drain()
      signal.throwIfAborted()
      const payload = {
        threadId: thread.thread.id,
        input: native,
        model: model.id,
        effort,
        clientUserMessageId: user.id,
        ...permissions.turn,
        ...(collaboration ? { collaborationMode: collaboration } : {}),
        ...(input.format?.type === "json_schema" ? { outputSchema: input.format.schema } : {}),
      }
      Protocol.check("turn/start", payload)
      const engine = {
        type: "codex" as const,
        thread: thread.thread.id,
        model: model.id,
        effort,
        cursor: user.id,
        collaboration: session.engine.collaboration,
      }
      // Once dispatch begins, an ambiguous transport failure must not replay
      // potentially executed input. Before this point, queued context stays pending.
      await Session.setEngine({
        sessionID: session.id,
        preserve: true,
        engine,
      })
      if (signal.aborted) {
        await Session.setEngine({ sessionID: session.id, engine: session.engine, preserve: true })
        signal.throwIfAborted()
      }
      events.state.active = true
      tree.activate()
      NativeStore.begin(
        session.id,
        user.id,
        assistant.id,
        thread.thread.id,
        pending.map((entry) => entry.id),
      )
      NativeStore.receipt(assistant)
      if (collaboration)
        await Session.setEngine({
          sessionID: session.id,
          preserve: true,
          // A failed default switch can leave a native plan active. Until the
          // response confirms the switch, retain either possible plan state.
          // Persist this before dispatch so a crash cannot lose that evidence.
          engine: { ...engine, collaboration: engine.collaboration === "plan" ? "plan" : collaboration.mode },
        })
      const sent = await connection.client.request("turn/start", payload, { signal }).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      if (sent.error) {
        if (collaboration && sent.error instanceof Protocol.RpcError)
          await Session.setEngine({
            sessionID: session.id,
            preserve: true,
            engine,
          })
        throw sent.error
      }
      const turn = started.parse(sent.value)
      if (events.state.turn && events.state.turn !== turn.turn.id) throw new Error("Codex started an unexpected turn.")
      if (collaboration?.mode === "default" && engine.collaboration === "plan")
        await Session.setEngine({
          sessionID: session.id,
          preserve: true,
          engine: { ...engine, collaboration: collaboration.mode },
        })
      NativeStore.accept(session.id, user.id, turn.turn.id)
      events.state.turn = turn.turn.id
      tree.bindTurn(turn.turn.id)
      control.ready(connection.client, thread.thread.id, turn.turn.id, capabilities.steer, model.images)
      const exited = Promise.withResolvers<NativeEvents.Outcome>()
      state.off = connection.client.onExit(() => {
        void (async () => {
          await connection.client.drain()
          if (events.state.settled) return exited.resolve(await events.done)
          exited.resolve({
            status: signal.aborted ? "interrupted" : "failed",
            error: "Codex exited before completing the turn.",
          })
        })().catch(() => exited.resolve({ status: "failed", error: "Codex exited before completing the turn." }))
      })
      const outcome = await Promise.race([events.done, exited.promise])
      await connection.client.drain()
      const result = await events.finish(signal.aborted ? { status: "interrupted" } : outcome)
      NativeStore.receipt(assistant)
      state.keep = !signal.aborted && outcome.status === "completed"
      return result
    } catch (err) {
      NativeStore.fail(session.id, user.id)
      NativeStore.uncertain(session.id, user.id)
      const result = await events.finish({ status: signal.aborted ? "interrupted" : "failed", error: message(err) })
      NativeStore.receipt(assistant)
      return result
    } finally {
      signal.removeEventListener("abort", abort)
      state.off?.()
      await state.interrupt
      await control.close()
      tree.close()
      const revision = NativeRuntime.revision()
      await Config.getGlobal()
        .then((cfg) => NativeRuntime.configure(cfg.native?.codex, revision))
        .catch(() => {
          state.keep = false
        })
      await state.lease?.release(state.keep)
    }
  }
}
