import z from "zod"
import { ManagedMinerU } from "@/mineru/managed"
import { Tool } from "./tool"

const Params = z.object({
  action: z.enum(["inspect", "install", "adopt", "resume", "status", "verify", "cancel"]),
  channel: z.enum(["validated", "latest"]).optional(),
  candidate: z.string().optional(),
  reset: z.boolean().optional(),
})

function safe(status: z.infer<typeof ManagedMinerU.Status>) {
  return {
    ...status,
    logs: status.logs.slice(-12),
  }
}

function meta(action: z.infer<typeof Params>["action"], data: unknown) {
  return { action, data }
}

export const MineruSetupTool = Tool.define("mineru_setup", {
  description:
    "Inspect, configure, resume, verify, or adopt a local MinerU runtime through Aether's constrained Windows manager. It never accepts arbitrary commands or installation paths.",
  parameters: Params,
  async execute(args, ctx) {
    if (args.action === "inspect") {
      const value = await ManagedMinerU.inspect()
      return {
        title: "Inspected MinerU environment",
        metadata: meta(args.action, value),
        output: JSON.stringify(value, null, 2),
      }
    }

    if (args.action === "status") {
      const value = await ManagedMinerU.status()
      return {
        title: value.message,
        metadata: meta(args.action, safe(value)),
        output: JSON.stringify(safe(value), null, 2),
      }
    }

    if (args.action === "cancel") {
      const value = await ManagedMinerU.cancel()
      return {
        title: value.message,
        metadata: meta(args.action, safe(value)),
        output: JSON.stringify(safe(value), null, 2),
      }
    }

    if (args.action === "adopt") {
      if (!args.candidate) throw new Error("candidate is required when adopting an existing MinerU environment")
      const value = await ManagedMinerU.adopt(args.candidate)
      return {
        title: value.message,
        metadata: meta(args.action, safe(value)),
        output: JSON.stringify(safe(value), null, 2),
      }
    }

    if (args.action === "verify") {
      const value = await ManagedMinerU.verify()
      return {
        title: "MinerU health check passed",
        metadata: meta(args.action, safe(value)),
        output: JSON.stringify(safe(value), null, 2),
      }
    }

    await ManagedMinerU.install({
      channel: args.channel ?? "validated",
      reset: args.action === "install" && args.reset === true,
    })
    const abort = () => void ManagedMinerU.cancel()
    ctx.abort.addEventListener("abort", abort, { once: true })
    try {
      while (true) {
        const value = await ManagedMinerU.status()
        ctx.metadata({ title: value.message, metadata: meta(args.action, safe(value)) })
        if (value.install !== "installing") break
        await Bun.sleep(500)
      }
      const value = await ManagedMinerU.wait()
      if (value.install === "failed") throw new Error(value.error ?? "MinerU configuration failed")
      return {
        title: value.message,
        metadata: meta(args.action, safe(value)),
        output: JSON.stringify(safe(value), null, 2),
      }
    } finally {
      ctx.abort.removeEventListener("abort", abort)
    }
  },
})
