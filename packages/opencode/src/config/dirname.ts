/**
 * Centralized resolution of the config directory name.
 *
 * The default is `.opencode` for backward compatibility.  Users can override
 * the name by setting `OPENCODE_CONFIG_DIR_NAME` (e.g. `.aether`,
 * `.config/opencode`).  The value must be a relative directory name / path,
 * **not** an absolute path – use `OPENCODE_CONFIG_DIR` for that.
 */
const DEFAULT_CONFIG_DIR_NAME = ".opencode"

export function getConfigDirName(): string {
  return process.env.OPENCODE_CONFIG_DIR_NAME?.trim() || DEFAULT_CONFIG_DIR_NAME
}
