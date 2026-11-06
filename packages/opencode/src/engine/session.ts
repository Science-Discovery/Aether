import { NamedError } from "@opencode-ai/util/error"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import type { SessionPrompt } from "@/session/prompt"
import { Engine } from "./schema"
import { Acp } from "./acp"
import { Claude } from "./claude"
import { ZCode } from "./zcode"

export namespace EngineSession {
  export async function prompt(
    input: SessionPrompt.PromptInput,
    session: Session.Info,
    signal: AbortSignal,
  ): Promise<MessageV2.WithParts> {
    const acp = session.acp
    if (!acp) throw new Error("This session does not use an ACP backend.")
    if (Object.keys(input.tools ?? {}).length) {
      throw new Error("Aether tool overrides are not supported by this backend.")
    }
    signal.throwIfAborted()
    const model = input.model && input.model.modelID !== "default" ? input.model.modelID : acp.model
    const effort = input.variant ?? acp.effort
    const user: MessageV2.User = {
      id: input.messageID ?? MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: acp.type,
      model: {
        providerID: ProviderID.make(`engine-${acp.type}`),
        modelID: ModelID.make(model ?? "default"),
      },
      variant: effort,
      system: input.system,
      format: input.format,
    }
    const parts = input.parts.map((part) => ({
      ...part,
      id: part.id ?? PartID.ascending(),
      messageID: user.id,
      sessionID: session.id,
    }))
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
    const assistant: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "assistant",
      parentID: user.id,
      agent: acp.type,
      mode: acp.type,
      modelID: user.model.modelID,
      providerID: user.model.providerID,
      path: { cwd: session.directory, root: Instance.worktree },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: user.variant,
    }
    await Session.updateMessage(assistant)
    let current = { ...acp }
    const save = async (remote: string, patch?: Partial<Engine.Info>) => {
      current = { ...current, session: remote, ...patch }
      await Session.setAcp({
        sessionID: session.id,
        acp: current,
      })
    }
    try {
      if (acp.type === "zcode") {
        return await ZCode.run({
          model,
          effort,
          mode: acp.mode,
          permission: acp.permission ?? "auto",
          session: session.id,
          directory: session.directory,
          remote: acp.session,
          parts,
          assistant,
          signal,
          save,
          system: input.system,
        })
      }
      if (acp.type === "claude") {
        return await Claude.run({
          model,
          effort,
          permission: acp.permission ?? "auto",
          session: session.id,
          directory: session.directory,
          remote: acp.session,
          parts,
          assistant,
          signal,
          save,
          system: input.system,
        })
      }
      return await Acp.run({
        id: acp.type,
        model,
        effort,
        mode: acp.mode,
        permission: acp.permission ?? "auto",
        session: session.id,
        directory: session.directory,
        remote: acp.session,
        parts,
        assistant,
        signal,
        save,
        system: input.system,
      })
    } catch (error) {
      assistant.time.completed = Date.now()
      assistant.finish = "error"
      assistant.error = new NamedError.Unknown({
        message: error instanceof Error ? error.message : "The agent turn failed.",
      }).toObject()
      await Session.updateMessage(assistant)
      return { info: assistant, parts: [] }
    }
  }
}
