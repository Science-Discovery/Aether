export interface CuratorConfig {
  enabled: boolean
  /** Minimum hours between curator runs (scheduling cadence, NOT an archive criterion). */
  intervalHours: number
  /**
   * Archive a skill whose post-birth call share (use_count / post-birth exposure,
   * within its own project) falls BELOW this. Default 0.001 (one in a thousand).
   * See RELATIVE_USAGE_DESIGN.md D1.
   */
  archiveUsageShare: number
  /**
   * Birth trial window: a skill is not judged until its post-birth exposure
   * (same-project calls since it was created) reaches this many. Measured in
   * CALLS, not days, so the criterion stays time-free. Default 1000.
   * See RELATIVE_USAGE_DESIGN.md D3.
   */
  minExposureCalls: number
}

/** Defaults: weekly sweep; archive below 0.1% share once 1000 post-birth calls have passed. */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  enabled: true,
  intervalHours: 24 * 7,
  archiveUsageShare: 0.001,
  minExposureCalls: 1000,
}
