import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Schedule, Semaphore, ServiceMap, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import z from "zod"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import { FileWatcher } from "@/file/watcher"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
import { Hash } from "@/util/hash"
import { Config } from "../config/config"
import { Global } from "../global"
import { Log } from "../util/log"

export namespace Snapshot {
  export const Patch = z.object({
    hash: z.string(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  export const FileDiff = z
    .object({
      file: z.string(),
      before: z.string(),
      after: z.string(),
      additions: z.number(),
      deletions: z.number(),
      status: z.enum(["added", "deleted", "modified"]).optional(),
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>

  const log = Log.create({ service: "snapshot" })
  const prune = "7.days"
  const limit = 2 * 1024 * 1024
  const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
  const cfg = ["-c", "core.autocrlf=false", ...core]
  const quote = [...cfg, "-c", "core.quotepath=false"]
  interface GitResult {
    readonly code: ChildProcessSpawner.ExitCode
    readonly text: string
    readonly stderr: string
  }

  type State = Omit<Interface, "init"> & {
    readonly warm: () => Effect.Effect<void>
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly cleanup: () => Effect.Effect<void>
    readonly track: () => Effect.Effect<string | undefined>
    readonly patch: (hash: string) => Effect.Effect<Snapshot.Patch>
    readonly restore: (snapshot: string) => Effect.Effect<void>
    readonly revert: (patches: Snapshot.Patch[]) => Effect.Effect<void>
    readonly diff: (hash: string) => Effect.Effect<string>
    readonly diffFull: (from: string, to: string) => Effect.Effect<Snapshot.FileDiff[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Snapshot") {}

  export const layer: Layer.Layer<
    Service,
    never,
    AppFileSystem.Service | ChildProcessSpawner.ChildProcessSpawner | Bus.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const bus = yield* Bus.Service
      const locks = new Map<string, Semaphore.Semaphore>()

      const lock = (key: string) => {
        const hit = locks.get(key)
        if (hit) return hit

        const next = Semaphore.makeUnsafe(1)
        locks.set(key, next)
        return next
      }

      const state = yield* InstanceState.make<State>(
        Effect.fn("Snapshot.state")(function* (ctx) {
          const state = {
            directory: ctx.directory,
            worktree: ctx.worktree,
            gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          }

          // worktree-relative paths that changed since the last index update,
          // fed by FileWatcher events (every edit tool publishes them)
          const pending = new Set<string>()
          let seeded = false
          let reconciled = 0
          let borrowed = 0
          let walkMs = 0
          const JOURNAL_MAX = 1000
          const CHUNK = 64
          const journalFile = path.join(state.gitdir, "journal.jsonl")

          const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

          const git = Effect.fnUntraced(
            function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
              const proc = ChildProcess.make("git", cmd, {
                cwd: opts?.cwd,
                env: opts?.env,
                extendEnv: true,
                stdin: opts?.stdin === undefined ? undefined : Stream.make(new TextEncoder().encode(opts.stdin)),
              })
              const handle = yield* spawner.spawn(proc)
              const [text, stderr] = yield* Effect.all(
                [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
                { concurrency: 2 },
              )
              const code = yield* handle.exitCode
              return { code, text, stderr } satisfies GitResult
            },
            Effect.scoped,
            Effect.catch((err) =>
              Effect.succeed({
                code: ChildProcessSpawner.ExitCode(1),
                text: "",
                stderr: String(err),
              }),
            ),
          )

          const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
          const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
          const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
          const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

          const enabled = Effect.fnUntraced(function* () {
            // live check: the project may gain a git repo mid-session
            if (Instance.project.vcs !== "git") return false
            return (yield* Effect.promise(() => Config.get())).snapshot !== false
          })

          const rel = (file: string) => {
            const abs = path.resolve(state.worktree, file)
            const rel = path.relative(state.worktree, abs)
            if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return
            const norm = rel.replaceAll("\\", "/")
            if (norm === ".git" || norm.startsWith(".git/")) return
            return norm
          }

          // Edits made through opencode tools publish watcher events; staging
          // them on demand keeps every track/patch/diff proportional to the
          // number of touched files instead of the size of the repository.
          // Subscribed unconditionally: the project may gain a git repo
          // mid-session (enabled() checks live), and events are cheap to
          // collect while snapshots are disabled or non-git.
          yield* bus
            .subscribe(FileWatcher.Event.Updated)
            .pipe(
              Stream.runForEach((evt) =>
                Effect.sync(() => {
                  const item = rel(evt.properties.file)
                  if (item) pending.add(item)
                }),
              ),
              Effect.forkScoped,
            )
            .pipe(Effect.ignore)

          const excludes = Effect.fnUntraced(function* () {
            const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
              cwd: state.worktree,
            })
            const file = result.text.trim()
            if (!file) return
            if (!(yield* exists(file))) return
            return file
          })

          const sync = Effect.fnUntraced(function* (list: string[] = []) {
            const file = yield* excludes()
            const ignore = path.join(state.worktree, ".gitignore")
            const target = path.join(state.gitdir, "info", "exclude")
            const text = [
              file ? (yield* read(file)).trimEnd() : "",
              (yield* read(ignore)).trimEnd(),
              ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
            ]
              .filter(Boolean)
              .join("\n")
            yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
            yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
          })

          const chunks = (list: string[]) =>
            Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))

          const ignoreCheck = Effect.fnUntraced(function* (list: string[]) {
            const out = new Set<string>()
            for (const chunk of chunks(list)) {
              const result = yield* git([...quote, ...args(["check-ignore", "-z", "--", ...chunk])], {
                cwd: state.worktree,
              })
              if (result.code === 0) {
                for (const item of result.text.split("\0")) {
                  if (item) out.add(item)
                }
              }
            }
            return out
          })

          // returns the items of every chunk that failed so callers can
          // re-queue them; a failed chunk stages NOTHING from its invocation
          const stage = Effect.fnUntraced(function* (list: string[]) {
            const failed: string[] = []
            for (const chunk of chunks(list)) {
              const result = yield* git([...cfg, ...args(["update-index", "--add", "--remove", "--", ...chunk])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                log.warn("failed to stage snapshot files", {
                  code: result.code,
                  stderr: result.stderr,
                  count: chunk.length,
                })
                failed.push(...chunk)
              }
            }
            return failed
          })

          // drain watcher events into the snapshot index
          const apply = Effect.fnUntraced(function* () {
            if (!pending.size) return []
            const list = [...pending]
            pending.clear()
            const ignored = yield* ignoreCheck(list)
            const large: string[] = []
            const out: string[] = []
            for (const item of list) {
              if (ignored.has(item)) continue
              const stat = yield* fs.stat(path.join(state.worktree, item)).pipe(Effect.catch(() => Effect.void))
              // directories cannot be staged: update-index rejects them with
              // a fatal error that aborts the whole chunk
              if (stat && stat.type === "Directory") continue
              if (stat && stat.type === "File") {
                const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                if (size > limit) {
                  large.push(item)
                  continue
                }
              }
              out.push(item)
            }
            if (large.length) yield* sync(large)
            const failed = out.length ? yield* stage(out) : []
            // failed items retry on the next track/patch instead of being lost
            if (!failed.length) return out
            for (const item of failed) pending.add(item)
            const dropped = new Set(failed)
            return out.filter((item) => !dropped.has(item))
          })

          type Entry = { hash: string; files: string[] }

          const load = Effect.fnUntraced(function* () {
            if (!(yield* exists(journalFile))) return [] as Entry[]
            const text = yield* read(journalFile)
            const out: Entry[] = []
            for (const line of text.split("\n")) {
              if (!line.trim()) continue
              try {
                const item = JSON.parse(line) as Entry
                if (item && typeof item.hash === "string" && Array.isArray(item.files)) out.push(item)
              } catch {
                // skip malformed journal lines
              }
            }
            return out
          })

          const persist = Effect.fnUntraced(function* (entry: Entry) {
            const list = yield* load()
            list.push(entry)
            const keep = list.length > JOURNAL_MAX ? list.slice(-Math.floor(JOURNAL_MAX / 2)) : list
            yield* fs
              .writeFileString(journalFile, keep.map((item) => JSON.stringify(item)).join("\n") + "\n")
              .pipe(Effect.orDie)
          })

          const tree = Effect.fnUntraced(function* () {
            const result = yield* git(args(["write-tree"]), { cwd: state.worktree })
            if (result.code !== 0) {
              log.warn("failed to write tree", { exitCode: result.code, stderr: result.stderr })
              return
            }
            return result.text.trim() || undefined
          })

          const commit = Effect.fnUntraced(function* (applied: string[]) {
            const hash = yield* tree()
            if (!hash) return
            if (applied.length) yield* persist({ hash, files: applied })
            return hash
          })

          // one-time setup: init the side gitdir, share the repository object
          // store via alternates (no full copy), seed the index from HEAD so
          // the first track is cheap, then reconcile dirty state in background.
          // Serialized under a dedicated semaphore - NOT the snapshot lock,
          // which restore/revert already hold when calling this. A failure
          // leaves `seeded` false so the next track retries.
          const seed = Effect.fnUntraced(function* () {
            if (seeded) return
            yield* lock(state.gitdir + ":seed").withPermits(1)(
              Effect.gen(function* () {
                if (seeded) return
                const existed = yield* exists(state.gitdir)
                yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
                if (!existed) {
                  yield* git(["init"], {
                    env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                  })
                  yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                  yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                  yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                  yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                  log.info("initialized")
                }

                // share objects with the repository so trees/blobs referenced by
                // HEAD need no copying into the snapshot store
                const common = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
                  cwd: state.worktree,
                })
                const dir = common.text.trim()
                if (common.code === 0 && dir) {
                  yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
                  yield* fs
                    .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), `${dir}/objects\n`)
                    .pipe(Effect.orDie)
                }

                if (!(yield* exists(path.join(state.gitdir, "index")))) {
                  // seed from the repository's own index: it carries fresh stat
                  // data and cache-tree, so write-tree stays incremental and
                  // diff-files only reports real changes. Blobs resolve through
                  // the alternates entry above.
                  const idx = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
                    cwd: state.worktree,
                  })
                  const file = idx.text.trim()
                  if (idx.code === 0 && file && (yield* exists(file))) {
                    yield* fs.copyFile(file, path.join(state.gitdir, "index")).pipe(Effect.orDie)
                    log.info("seeded", { index: file })
                  } else {
                    const head = yield* git(["rev-parse", "HEAD^{tree}"], { cwd: state.worktree })
                    const hash = head.text.trim()
                    if (head.code === 0 && hash) {
                      yield* git(args(["read-tree", hash]), { cwd: state.worktree })
                      log.info("seeded", { tree: hash })
                    }
                  }
                }
                seeded = true
              }),
            )
          })

          // the side index is seeded from the repository's own index, so it
          // references blobs that may exist only in the shared object store;
          // once they leave the main index and HEAD, gc prunes them and
          // write-tree breaks. Pack that borrowed subset into the side store
          // so snapshots stay readable. Best effort: never fail tracking.
          const borrow = Effect.fnUntraced(function* () {
            if (Date.now() - borrowed < 60_000) return
            borrowed = Date.now()
            if (!(yield* exists(path.join(state.gitdir, "index")))) return
            const [side, main, head] = yield* Effect.all(
              [
                git(args(["ls-files", "-s", "-z"]), { cwd: state.worktree }),
                git(["ls-files", "-s", "-z"], { cwd: state.worktree }),
                git(["ls-tree", "-r", "-z", "HEAD"], { cwd: state.worktree }),
              ],
              { concurrency: 3 },
            )
            const known = new Set<string>()
            for (const item of main.text.split("\0")) {
              const [mode, sha] = item.split(" ")
              if (mode === "100644" || mode === "100755" || mode === "120000") known.add(sha)
            }
            for (const item of head.text.split("\0")) {
              const [mode, kind, sha] = item.split(" ")
              if (kind === "blob") known.add(sha)
            }
            const risky = new Set<string>()
            for (const item of side.text.split("\0")) {
              const [mode, sha] = item.split(" ")
              if ((mode === "100644" || mode === "100755" || mode === "120000") && !known.has(sha)) risky.add(sha)
            }
            if (!risky.size) return
            const items = [...risky]
            const pack = yield* git(args(["pack-objects", path.join(state.gitdir, "objects", "pack", "pack")]), {
              cwd: state.worktree,
              stdin: items.join("\n") + "\n",
            })
            if (pack.code !== 0) {
              log.warn("failed to pack borrowed snapshot objects", { code: pack.code, stderr: pack.stderr })
              return
            }
            log.info("packed borrowed snapshot objects", { count: items.length })
          })

          // full refresh: catches external edits that produce no watcher
          // events. The walk runs against a copy of the index without
          // holding the lock (a huge worktree scan must not block tracks);
          // only the short apply phase is locked.
          const reconcile = Effect.fnUntraced(function* (force = false) {
            if (!(yield* enabled())) return
            if (!force && Date.now() - reconciled < 10 * 60_000) return
            reconciled = Date.now()
            const began = Date.now()
            yield* seed()
            yield* borrow()
            // refresh ignore rules BEFORE the walk so newly excluded files
            // are not listed as untracked
            yield* sync()
            const walk = path.join(state.gitdir, "walk.index")
            const index = path.join(state.gitdir, "index")
            if (!(yield* exists(index))) return
            const copied = yield* fs.copyFile(index, walk).pipe(
              Effect.map(() => true),
              Effect.catch(() => Effect.succeed(false)),
            )
            if (!copied) return
            const env = { GIT_INDEX_FILE: walk }
            const [diff, other] = yield* Effect.all(
              [
                git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                  cwd: state.worktree,
                  env,
                }),
                git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                  cwd: state.worktree,
                  env,
                }),
              ],
              { concurrency: 2 },
            )
            if (diff.code !== 0 || other.code !== 0) {
              log.warn("failed to list snapshot files", {
                diffCode: diff.code,
                otherCode: other.code,
                stderr: diff.stderr || other.stderr,
              })
              return
            }
            const all = [...new Set([...diff.text.split("\0"), ...other.text.split("\0")].filter(Boolean))]
            if (all.length) {
              yield* locked(
                Effect.gen(function* () {
                  yield* sync()
                  const large = (yield* Effect.all(
                    all.map((item) =>
                      fs
                        .stat(path.join(state.worktree, item))
                        .pipe(Effect.catch(() => Effect.void))
                        .pipe(
                          Effect.map((stat) => {
                            if (!stat || stat.type !== "File") return
                            const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                            return size > limit ? item : undefined
                          }),
                        ),
                    ),
                    { concurrency: 8 },
                  )).filter((item): item is string => Boolean(item))
                  yield* sync(large)
                  yield* stage(all.filter((item) => !large.includes(item)))
                  yield* commit(all)
                  log.info("reconciled", { count: all.length })
                }),
              )
            }
            walkMs = Date.now() - began
          })

          // Freshness policy: on normal repositories the full walk is cheap
          // (< SLOW_MS), so track/patch/diff refresh inline and external
          // edits are always captured - identical to the classic semantics.
          // On huge repositories the walk costs seconds, so refreshes run in
          // the background and snapshot freshness for external edits is
          // bounded by the reconcile interval instead.
          const SLOW_MS = 500
          const fresh = Effect.fnUntraced(function* () {
            if (walkMs > SLOW_MS) {
              yield* reconcile().pipe(Effect.forkDetach)
              return
            }
            yield* reconcile(true)
          })

          const cleanup = Effect.fnUntraced(function* () {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return
                if (!(yield* exists(state.gitdir))) return
                // the project may have been deleted entirely (e.g. e2e temp
                // projects); gc would only fail against a missing worktree
                if (!(yield* exists(state.worktree))) return
                const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.worktree })
                if (result.code !== 0) {
                  log.warn("cleanup failed", {
                    exitCode: result.code,
                    stderr: result.stderr,
                  })
                  return
                }
                log.info("cleanup", { prune })
              }),
            )
          })

          // lock discipline: seed/fresh run OUTSIDE the snapshot lock (the
          // cheap-repo reconcile awaits a walk whose apply phase takes the
          // same non-reentrant lock); only index mutations are locked.
          const track = Effect.fnUntraced(function* () {
            if (!(yield* enabled())) return
            yield* seed()
            yield* fresh()
            return yield* locked(
              Effect.gen(function* () {
                const applied = yield* apply()
                return yield* commit(applied)
              }),
            )
          })

          const filesSince = Effect.fnUntraced(function* (hash: string) {
            const journal = yield* load()
            const at = journal.findIndex((item) => item.hash === hash)
            if (at < 0) return
            const files = new Set<string>()
            for (const item of journal.slice(at + 1)) {
              for (const file of item.files) files.add(file)
            }
            return files
          })

          const patch = Effect.fnUntraced(function* (hash: string) {
            if (!(yield* enabled())) return { hash, files: [] }
            yield* seed()
            yield* fresh()
            return yield* locked(
              Effect.gen(function* () {
                const applied = yield* apply()
                if (applied.length) yield* commit(applied)
                const since = yield* filesSince(hash)
                if (since) {
                  return {
                    hash,
                    files: [...since].map((file) => path.join(state.worktree, file).replaceAll("\\", "/")),
                  }
                }
                // unknown hash (pre-upgrade session): fall back to a tree diff
                const result = yield* git(
                  [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
                  {
                    cwd: state.worktree,
                  },
                )
                if (result.code !== 0) {
                  log.warn("failed to get diff", { hash, exitCode: result.code, stderr: result.stderr })
                  return { hash, files: [] }
                }
                return {
                  hash,
                  files: result.text
                    .trim()
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean)
                    .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
                }
              }),
            )
          })

          const restore = Effect.fnUntraced(function* (snapshot: string) {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return
                yield* seed()
                log.info("restore", { commit: snapshot })
                // diff the snapshot tree against the WORKTREE directly: the
                // index may be stale (external edits without events), and
                // restore must revert what is actually on disk
                const statuses = yield* git(
                  [
                    ...quote,
                    ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", "-z", snapshot, "--", "."]),
                  ],
                  { cwd: state.worktree },
                )
                if (statuses.code !== 0) {
                  log.error("failed to restore snapshot", {
                    snapshot,
                    exitCode: statuses.code,
                    stderr: statuses.stderr,
                  })
                  return
                }
                // changes needed to go from `snapshot` to `current`:
                //   A = file only in current (delete), D = only in snapshot (checkout), M = modified (checkout)
                const back: string[] = []
                const gone: string[] = []
                const items = statuses.text.split("\0").filter(Boolean)
                for (let i = 0; i < items.length; i += 2) {
                  const code = items[i]
                  const file = items[i + 1]
                  if (!code || !file) continue
                  if (code === "A") gone.push(file)
                  else back.push(file)
                }
                const swap = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
                if (swap.code !== 0) {
                  log.error("failed to restore snapshot", {
                    snapshot,
                    exitCode: swap.code,
                    stderr: swap.stderr,
                  })
                  return
                }
                for (const chunk of chunks(back)) {
                  const result = yield* git([...core, ...args(["checkout-index", "-f", "--", ...chunk])], {
                    cwd: state.worktree,
                  })
                  if (result.code !== 0) {
                    log.error("failed to restore snapshot files", {
                      snapshot,
                      exitCode: result.code,
                      stderr: result.stderr,
                    })
                  }
                }
                for (const file of gone) yield* remove(path.join(state.worktree, file))
                for (const file of [...back, ...gone]) {
                  const item = rel(path.join(state.worktree, file))
                  if (item) pending.add(item)
                }
              }),
            )
          })

          const revert = Effect.fnUntraced(function* (patches: Snapshot.Patch[]) {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return
                yield* seed()
                const seen = new Set<string>()
                for (const item of patches) {
                  for (const file of item.files) {
                    if (seen.has(file)) continue
                    seen.add(file)
                    log.info("reverting", { file, hash: item.hash })
                    const result = yield* git([...core, ...args(["checkout", item.hash, "--", file])], {
                      cwd: state.worktree,
                    })
                    if (result.code !== 0) {
                      const relpath = path.relative(state.worktree, file)
                      const tree = yield* git([...core, ...args(["ls-tree", item.hash, "--", relpath])], {
                        cwd: state.worktree,
                      })
                      if (tree.code === 0 && tree.text.trim()) {
                        log.info("file existed in snapshot but checkout failed, keeping", { file })
                      } else {
                        log.info("file did not exist in snapshot, deleting", { file })
                        yield* remove(file)
                      }
                    }
                    const item2 = rel(file)
                    if (item2) pending.add(item2)
                  }
                }
              }),
            )
          })

          const diff = Effect.fnUntraced(function* (hash: string) {
            if (!(yield* enabled())) return ""
            yield* seed()
            yield* fresh()
            return yield* locked(
              Effect.gen(function* () {
                const applied = yield* apply()
                if (applied.length) yield* commit(applied)
                const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                  cwd: state.worktree,
                })
                if (result.code !== 0) {
                  log.warn("failed to get diff", {
                    hash,
                    exitCode: result.code,
                    stderr: result.stderr,
                  })
                  return ""
                }
                return result.text.trim()
              }),
            )
          })

          const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
            return yield* locked(
              Effect.gen(function* () {
                const result: Snapshot.FileDiff[] = []
                const status = new Map<string, "added" | "deleted" | "modified">()

                const statuses = yield* git(
                  [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                  { cwd: state.directory },
                )

                for (const line of statuses.text.trim().split("\n")) {
                  if (!line) continue
                  const [code, file] = line.split("\t")
                  if (!code || !file) continue
                  status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
                }

                const numstat = yield* git(
                  [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                  {
                    cwd: state.directory,
                  },
                )

                for (const line of numstat.text.trim().split("\n")) {
                  if (!line) continue
                  const [adds, dels, file] = line.split("\t")
                  if (!file) continue
                  const binary = adds === "-" && dels === "-"
                  const [before, after] = binary
                    ? ["", ""]
                    : yield* Effect.all(
                        [
                          git([...cfg, ...args(["show", `${from}:${file}`])]).pipe(Effect.map((item) => item.text)),
                          git([...cfg, ...args(["show", `${to}:${file}`])]).pipe(Effect.map((item) => item.text)),
                        ],
                        { concurrency: 2 },
                      )
                  const additions = binary ? 0 : parseInt(adds)
                  const deletions = binary ? 0 : parseInt(dels)
                  result.push({
                    file,
                    before,
                    after,
                    additions: Number.isFinite(additions) ? additions : 0,
                    deletions: Number.isFinite(deletions) ? deletions : 0,
                    status: status.get(file) ?? "modified",
                  })
                }

                return result
              }),
            )
          })

          // seed the gitdir, build the first tree, and measure the first full
          // walk in the background: the first track() on a huge repository is
          // then already incremental and correctly classified as slow
          const warm = Effect.fnUntraced(function* () {
            if (!(yield* enabled())) return
            yield* locked(
              Effect.gen(function* () {
                yield* seed()
                yield* tree()
              }),
            )
            yield* reconcile(true)
          })

          yield* Effect.gen(function* () {
            yield* reconcile().pipe(Effect.ignore)
            yield* cleanup().pipe(Effect.ignore)
          }).pipe(
            Effect.catchCause((cause) => {
              log.error("maintenance loop failed", { cause: Cause.pretty(cause) })
              return Effect.void
            }),
            Effect.repeat(Schedule.spaced(Duration.hours(1))),
            Effect.delay(Duration.minutes(1)),
            Effect.forkScoped,
          )

          return { cleanup, track, patch, restore, revert, diff, diffFull, warm }
        }),
      )

      return Service.of({
        init: Effect.fn("Snapshot.init")(function* () {
          yield* InstanceState.useEffect(state, (s) => s.warm())
        }),
        cleanup: Effect.fn("Snapshot.cleanup")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.cleanup())
        }),
        track: Effect.fn("Snapshot.track")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.track())
        }),
        patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
          return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
        }),
        restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
          return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
        }),
        revert: Effect.fn("Snapshot.revert")(function* (patches: Snapshot.Patch[]) {
          return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
        }),
        diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
          return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
        }),
        diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
          return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(CrossSpawnSpawner.layer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(NodeFileSystem.layer), // needed by CrossSpawnSpawner
    Layer.provide(NodePath.layer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function init() {
    return runPromise((svc) => svc.init())
  }

  export async function cleanup() {
    return runPromise((svc) => svc.cleanup())
  }

  export async function track() {
    return runPromise((svc) => svc.track())
  }

  export async function patch(hash: string) {
    return runPromise((svc) => svc.patch(hash))
  }

  export async function restore(snapshot: string) {
    return runPromise((svc) => svc.restore(snapshot))
  }

  export async function revert(patches: Patch[]) {
    return runPromise((svc) => svc.revert(patches))
  }

  export async function diff(hash: string) {
    return runPromise((svc) => svc.diff(hash))
  }

  export async function diffFull(from: string, to: string) {
    return runPromise((svc) => svc.diffFull(from, to))
  }
}
