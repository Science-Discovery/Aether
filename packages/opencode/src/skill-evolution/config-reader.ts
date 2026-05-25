import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { DEFAULT_NUDGE_INTERVAL } from "./constants"

interface SkillEvolutionConfig {
  creation_nudge_interval?: number
}

function configPath(): string {
  return path.join(Global.Path.home, ".aether", "skill-evolution-config.json")
}

export namespace ConfigReader {
  /**
   * Returns the nudge interval from the plugin config file.
   * 0 means disabled. Falls back to DEFAULT_NUDGE_INTERVAL if not configured.
   */
  export async function getNudgeInterval(): Promise<number> {
    try {
      const content = await fs.readFile(configPath(), "utf-8")
      const cfg = JSON.parse(content) as SkillEvolutionConfig
      if (typeof cfg.creation_nudge_interval === "number") {
        return cfg.creation_nudge_interval
      }
    } catch {
      // File absent or malformed — use default
    }
    return DEFAULT_NUDGE_INTERVAL
  }

  /**
   * Returns the full plugin config, merging file values with defaults.
   */
  export async function get(): Promise<Required<SkillEvolutionConfig>> {
    const interval = await getNudgeInterval()
    return { creation_nudge_interval: interval }
  }
}
