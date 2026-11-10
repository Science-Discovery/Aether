import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { existsSync, realpathSync, statSync, lstatSync, readdirSync } from "node:fs"

export type Project = { directory: string; repo?: string; base?: string; initialized?: boolean }
class GitError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

export async function git(directory: string, ...args: string[]) {
  const env = { ...process.env, LC_ALL: "C" }
  // Never let an inherited alternate index/worktree redirect project operations.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"])
    delete (env as Record<string, string | undefined>)[key]
  const child = Bun.spawn(["git", "-C", directory, ...args], { env, stdout: "pipe", stderr: "pipe" })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new GitError(code, error.trim() || `git exited ${code}`)
  return output.trim()
}

/** Canonicalize existing ancestors, without silently resolving a relative path from cwd. */
export function canonical(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Project must be an absolute directory path.")
  const absolute = path.resolve(value)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = path.dirname(absolute)
  if (parent === absolute) return absolute
  return path.join(canonical(parent), path.basename(absolute))
}

export function outside(directory: string, state: string) {
  const source = canonical(directory)
  const target = canonical(state)
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  }
  if (contains(source, target) || contains(target, source))
    throw new Error("Project and coordinator state directories must not contain one another.")
}

const locks = new Map<string, Promise<unknown>>()
async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key)
  const next = (async () => { await previous?.catch(() => {}); return action() })()
  locks.set(key, next)
  try { return await next } finally { if (locks.get(key) === next) locks.delete(key) }
}

/** Resolve the live source separately from the worker's isolated Git checkout. */
export async function resolveProject(value: string, state: string, base?: string): Promise<Project> {
  const directory = canonical(value)
  outside(directory, state)
  return serial(directory, async () => {
    if (!statSync(directory).isDirectory()) throw new Error("Project is not a directory.")
    let repo: string
    let initialized = false
    try { repo = await realpath(await git(directory, "rev-parse", "--show-toplevel")) }
    catch (error) {
      if (!(error instanceof GitError) || !error.message.startsWith("fatal: not a git repository")) throw error
      // Only genuine absence permits init; unsafe ownership/corrupt Git metadata
      // and other failures must surface instead of being mistaken for a new repo.
      for (let parent = directory; ; parent = path.dirname(parent)) {
        try {
          const marker = path.join(parent, ".git")
          const meta = lstatSync(marker)
          // Git ignores empty .git directories on ancestors. Some environments
          // deliberately place these at HOME/tmp; leave them entirely alone.
          if (parent === directory || !meta.isDirectory() || readdirSync(marker).length !== 0)
            throw new Error("Existing Git metadata is invalid; refusing to initialize over it.")
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        if (path.dirname(parent) === parent) break
      }
      await git(directory, "-c", "init.templateDir=", "init")
      initialized = true
      repo = directory
    }
    outside(repo, state)
    const common = await realpath(await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    const initialize = async () => {
      try { return await git(repo, "rev-parse", "--verify", `${base ?? "HEAD"}^{commit}`) }
      catch (error) {
        if (base && base !== "HEAD") throw error
        const branch = await git(repo, "symbolic-ref", "-q", "HEAD")
        try { await git(repo, "show-ref", "--verify", "--quiet", branch); throw error }
        catch (missing) { if (!(missing instanceof GitError) || missing.code !== 1) throw missing }
        // commit-tree does not read or update the user's index. The empty tree
        // and baseline commit are metadata only; existing files stay untouched.
        const tree = await git(repo, "hash-object", "-w", "-t", "tree", "/dev/null")
        const commit = await git(repo, "-c", "user.name=Aether Super-agent", "-c", "user.email=superagent@localhost",
          "-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "Initialize empty Super-agent baseline (existing files are not committed)")
        try { await git(repo, "-c", "core.hooksPath=/dev/null", "update-ref", "HEAD", commit, "") }
        catch (conflict) {
          // Another process may have initialized the same unborn branch first.
          const current = await git(repo, "rev-parse", "--verify", "HEAD^{commit}").catch(() => undefined)
          if (!current) throw conflict
          return current
        }
        initialized = true
        return commit
      }
    }
    const revision = await serial(`git:${common}`, initialize)
    return { directory, repo, base: revision, ...(initialized ? { initialized: true } : {}) }
  })
}

// Synchronous completion of git setup, not Aether's early-returning Worktree.create.
// A worktree isolates edits; it is not an OS security sandbox.
export async function prepare(repo: string, directory: string, ticket: string, base: string) {
  if (existsSync(directory)) {
    if (await realpath(await git(directory, "rev-parse", "--show-toplevel")) !== await realpath(directory))
      throw new Error("Existing worker directory is not its own worktree.")
    if (await git(directory, "branch", "--show-current") !== `superagent/${ticket}`)
      throw new Error("Existing worker branch does not match its ticket.")
    if (await realpath(await git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")) !==
      await realpath(await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")))
      throw new Error("Worker belongs to another repository.")
    return
  }
  await mkdir(path.dirname(directory), { recursive: true })
  await git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", `superagent/${ticket}`, directory, base)
}
