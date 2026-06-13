export interface CuratorConfig {
  enabled: boolean
  /** Minimum hours between curator runs (scheduling — unchanged). */
  intervalHours: number
  /** Consecutive idle scans (no use between scans) before a skill is marked stale. */
  staleAfterIdleScans: number
  /** Consecutive idle scans before a skill is archived. */
  archiveAfterIdleScans: number
}

/**
 * Defaults: scan every 7 days (interval unchanged), 4 idle scans → stale (≈30 days),
 * 12 idle scans → archive (≈90 days). The archive criterion no longer uses calendar
 * dates — see IDLE_SCANS_DESIGN.md (option A).
 */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  enabled: true,
  intervalHours: 24 * 7,
  staleAfterIdleScans: 4,
  archiveAfterIdleScans: 12,
}
