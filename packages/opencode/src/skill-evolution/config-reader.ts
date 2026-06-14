import { Config } from "@/config/config"
import { DEFAULT_NUDGE_INTERVAL, VERSION_CAPACITY } from "./constants"

export namespace ConfigReader {
  /**
   * Returns the nudge interval from the main opencode config (skills.creation_nudge_interval).
   * 0 means disabled. Falls back to DEFAULT_NUDGE_INTERVAL if not set.
   */
  export async function getNudgeInterval(): Promise<number> {
    const cfg = await Config.get().catch(() => undefined)
    if (typeof cfg?.skills?.creation_nudge_interval === "number") {
      return cfg.skills.creation_nudge_interval
    }
    return DEFAULT_NUDGE_INTERVAL
  }

  /**
   * Returns max version snapshots per skill from the main opencode config
   * (skills.max_versions). Falls back to VERSION_CAPACITY if not set.
   */
  export async function getMaxVersions(): Promise<number> {
    const cfg = await Config.get().catch(() => undefined)
    if (typeof cfg?.skills?.max_versions === "number") return cfg.skills.max_versions
    return VERSION_CAPACITY
  }

  /**
   * Global master switch for skill self-evolution (skills.evolution_enabled).
   * Unset means enabled — only an explicit `false` turns evolution off, so
   * existing configs keep evolving. Read at every trigger point (hook.onLoopEnd).
   */
  export async function isEvolutionEnabled(): Promise<boolean> {
    const cfg = await Config.get().catch(() => undefined)
    return cfg?.skills?.evolution_enabled !== false
  }

  /**
   * Returns the full skill evolution config, merging config values with defaults.
   */
  export async function get(): Promise<{ creation_nudge_interval: number; max_versions: number }> {
    const [interval, maxVersions] = await Promise.all([getNudgeInterval(), getMaxVersions()])
    return { creation_nudge_interval: interval, max_versions: maxVersions }
  }
}
