import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"

export async function git(directory: string, ...args: string[]) {
  const process = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
  if (code !== 0) throw new Error(error.trim() || `git exited ${code}`)
  return output.trim()
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
  await git(repo, "worktree", "add", "-b", `superagent/${ticket}`, directory, base)
}
