import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Effect, Layer, ServiceMap, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { makeRuntime } from "@/effect/run-service"
import * as Graph from "./git-graph"

export namespace Git {
  const cfg = [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.longpaths=true",
    ...(process.platform !== "win32" ? ["-c", "core.symlinks=true"] : []),
    "-c",
    "core.quotepath=false",
  ]

  const statusCfg = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.longpaths=true",
    ...(process.platform !== "win32" ? ["-c", "core.symlinks=true"] : []),
    "-c",
    "core.quotepath=false",
  ]

  const out = (result: { text(): string }) => result.text().trim()
  const nuls = (text: string) => text.split("\0").filter(Boolean)
  const fail = (err: unknown) =>
    ({
      exitCode: 1,
      text: () => "",
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
    }) satisfies Result

  export type Kind = "added" | "deleted" | "modified"

  export type Base = {
    readonly name: string
    readonly ref: string
  }

  export type Item = {
    readonly file: string
    readonly code: string
    readonly status: Kind
  }

  export type Stat = {
    readonly file: string
    readonly additions: number
    readonly deletions: number
  }

  export type LogItem = {
    readonly hash: string
    readonly parents: readonly string[]
    readonly author: string
    readonly email: string
    readonly date: number
    readonly message: string
  }

  export type Ref = {
    readonly name: string
    readonly hash: string
    readonly type: string
  }

  export type FileChange = {
    readonly status: string
    readonly file: string
    readonly oldFilePath?: string
    readonly additions: number | null
    readonly deletions: number | null
  }

  export type CommitDetail = {
    readonly hash: string
    readonly parents: readonly string[]
    readonly author: string
    readonly authorEmail: string
    readonly authorDate: number
    readonly committer: string
    readonly committerEmail: string
    readonly committerDate: number
    readonly body: string
    readonly files: readonly FileChange[]
  }

  export interface Result {
    readonly exitCode: number
    readonly text: () => string
    readonly stdout: Buffer
    readonly stderr: Buffer
  }

  export interface Options {
    readonly cwd: string
    readonly env?: Record<string, string>
    readonly config?: string[]
  }

  export interface Interface {
    readonly run: (args: string[], opts: Options) => Effect.Effect<Result>
    readonly branch: (cwd: string) => Effect.Effect<string | undefined>
    readonly prefix: (cwd: string) => Effect.Effect<string>
    readonly defaultBranch: (cwd: string) => Effect.Effect<Base | undefined>
    readonly hasHead: (cwd: string) => Effect.Effect<boolean>
    readonly mergeBase: (cwd: string, base: string, head?: string) => Effect.Effect<string | undefined>
    readonly show: (cwd: string, ref: string, file: string, prefix?: string) => Effect.Effect<string>
    readonly status: (cwd: string) => Effect.Effect<Item[]>
    readonly diff: (cwd: string, ref: string) => Effect.Effect<Item[]>
    readonly stats: (cwd: string, ref: string) => Effect.Effect<Stat[]>
    readonly log: (
      cwd: string,
      opts?: { max?: number; branch?: string; skip?: number },
    ) => Effect.Effect<readonly LogItem[]>
    readonly remotes: (cwd: string) => Effect.Effect<readonly string[]>
    readonly refs: (cwd: string, ...prefixes: string[]) => Effect.Effect<readonly Ref[]>
    readonly graphRefs: (cwd: string) => Effect.Effect<Graph.Refs>
    readonly commitDetails: (cwd: string, hash: string) => Effect.Effect<CommitDetail>
    readonly fileContent: (cwd: string, hash: string, path: string) => Effect.Effect<string>
  }

  const kind = (code: string): Kind => {
    if (code === "??") return "added"
    if (code.includes("U")) return "modified"
    if (code.includes("A") && !code.includes("D")) return "added"
    if (code.includes("D") && !code.includes("A")) return "deleted"
    return "modified"
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Git") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const run = Effect.fn("Git.run")(
        function* (args: string[], opts: Options) {
          const gitArgs = [...(opts.config ?? cfg), ...args]
          const proc = ChildProcess.make("git", gitArgs, {
            cwd: opts.cwd,
            env: opts.env,
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          return {
            exitCode: yield* handle.exitCode,
            text: () => stdout,
            stdout: Buffer.from(stdout),
            stderr: Buffer.from(stderr),
          } satisfies Result
        },
        Effect.scoped,
        Effect.catch((err) => Effect.succeed(fail(err))),
      )

      const text = Effect.fn("Git.text")(function* (args: string[], opts: Options) {
        return (yield* run(args, opts)).text()
      })

      const lines = Effect.fn("Git.lines")(function* (args: string[], opts: Options) {
        return (yield* text(args, opts))
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean)
      })

      const headRefs = Effect.fnUntraced(function* (cwd: string) {
        return yield* lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
      })

      const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
        const result = yield* run(["config", "init.defaultBranch"], { cwd })
        const name = out(result)
        if (!name || !list.includes(name)) return
        return { name, ref: name } satisfies Base
      })

      const primary = Effect.fnUntraced(function* (cwd: string) {
        const list = yield* lines(["remote"], { cwd })
        if (list.includes("origin")) return "origin"
        if (list.length === 1) return list[0]
        if (list.includes("upstream")) return "upstream"
        return list[0]
      })

      const branch = Effect.fn("Git.branch")(function* (cwd: string) {
        const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
        if (result.exitCode !== 0) return
        const text = out(result)
        return text || undefined
      })

      const prefix = Effect.fn("Git.prefix")(function* (cwd: string) {
        const result = yield* run(["rev-parse", "--show-prefix"], { cwd })
        if (result.exitCode !== 0) return ""
        return out(result)
      })

      const defaultBranch = Effect.fn("Git.defaultBranch")(function* (cwd: string) {
        const remote = yield* primary(cwd)
        if (remote) {
          const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
          if (head.exitCode === 0) {
            const ref = out(head).replace(/^refs\/remotes\//, "")
            const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
            if (name) return { name, ref } satisfies Base
          }
        }

        const list = yield* headRefs(cwd)
        const next = yield* configured(cwd, list)
        if (next) return next
        if (list.includes("main")) return { name: "main", ref: "main" } satisfies Base
        if (list.includes("master")) return { name: "master", ref: "master" } satisfies Base
        const head = yield* branch(cwd)
        if (head && list.includes(head)) return { name: head, ref: head } satisfies Base
      })

      const hasHead = Effect.fn("Git.hasHead")(function* (cwd: string) {
        const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
        return result.exitCode === 0
      })

      const mergeBase = Effect.fn("Git.mergeBase")(function* (cwd: string, base: string, head = "HEAD") {
        const result = yield* run(["merge-base", base, head], { cwd })
        if (result.exitCode !== 0) return
        const text = out(result)
        return text || undefined
      })

      const show = Effect.fn("Git.show")(function* (cwd: string, ref: string, file: string, prefix = "") {
        const target = prefix ? `${prefix}${file}` : file
        const result = yield* run(["show", `${ref}:${target}`], { cwd })
        if (result.exitCode !== 0) return ""
        if (result.stdout.includes(0)) return ""
        return result.text()
      })

      const status = Effect.fn("Git.status")(function* (cwd: string) {
        return nuls(
          yield* text(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
            cwd,
            config: statusCfg,
          }),
        ).flatMap((item) => {
          const file = item.slice(3)
          if (!file) return []
          const code = item.slice(0, 2)
          return [{ file, code, status: kind(code) } satisfies Item]
        })
      })

      const diff = Effect.fn("Git.diff")(function* (cwd: string, ref: string) {
        const list = nuls(
          yield* text(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], { cwd }),
        )
        return list.flatMap((code, idx) => {
          if (idx % 2 !== 0) return []
          const file = list[idx + 1]
          if (!code || !file) return []
          return [{ file, code, status: kind(code) } satisfies Item]
        })
      })

      const stats = Effect.fn("Git.stats")(function* (cwd: string, ref: string) {
        return nuls(
          yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], { cwd }),
        ).flatMap((item) => {
          const a = item.indexOf("\t")
          const b = item.indexOf("\t", a + 1)
          if (a === -1 || b === -1) return []
          const file = item.slice(b + 1)
          if (!file) return []
          const adds = item.slice(0, a)
          const dels = item.slice(a + 1, b)
          const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
          const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
          return [
            {
              file,
              additions: Number.isFinite(additions) ? additions : 0,
              deletions: Number.isFinite(deletions) ? deletions : 0,
            } satisfies Stat,
          ]
        })
      })

      const log = Effect.fn("Git.log")(function* (
        cwd: string,
        opts?: { max?: number; branch?: string; skip?: number },
      ) {
        const max = opts?.max ?? 300
        const sep = "\x1F"
        const args = ["log", `--format=%H${sep}%P${sep}%an${sep}%ae${sep}%at${sep}%s`, "--max-count=" + String(max)]
        if (opts?.skip) args.push("--skip=" + String(opts.skip))
        if (opts?.branch && opts.branch !== "all") {
          args.push(opts.branch)
        } else {
          args.push("--all")
        }
        args.push("--date-order")
        return (yield* lines(args, { cwd })).map((line) => {
          const [hash, parents, author, email, date, ...rest] = line.split(sep)
          return {
            hash,
            parents: parents ? parents.split(" ").filter(Boolean) : [],
            author,
            email,
            date: parseInt(date, 10),
            message: rest.join(sep),
          } satisfies LogItem
        })
      })

      const commitDetails = Effect.fn("Git.commitDetails")(function* (cwd: string, hash: string) {
        const sep = "\x1F"
        const meta = yield* text(
          ["log", "-1", `--format=%H${sep}%P${sep}%an${sep}%ae${sep}%at${sep}%cn${sep}%ce${sep}%ct${sep}%B`, hash],
          { cwd },
        )

        const parts = meta.split(sep)
        const parents = parts[1] ? parts[1].split(" ").filter(Boolean) : []
        const body = parts.slice(9).join(sep).trim()
        const from = parents.length > 0 ? `${hash}^` : hash
        const [rawNameStatus, rawNumstat] = yield* Effect.all(
          parents.length > 0
            ? [
                text(["diff", "--name-status", "--find-renames", "--diff-filter=AMDR", "-z", from, hash], { cwd }),
                text(["diff", "--numstat", "--find-renames", "--diff-filter=AMDR", "-z", from, hash], { cwd }),
              ]
            : [
                text(
                  ["diff-tree", "--name-status", "-r", "--root", "--find-renames", "--diff-filter=AMDR", "-z", hash],
                  {
                    cwd,
                  },
                ),
                text(["diff-tree", "--numstat", "-r", "--root", "--find-renames", "--diff-filter=AMDR", "-z", hash], {
                  cwd,
                }),
              ],
          { concurrency: 2 },
        )

        const nameStatus = nuls(rawNameStatus)
        if (parents.length === 0) nameStatus.shift()

        const numstat = nuls(rawNumstat)
        if (parents.length === 0) numstat.shift()

        const statMap = new Map<string, { additions: number | null; deletions: number | null }>()
        const statOldMap = new Map<string, { additions: number | null; deletions: number | null }>()
        let si = 0
        while (si < numstat.length) {
          const entry = numstat[si]
          const a = entry.indexOf("\t")
          const b = entry.indexOf("\t", a + 1)
          if (a === -1 || b === -1) {
            si++
            continue
          }
          const adds = entry.slice(0, a)
          const dels = entry.slice(a + 1, b)
          const pathField = entry.slice(b + 1)
          const additions: number | null = adds === "-" ? null : Number.parseInt(adds || "0", 10)
          const deletions: number | null = dels === "-" ? null : Number.parseInt(dels || "0", 10)
          if (pathField === "") {
            const oldFile = numstat[si + 1]
            const file = numstat[si + 2]
            if (!oldFile || !file) break
            statMap.set(file, { additions, deletions })
            statOldMap.set(oldFile, { additions, deletions })
            si += 3
          } else {
            statMap.set(pathField, { additions, deletions })
            si += 1
          }
        }

        const files: FileChange[] = []
        let i = 0
        while (i < nameStatus.length) {
          const status = nameStatus[i]
          if (!status) break
          if (status[0] === "R") {
            const oldFilePath = nameStatus[i + 1]
            const file = nameStatus[i + 2]
            if (!oldFilePath || !file) break
            const counts = statMap.get(file) ?? statOldMap.get(oldFilePath)
            files.push({
              status: status[0],
              file,
              oldFilePath,
              additions: counts?.additions ?? null,
              deletions: counts?.deletions ?? null,
            })
            i += 3
          } else {
            const file = nameStatus[i + 1]
            if (!file) break
            const counts = statMap.get(file)
            files.push({
              status: status[0],
              file,
              additions: counts?.additions ?? null,
              deletions: counts?.deletions ?? null,
            })
            i += 2
          }
        }

        return {
          hash: parts[0],
          parents,
          author: parts[2],
          authorEmail: parts[3],
          authorDate: parseInt(parts[4], 10),
          committer: parts[5],
          committerEmail: parts[6],
          committerDate: parseInt(parts[7], 10),
          body,
          files,
        } satisfies CommitDetail
      })

      const remotes = Effect.fn("Git.remotes")(function* (cwd: string) {
        return yield* lines(["remote"], { cwd })
      })

      const fileContent = Effect.fn("Git.fileContent")(function* (cwd: string, hash: string, path: string) {
        const result = yield* run(["show", `${hash}:${path}`], { cwd })
        if (result.exitCode !== 0) return ""
        if (result.stdout.includes(0)) return ""
        return result.text()
      })

      const refs = Effect.fn("Git.refs")(function* (cwd: string, ...prefixes: string[]) {
        const list = prefixes.length > 0 ? prefixes : ["refs/heads/", "refs/tags/", "refs/remotes/"]
        const sep = "\x1F"
        return (yield* lines(
          ["for-each-ref", `--format=%(refname:short)${sep}%(objectname)${sep}%(objecttype)`, ...list],
          { cwd },
        )).map((line) => {
          const idx = line.indexOf(sep)
          const idx2 = line.indexOf(sep, idx + 1)
          const name = line.slice(0, idx)
          const hash = line.slice(idx + 1, idx2)
          const type = line.slice(idx2 + 1)
          return { name, hash, type } satisfies Ref
        })
      })

      const graphRefs = Effect.fn("Git.graphRefs")(function* (cwd: string) {
        return Graph.parseRefs(yield* text(["show-ref", "-d", "--head"], { cwd }))
      })

      return Service.of({
        run,
        branch,
        prefix,
        defaultBranch,
        hasHead,
        mergeBase,
        show,
        status,
        diff,
        stats,
        log,
        remotes,
        refs,
        graphRefs,
        commitDetails,
        fileContent,
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(CrossSpawnSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export function run(args: string[], opts: Options) {
    return runPromise((git) => git.run(args, opts))
  }

  export function branch(cwd: string) {
    return runPromise((git) => git.branch(cwd))
  }

  export function prefix(cwd: string) {
    return runPromise((git) => git.prefix(cwd))
  }

  export function defaultBranch(cwd: string) {
    return runPromise((git) => git.defaultBranch(cwd))
  }

  export function hasHead(cwd: string) {
    return runPromise((git) => git.hasHead(cwd))
  }

  export function mergeBase(cwd: string, base: string, head?: string) {
    return runPromise((git) => git.mergeBase(cwd, base, head))
  }

  export function show(cwd: string, ref: string, file: string, prefix?: string) {
    return runPromise((git) => git.show(cwd, ref, file, prefix))
  }

  export function status(cwd: string) {
    return runPromise((git) => git.status(cwd))
  }

  export function diff(cwd: string, ref: string) {
    return runPromise((git) => git.diff(cwd, ref))
  }

  export function stats(cwd: string, ref: string) {
    return runPromise((git) => git.stats(cwd, ref))
  }

  export function log(cwd: string, opts?: { max?: number; branch?: string; skip?: number }) {
    return runPromise((git) => git.log(cwd, opts))
  }

  export function remotes(cwd: string) {
    return runPromise((git) => git.remotes(cwd))
  }

  export function refs(cwd: string, ...prefixes: string[]) {
    return runPromise((git) => git.refs(cwd, ...prefixes))
  }

  export function graphRefs(cwd: string) {
    return runPromise((git) => git.graphRefs(cwd))
  }

  export function commitDetails(cwd: string, hash: string) {
    return runPromise((git) => git.commitDetails(cwd, hash))
  }

  export function fileContent(cwd: string, hash: string, path: string) {
    return runPromise((git) => git.fileContent(cwd, hash, path))
  }
}
