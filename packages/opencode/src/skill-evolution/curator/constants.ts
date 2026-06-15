export interface CuratorConfig {
  enabled: boolean
  /** Minimum hours between curator runs. */
  intervalHours: number
  /** Days of inactivity before a skill is marked stale. */
  staleAfterDays: number
  /** Days of inactivity before a skill is archived. */
  archiveAfterDays: number
}

/** Defaults match Hermes (curator/core.py): 7 days / 30 days / 90 days. */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  enabled: true,
  intervalHours: 24 * 7,
  staleAfterDays: 30,
  archiveAfterDays: 90,
}
