export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

export type ProviderModelNotFoundError = {
  name: "ProviderModelNotFoundError"
  data: {
    providerID: string
    modelID: string
    suggestions?: string[]
  }
}

export type WorktreeNamedErrorLike = {
  name: string
  data?: { message?: string }
}

type Translator = (key: string, vars?: Record<string, string | number>) => string

function tr(translator: Translator | undefined, key: string, text: string, vars?: Record<string, string | number>) {
  if (!translator) return text
  const out = translator(key, vars)
  if (!out || out === key) return text
  return out
}

const WORKTREE_ERROR_MAP: Record<string, string> = {
  WorktreeNotGitError: "error.chain.worktree.notGit",
  WorktreeNameGenerationFailedError: "error.chain.worktree.nameGenerationFailed",
  WorktreeCreateFailedError: "error.chain.worktree.createFailed",
  WorktreeStartCommandFailedError: "error.chain.worktree.startCommandFailed",
  WorktreeRemoveFailedError: "error.chain.worktree.removeFailed",
  WorktreeResetFailedError: "error.chain.worktree.resetFailed",
}

const WORKTREE_ERROR_TEXT: Record<string, string> = {
  WorktreeNotGitError: "Worktrees are only supported for git projects",
  WorktreeNameGenerationFailedError: "Failed to generate workspace name",
  WorktreeCreateFailedError: "Failed to create workspace",
  WorktreeStartCommandFailedError: "Workspace start command failed",
  WorktreeRemoveFailedError: "Failed to remove workspace",
  WorktreeResetFailedError: "Failed to reset workspace",
}

const WORKTREE_MESSAGE_KEY_MAP: Record<string, string> = {
  "Worktrees are only supported for git projects": "error.chain.worktree.notGit",
  "Cannot reset the primary workspace": "error.chain.worktree.cannotResetPrimary",
  "Default branch not found": "error.chain.worktree.defaultBranchNotFound",
  "Worktree not found": "error.chain.worktree.notFound",
}

const WORKTREE_MESSAGE_TEXT_MAP: Record<string, string> = {
  "Worktrees are only supported for git projects": "Worktrees are only supported for git projects",
  "Cannot reset the primary workspace": "Cannot reset the primary workspace",
  "Default branch not found": "Default branch not found",
  "Worktree not found": "Workspace not found",
}

function parseWorktreeError(error: WorktreeNamedErrorLike, translator?: Translator) {
  const errorName = error.name
  const key = WORKTREE_ERROR_MAP[errorName]
  if (!key) return extractDataMessage(error, translator)
  const msg = error.data?.message?.trim() ?? ""
  const messageKey = WORKTREE_MESSAGE_KEY_MAP[msg]
  if (messageKey) return tr(translator, messageKey, WORKTREE_MESSAGE_TEXT_MAP[msg] || msg)
  if (msg) return tr(translator, key, WORKTREE_ERROR_TEXT[errorName] || msg, { message: msg })
  return tr(translator, key, WORKTREE_ERROR_TEXT[errorName] || "Workspace error")
}

function extractDataMessage(error: { data?: { message?: string } }, translator?: Translator) {
  const msg = error.data?.message?.trim()
  if (msg) return msg
  return tr(translator, "error.chain.unknown", "Unknown error")
}

function isWorktreeErrorLike(error: unknown): error is WorktreeNamedErrorLike {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return typeof o.name === "string" && o.name in WORKTREE_ERROR_MAP
}

const NETWORK_ERROR_MAP: Record<string, string> = {
  "Failed to fetch": "error.network.failedToFetch",
  "NetworkError when attempting to fetch resource": "error.network.failedToFetch",
  "Load failed": "error.network.failedToFetch",
  "Network request failed": "error.network.failedToFetch",
  "Request failed with status 503": "error.network.serverUnavailable",
  "Request failed with status 502": "error.network.serverUnavailable",
  "Request failed with status 500": "error.network.serverError",
  "Request failed with status 429": "error.network.rateLimited",
  "Server timeout": "error.network.timeout",
  Timeout: "error.network.timeout",
  Aborted: "error.network.aborted",
  "Connection refused": "error.network.connectionRefused",
  ECONNREFUSED: "error.network.connectionRefused",
  "net::ERR_CONNECTION_REFUSED": "error.network.connectionRefused",
  "net::ERR_CONNECTION_CLOSED": "error.network.connectionClosed",
  "net::ERR_CONNECTION_RESET": "error.network.connectionReset",
  "net::ERR_CONNECTION_TIMED_OUT": "error.network.timeout",
  "fetch failed": "error.network.failedToFetch",
}

function parseNetworkErrorMessage(msg: string, translator?: Translator) {
  const key = NETWORK_ERROR_MAP[msg.trim()]
  if (key) return tr(translator, key, msg)
  return msg
}

export function formatServerError(error: unknown, translate?: Translator, fallback?: string) {
  if (isConfigInvalidErrorLike(error)) return parseReadableConfigInvalidError(error, translate)
  if (isProviderModelNotFoundErrorLike(error)) return parseReadableProviderModelNotFoundError(error, translate)
  if (isWorktreeErrorLike(error)) return parseWorktreeError(error, translate)
  if (error instanceof Error && error.message) return parseNetworkErrorMessage(error.message, translate)
  if (typeof error === "string" && error) return parseNetworkErrorMessage(error, translate)
  if (fallback) return fallback
  return tr(translate, "error.chain.unknown", "Unknown error")
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ConfigInvalidError" && typeof o.data === "object" && o.data !== null
}

function isProviderModelNotFoundErrorLike(error: unknown): error is ProviderModelNotFoundError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ProviderModelNotFoundError" && typeof o.data === "object" && o.data !== null
}

export function parseReadableConfigInvalidError(errorInput: ConfigInvalidError, translator?: Translator) {
  const file = errorInput.data.path && errorInput.data.path !== "config" ? errorInput.data.path : "config"
  const detail = errorInput.data.message?.trim() ?? ""
  const issues = (errorInput.data.issues ?? [])
    .map((issue) => {
      const msg = issue.message.trim()
      if (!issue.path.length) return msg
      return `${issue.path.join(".")}: ${msg}`
    })
    .filter(Boolean)
  const msg = issues.length ? issues.join("\n") : detail
  if (!msg) return tr(translator, "error.chain.configInvalid", `Config file at ${file} is invalid`, { path: file })
  return tr(translator, "error.chain.configInvalidWithMessage", `Config file at ${file} is invalid: ${msg}`, {
    path: file,
    message: msg,
  })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Model not found: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(translator, "error.chain.checkConfig", "Check your config (opencode.json) provider/model names")
  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")
    return [body, tr(translator, "error.chain.didYouMean", `Did you mean: ${suggestions}`, { suggestions }), tail].join(
      "\n",
    )
  }
  return [body, tail].join("\n")
}
