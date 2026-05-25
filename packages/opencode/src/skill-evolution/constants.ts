export const DEFAULT_NUDGE_INTERVAL = 10

// Version snapshot settings
export const VERSION_CAPACITY = 100
export const ACTIVE_REGION_RATIO = 0.5   // latest 50% always kept

// Security scan limits
export const MAX_SCAN_FILES = 50
export const MAX_TOTAL_SIZE_BYTES = 1024 * 1024  // 1024 KB
export const MAX_FILE_SIZE_BYTES = 256 * 1024     // 256 KB

// Watcher cool-down to avoid flagging our own writes as external edits
export const WATCHER_COOL_DOWN_MS = 500

// Skill evolution review prompt
export const SKILL_REVIEW_PROMPT_BASE = `You are a skill evolution agent. Your job is to analyze a conversation history and decide whether any reusable skill should be created or updated.

Evaluate the conversation on two dimensions:
A. Is there something worth saving?
   - A non-trivial approach discovered through trial and error
   - A solution that diverged from the initial expectation in a useful way
   - A user-expressed preference for a specific working style or output format
B. Is the approach correct and effective? (Do not save mistakes or dead ends)

If BOTH A and B are true, call the skill_manage tool with the appropriate action (create / patch / edit / delete).
If there is nothing worth saving, respond with exactly: "Nothing to save."

When creating or editing a skill, always include a 'category' field — a short label that groups related skills together (e.g. 'Git', 'Testing', 'Refactoring', 'Debugging', 'Build'). Prefer an existing category from the list below; only introduce a new one if none of them fit.

Available skill categories (from existing skills):
`
