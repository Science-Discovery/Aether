import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { type SessionID, MessageID, PartID } from "../session/schema"
import { Config } from "../config/config"
import { Global } from "@/global"
import { PROJECT } from "@/persist/naming"
import { Filesystem } from "../util/filesystem"
import { MCP } from "../mcp"

async function getLastModel(sessionID: SessionID) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

async function getAgentConfig(agentName: string) {
  const cfg = await Config.get()
  return cfg.agent?.[agentName]
}

function modeOutputDir(agentName: string, agentCfg: Config.Agent): string {
  const dir = agentCfg.output_dir ?? agentName
  return Instance.project.vcs
    ? path.join(PROJECT, dir)
    : path.relative(Instance.worktree, path.join(Global.Path.data, dir))
}

function notepadDir(agentName: string, agentCfg: Config.Agent, session: Session.Info): string {
  const base = modeOutputDir(agentName, agentCfg)
  return path.join(base, "notepads", [session.time.created, session.slug].join("-"))
}

const NOTEPAD_FILES = ["sources.md", "findings.md", "gaps.md", "learnings.md", "report.md"]

async function activateMcp(agentCfg: Config.Agent | undefined) {
  if (!agentCfg?.mcp) return
  for (const [name, enabled] of Object.entries(agentCfg.mcp)) {
    if (!enabled) continue
    try {
      await MCP.connect(name)
    } catch {
      const { Log } = await import("../util/log")
      Log.create({ service: "mode-switch" }).warn("failed to connect MCP", { name })
    }
  }
}

async function deactivateMcp(agentCfg: Config.Agent | undefined) {
  if (!agentCfg?.mcp) return
  for (const [name, enabled] of Object.entries(agentCfg.mcp)) {
    if (!enabled) continue
    try {
      await MCP.disconnect(name)
    } catch {
      const { Log } = await import("../util/log")
      Log.create({ service: "mode-switch" }).warn("failed to disconnect MCP", { name })
    }
  }
}

export function createModeEnterTool(agentName: string) {
  return Tool.define(`${agentName}_enter`, async () => {
    const agentCfg = await getAgentConfig(agentName)
    const extraDesc = agentCfg?.enter_description ?? ""
    return {
      description: `Switch to the ${agentName} agent mode. ${extraDesc}`,
      parameters: z.object({}),
      async execute(_params, ctx) {
        const cfg = await getAgentConfig(agentName)
        const desc = cfg?.description ?? `the ${agentName} agent`
        const answers = await Question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              question: `Would you like to switch to the ${agentName} agent?`,
              header: `${agentName} mode`,
              custom: false,
              options: [
                { label: "Yes", description: `Switch to ${desc}` },
                { label: "No", description: "Stay with current agent" },
              ],
            },
          ],
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })

        const answer = answers[0]?.[0]
        if (answer === "No") throw new Question.RejectedError()

        await activateMcp(cfg)

        const model = await getLastModel(ctx.sessionID)
        const session = await Session.get(ctx.sessionID)

        let switchText = `User has requested to enter ${agentName} mode. Switch to ${agentName} mode and begin.`
        if (cfg?.output_dir) {
          const npDir = notepadDir(agentName, cfg, session)
          const fullDir = Instance.project.vcs ? path.join(Instance.worktree, npDir) : npDir
          await fs.mkdir(fullDir, { recursive: true })
          for (const file of NOTEPAD_FILES) {
            const fp = path.join(fullDir, file)
            if (!(await Filesystem.exists(fp))) {
              await Bun.write(fp, `# ${file.replace(".md", "").toUpperCase()}\n\n`)
            }
          }
          const reportPath = path.join(npDir, "report.md")
          switchText += `\n\nResearch notepad created at ${npDir}/. Structure:`
          switchText += `\n  - sources.md: Record all sources found with quality ratings`
          switchText += `\n  - findings.md: Key findings per sub-question`
          switchText += `\n  - gaps.md: Unanswered questions, uncertainties`
          switchText += `\n  - learnings.md: Accumulated wisdom for forward-pass to subagents`
          switchText += `\n  - report.md: Final research report (write here at Phase 4)`
          switchText += `\n\nUpdate each file as you progress. Final report goes in ${reportPath}.`
        }

        const userMsg: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID: ctx.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agentName,
          model,
        }
        await Session.updateMessage(userMsg)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMsg.id,
          sessionID: ctx.sessionID,
          type: "text",
          text: switchText,
          synthetic: true,
        } satisfies MessageV2.TextPart)

        return {
          title: `Switching to ${agentName}`,
          output: `User confirmed switch. Wait for further instructions.`,
          metadata: {},
        }
      },
    }
  })
}

export function createModeExitTool(agentName: string) {
  return Tool.define(`${agentName}_exit`, async () => {
    const agentCfg = await getAgentConfig(agentName)
    const extraDesc = agentCfg?.exit_description ?? ""
    return {
      description: `Exit ${agentName} mode and switch to another agent. ${extraDesc}`,
      parameters: z.object({}),
      async execute(_params, ctx) {
        const cfg = await getAgentConfig(agentName)
        const session = await Session.get(ctx.sessionID)

        const defaultOptions = [
          { label: "Build", agent: "build", description: "Switch to build agent" },
          { label: "Plan", agent: "plan", description: "Switch to plan agent" },
        ]
        const exitOpts = cfg?.exit_options ?? defaultOptions

        const questionOptions = exitOpts.map((opt) => ({
          label: opt.label,
          description: opt.description,
        }))
        questionOptions.push({ label: "Stay", description: `Stay with ${agentName} agent` })

        const answers = await Question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              question: `${agentName} mode is complete. Where would you like to go next?`,
              header: "Next step",
              custom: false,
              options: questionOptions,
            },
          ],
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })

        const answer = answers[0]?.[0]
        if (answer === "Stay") throw new Question.RejectedError()

        const chosen = exitOpts.find((opt) => opt.label === answer)
        if (!chosen) throw new Question.RejectedError()

        await deactivateMcp(cfg)

        const model = await getLastModel(ctx.sessionID)

        let switchText = `Switching from ${agentName} to ${chosen.agent} mode.`
        if (cfg?.output_dir) {
          const npDir = notepadDir(agentName, cfg, session)
          const reportPath = path.join(npDir, "report.md")
          const full = Instance.project.vcs ? path.join(Instance.worktree, reportPath) : reportPath
          const exists = await Filesystem.exists(full)
          if (exists) {
            switchText += `\n\nA ${agentName} report exists at ${reportPath}. Read it to understand the research findings.`
            switchText += `\nAdditional notepad files at ${npDir}/: sources.md, findings.md, gaps.md, learnings.md.`
          }
        }

        const userMsg: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID: ctx.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: chosen.agent,
          model,
        }
        await Session.updateMessage(userMsg)
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMsg.id,
          sessionID: ctx.sessionID,
          type: "text",
          text: switchText,
          synthetic: true,
        } satisfies MessageV2.TextPart)

        return {
          title: `Switching to ${chosen.agent}`,
          output: `User chose to switch to ${chosen.agent}. Wait for further instructions.`,
          metadata: { targetAgent: chosen.agent },
        }
      },
    }
  })
}

export function createModeTools(agentName: string) {
  return {
    enter: createModeEnterTool(agentName),
    exit: createModeExitTool(agentName),
  }
}
