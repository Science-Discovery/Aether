import fs from "fs"
import path from "path"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { which } from "@/util/which"

export namespace WolframMCP {
  export const NAME = "Wolfram"
  export const SERVER = "WolframLanguage"
  export const TIMEOUT = 60_000
  export const START = 'PacletSymbol["Wolfram/AgentTools","Wolfram`AgentTools`StartMCPServer"][]'

  export type Input = {
    binary?: string
    server?: string
    timeout?: number
  }

  export type Paclet = {
    ok: boolean
    script?: string
    error?: string
  }

  function executable(file: string | undefined) {
    if (!file) return undefined
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return file
    } catch {
      return undefined
    }
  }

  function sibling(file: string | undefined, name: string) {
    if (!file) return undefined
    return executable(path.join(path.dirname(file), name))
  }

  function versions(root: string, name: string) {
    if (!fs.existsSync(root)) return [] as string[]
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => executable(path.join(root, entry.name, "Executables", name)))
      .filter((item): item is string => !!item)
      .sort((a, b) => b.localeCompare(a))
  }

  export function findScript() {
    return (
      which("wolframscript") ??
      executable("/usr/local/Wolfram/Mathematica/14.3/Executables/wolframscript") ??
      executable("/usr/local/Wolfram/WolframEngine/14.3/Executables/wolframscript")
    )
  }

  export function findBinary(input?: string) {
    const script = findScript()
    return (
      executable(input) ??
      which("wolfram") ??
      which("WolframKernel") ??
      sibling(script, "wolfram") ??
      sibling(script, "WolframKernel") ??
      versions("/usr/local/Wolfram/Mathematica", "wolfram")[0] ??
      versions("/usr/local/Wolfram/WolframEngine", "wolfram")[0] ??
      (process.platform === "darwin"
        ? executable("/Applications/Mathematica.app/Contents/MacOS/WolframKernel")
        : undefined)
    )
  }

  export function config(input: Input = {}): Config.Mcp {
    const binary = findBinary(input.binary)
    if (!binary) throw new Error("Could not find a Wolfram executable. Install Mathematica or pass --binary.")
    return {
      type: "local",
      command: [binary, "-run", START, "-noinit", "-noprompt"],
      enabled: true,
      timeout: input.timeout ?? TIMEOUT,
      environment: {
        MCP_SERVER_NAME: input.server ?? SERVER,
        ...(process.env.WOLFRAM_USERBASE ? { WOLFRAM_USERBASE: process.env.WOLFRAM_USERBASE } : {}),
      },
    }
  }

  export async function installPaclet(): Promise<Paclet> {
    const script = findScript()
    if (!script) {
      return {
        ok: false,
        error: "Could not find wolframscript. Install Wolfram/AgentTools manually or rerun with --no-paclet-install.",
      }
    }

    const code = [
      "$PrePrint = InputForm;",
      'If[Length[PacletFind["Wolfram/AgentTools"]] == 0, PacletInstall["Wolfram/AgentTools"]];',
      'If[Length[PacletFind["Wolfram/AgentTools"]] > 0, Print["ok"]; Exit[0], Print["missing"]; Exit[1]];',
    ].join(" ")
    const out = await Process.run([script, "-code", code], {
      nothrow: true,
      timeout: 120_000,
    })
    if (out.code === 0) return { ok: true, script }
    return {
      ok: false,
      script,
      error: (out.stderr.toString().trim() || out.stdout.toString().trim() || "Paclet installation failed").slice(
        0,
        2_000,
      ),
    }
  }
}
