import { tool, type Plugin, type ToolContext } from __SUPERAGENT_PLUGIN__
import path from "node:path"

// Replaced with a JSON string by the installer; no secret is embedded in source.
const bridgeFile = __SUPERAGENT_BRIDGE__

export const SuperagentPlugin: Plugin = async ({ directory }) => {
  const primary = new Set<string>()
  const observed = new Map<string, string>()
  const allowed = new Set(["superagent_dispatch", "superagent_status", "superagent_stop", "question"])
  const track = (session: string, agent: unknown) => {
    const name = typeof agent === "string" ? agent : agent && typeof agent === "object" && "name" in agent ? agent.name : undefined
    if (name === "superagent") primary.add(session)
    else primary.delete(session)
  }
  async function request(name: string, args: unknown, context: { sessionID?: string; messageID?: string; directory: string; agent?: string; callID?: string }, signal: AbortSignal) {
    const config = await Bun.file(bridgeFile).json()
    const url = new URL(config.url)
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.pathname !== "/" || url.username || url.password || url.search || url.hash || !path.isAbsolute(config.tokenFile))
      throw new Error("Invalid local Super-agent configuration.")
    const token = (await Bun.file(config.tokenFile).text()).trim()
    if (!token) throw new Error("Super-agent token is missing.")
    const response = await fetch(new URL("/native/tool", url), {
      unix: path.join(path.dirname(config.tokenFile), "control.sock"),
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, context: {
        sessionID: context.sessionID, messageID: context.messageID, directory: context.directory,
        agent: context.agent, ...(context.callID ? { callID: context.callID } : {}),
      } }),
    })
    if (!response.ok) throw new Error(`Super-agent: ${await response.text()}`)
    return await response.text()
  }
  async function call(name: string, args: unknown, context: ToolContext) {
    const callID = (context as ToolContext & { callID?: string }).callID
    if (!callID) throw new Error("This Aether version does not expose tool call identity.")
    const worker = name === "report"
    if (context.agent !== (worker ? "superagent-worker" : "superagent"))
      throw new Error("Select the Super-agent role to use coordination tools.")
    await context.ask({ permission: `superagent_${name}`, patterns: ["*"], always: ["*"], metadata: {} })
    return request(name, args, { sessionID: context.sessionID, messageID: context.messageID,
      directory: context.directory, agent: context.agent, callID }, context.abort)
  }
  const z = tool.schema
  return {
    // Use the resolved turn role, not the requested/default role. Runtime params
    // currently supplies Agent.Info even though the public hook types say string.
    "chat.message": async (input, output) => { track(input.sessionID, output.message.agent) },
    "chat.params": async (input) => {
      track(input.sessionID, input.agent)
      const message = input.message?.id
      if (!primary.has(input.sessionID) || !message || observed.get(input.sessionID) === message) return
      observed.set(input.sessionID, message)
      // This is an observation of an already-persisted user turn, not a model
      // tool invocation or permission grant. Native validates that exact turn.
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          request("observe", {}, { sessionID: input.sessionID, messageID: message, directory, agent: "superagent" }, controller.signal),
          new Promise<void>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve() }, 2000) }),
        ])
      } catch { /* An unavailable optional coordinator must not block conversation. */ }
      finally { if (timer) clearTimeout(timer) }
    },
    "tool.execute.before": async (input) => {
      if (primary.has(input.sessionID) && !allowed.has(input.tool))
        throw new Error("Super-agent coordinates registered tasks. Use superagent_dispatch with the user's project directory for filesystem investigation or execution; use question if the directory is missing.")
    },
    // The native UI exposes its composer before async session preferences arrive.
    // Give only our owned main workspace the correct initial agent ordering too.
    config: async (config) => {
      try {
        const bridge = await Bun.file(bridgeFile).json()
        if (typeof bridge.tokenFile !== "string" || !path.isAbsolute(bridge.tokenFile)) return
        const legacy = path.join(path.dirname(bridge.tokenFile), "native-master")
        if (directory === legacy || directory.startsWith(legacy + path.sep)) {
          config.default_agent = "superagent"
          return
        }
        if (path.basename(directory) !== "v05" || path.basename(path.dirname(directory)) !== "native-master") return
        if (await request("owns_directory", {}, { directory }, AbortSignal.timeout(750)) === "true")
          config.default_agent = "superagent"
      } catch { /* Uninstalled or unavailable configuration must not break other workspaces. */ }
    },
    tool: {
    superagent_dispatch: tool({
      description: "Delegate a research objective to an Aether worker, or continue a related task by its ticket ID. Returns immediately; results are reported back to this conversation. Reuse a suitable existing task after checking status. For a new project, pass its user-selected local directory as project; Git is reused or initialized automatically. If there is no configured default and no known path, ask the user for the project directory first.",
      args: { text: z.string(), title: z.string().optional(), ticket: z.string().optional(), project: z.string().optional() },
      execute: (args, ctx) => call("dispatch", args, ctx),
    }),
    superagent_status: tool({
      description: "Read research objectives, current progress, blockers and worker results for this main conversation. Use before routing follow-ups or during proactive checks.",
      args: {}, execute: (args, ctx) => call("status", args, ctx),
    }),
    superagent_stop: tool({
      description: "Stop further dispatch of a task and request its worker to abort. External background computations require separate confirmation; do not claim they stopped from this receipt alone.",
      args: { ticket: z.string() }, execute: (args, ctx) => call("stop", args, ctx),
    }),
    superagent_report: tool({
      description: "Report progress for the exact ticket/run assigned in your work instruction. Increment revision for each report. Progress updates the research panel; answer, ready and blocker also notify the main agent. A report does not itself end execution.",
      args: {
        ticket: z.string(), run: z.string(), revision: z.number().int().positive(),
        kind: z.enum(["progress", "answer", "ready", "blocker"]), summary: z.string(), answer: z.string().optional(),
        research: z.object({
          objective: z.string().optional(), stage: z.enum(["planning", "research", "deriving", "computing", "verifying", "blocked", "review"]).optional(),
          summary: z.string().optional(), next: z.string().optional(), blockers: z.array(z.string()).optional(),
          milestones: z.array(z.object({ id: z.string(), title: z.string(), state: z.enum(["planned", "active", "done"]) })).optional(),
          evidence: z.array(z.object({ label: z.string(), path: z.string() })).optional(),
        }).optional(),
      }, execute: (args, ctx) => call("report", args, ctx),
    }),
  } }
}
