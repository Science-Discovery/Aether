import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { PDFDocument } from "pdf-lib"
import { Global } from "@/global"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Instance } from "@/project/instance"
import { LatexSchema } from "./schema"
import { LatexProject } from "./project"
import { LatexCompiler } from "./compiler"
import { PdfAnnotations } from "../pdf-annotations"
import { Lock } from "../util/lock"

export { LatexSchema } from "./schema"

export namespace Latex {
  const record = z.object({
    owner: z.string(),
    key: z.string(),
    binding: LatexSchema.Binding,
    latest: z.string().optional(),
    lastSuccessful: z.string().optional(),
  })
  type Record = z.infer<typeof record>
  const stored = z.object({
    owner: z.string(),
    key: z.string(),
    build: LatexSchema.Build,
    pdfHash: z.string().optional(),
    pdfSize: z.number().optional(),
  })
  type Stored = z.infer<typeof stored>
  const review = z.object({
    owner: z.string(),
    key: z.string(),
    revision: z.string(),
    data: PdfAnnotations.File,
    references: z.string().array(),
    leases: z.record(z.string().uuid(), z.number()),
  })
  type Job = {
    root: LatexProject.Root
    data: Stored
    abort: AbortController
    done: Promise<void>
    settled: boolean
    blocked: boolean
    previous?: string
  }
  type State = {
    jobs: Map<string, Job>
    locks: Set<string>
    checked: Map<string, { revision: string; checkedAt: number }>
    refresh: Map<string, Promise<LatexSchema.Project>>
    closed: boolean
    abort: AbortController
  }
  const active = new Set<string>()
  export class Service extends ServiceMap.Service<Service, { state: () => Effect.Effect<State> }>()(
    "@opencode/Latex",
  ) {}
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const cache = yield* InstanceState.make(
        Effect.fn("Latex.state")(function* () {
          const state: State = {
            jobs: new Map(),
            locks: new Set(),
            checked: new Map(),
            refresh: new Map(),
            closed: false,
            abort: new AbortController(),
          }
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              state.closed = true
              state.abort.abort()
              for (const job of state.jobs.values()) job.abort.abort()
              await Promise.allSettled([...state.jobs.values()].map((job) => job.done))
              await Promise.allSettled([...state.refresh.values()])
            }),
          )
          return state
        }),
      )
      return Service.of({ state: () => InstanceState.get(cache) })
    }),
  ).pipe(Layer.orDie)
  const runtime = makeRuntime(Service, layer)
  const state = () => runtime.runPromise((service) => service.state())
  const home = (root: LatexProject.Root) => path.join(Global.Path.data, "latex", root.owner)
  const project = (root: LatexProject.Root) => path.join(home(root), "projects", `${root.key}.json`)
  const document = (root: LatexProject.Root, id: string) => path.join(home(root), "builds", `${id}.json`)
  const artifact = (root: LatexProject.Root, id: string) => path.join(home(root), "artifacts", `${id}.pdf`)
  const annotation = (root: LatexProject.Root, id: string) => path.join(home(root), "annotations", `${id}.json`)
  const mutex = (root: LatexProject.Root) => `latex-artifacts:${root.owner}`
  const identifier = z.string().uuid()
  const waiting = (build: LatexSchema.Build) => build.state === "preparing" || build.state === "running"

  async function write(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async function binding(root: LatexProject.Root) {
    const value = await Bun.file(project(root))
      .json()
      .catch(() => undefined)
    if (value === undefined) return
    const parsed = record.safeParse(value)
    if (!parsed.success || parsed.data.owner !== root.owner || parsed.data.key !== root.key)
      throw new LatexSchema.Error(409, "The saved LaTeX project metadata is invalid.")
    return parsed.data
  }

  async function loaded(root: LatexProject.Root, id: string, current: State) {
    if (!identifier.safeParse(id).success) throw new LatexSchema.Error(400, "Invalid LaTeX build identifier.")
    const job = current.jobs.get(id)
    if (job && job.data.owner === root.owner)
      return job.settled
        ? job.data
        : {
            ...job.data,
            build: {
              ...job.data.build,
              state: job.data.build.startedAt ? ("running" as const) : ("preparing" as const),
              pdf: false,
              completedAt: undefined,
            },
          }
    const parsed = stored.safeParse(
      await Bun.file(document(root, id))
        .json()
        .catch(() => undefined),
    )
    if (!parsed.success || parsed.data.owner !== root.owner || parsed.data.build.id !== id)
      throw new LatexSchema.Error(404, "The LaTeX build does not belong to this workspace.")
    if (waiting(parsed.data.build)) {
      parsed.data.build.state = "failed"
      parsed.data.build.error = "The application stopped before this LaTeX build completed. Compile again."
      parsed.data.build.completedAt = Date.now()
      parsed.data.build.pdf = false
    }
    return parsed.data
  }

  async function view(root: LatexProject.Root, current: State, file?: string): Promise<LatexSchema.Project> {
    const saved = await binding(root)
    const latest = saved?.latest ? (await loaded(root, saved.latest, current).catch(() => undefined))?.build : undefined
    const pending = saved?.lastSuccessful ? current.jobs.get(saved.lastSuccessful) : undefined
    const published = pending && !pending.settled ? pending.previous : saved?.lastSuccessful
    const success = published ? (await loaded(root, published, current).catch(() => undefined))?.build : undefined
    const checked = current.checked.get(root.key)
    const freshness: LatexSchema.Freshness = checked
      ? {
          state:
            success &&
            success.sourceRevision === checked.revision &&
            success.bindingRevision === saved?.binding.revision
              ? "fresh"
              : "stale",
          checkedAt: checked.checkedAt,
          sourceRevision: checked.revision,
        }
      : { state: "unknown" }
    if (saved)
      return {
        root: root.root,
        main: saved.binding.main,
        binding: saved.binding,
        candidates: [],
        reason: "binding",
        freshness,
        latest,
        lastSuccessful: success,
        editors: [],
      }
    const selected = file ? path.resolve(root.workspace, file) : undefined
    const magic =
      selected && LatexProject.contains(root.path, selected) && path.extname(selected).toLowerCase() === ".tex"
        ? await LatexProject.magic(root, path.relative(root.path, selected))
        : undefined
    if (magic) return { root: root.root, main: magic, candidates: [magic], reason: "magic", freshness, editors: [] }
    const candidates = await LatexProject.candidates(root)
    return {
      root: root.root,
      main: candidates.length === 1 ? candidates[0] : undefined,
      candidates,
      reason: candidates.length === 1 ? "single" : candidates.length ? "ambiguous" : "missing",
      freshness,
      editors: [],
    }
  }

  export async function status() {
    return LatexCompiler.status((await Config.getGlobal()).latex ?? {})
  }

  export async function inspect(input: { root?: string; path?: string }) {
    const current = await state()
    const base = await LatexProject.root(input.root ?? ".")
    if (input.path && !LatexProject.contains(base.workspace, path.resolve(base.workspace, input.path)))
      throw new LatexSchema.Error(400, "The document escapes this workspace.")
    // Bindings override discovery. Afterwards inspect only nearby directory
    // entries, so unrelated workspace files never enter the initial scan.
    if (!input.root && input.path) {
      const full = await LatexProject.file(base, path.relative(base.path, path.resolve(base.workspace, input.path)))
      let directory = path.dirname(full)
      while (LatexProject.contains(base.workspace, directory)) {
        const root = await LatexProject.root(directory)
        if (await binding(root)) return view(root, current, input.path)
        if (directory === base.workspace) break
        directory = path.dirname(directory)
      }
      const magic =
        path.extname(full).toLowerCase() === ".tex"
          ? await LatexProject.magic(base, path.relative(base.path, full))
          : undefined
      if (magic) {
        const main = path.resolve(base.path, magic)
        let common = path.dirname(main)
        while (!LatexProject.contains(common, full)) common = path.dirname(common)
        const root = await LatexProject.root(common)
        return view(root, current, input.path)
      }
      directory = path.dirname(full)
      while (LatexProject.contains(base.workspace, directory)) {
        const root = await LatexProject.root(directory)
        const candidates = await LatexProject.candidates(root, true)
        if (candidates.length)
          return {
            root: root.root,
            main: candidates.length === 1 ? candidates[0] : undefined,
            candidates,
            reason: candidates.length === 1 ? ("single" as const) : ("ambiguous" as const),
            freshness: { state: "unknown" as const },
            editors: [],
          }
        if (directory === base.workspace) break
        directory = path.dirname(directory)
      }
      const root = await LatexProject.root(path.dirname(full))
      return {
        root: root.root,
        candidates: [],
        reason: "missing" as const,
        freshness: { state: "unknown" as const },
        editors: [],
      }
    }
    return view(base, current, input.path)
  }

  export async function bind(input: z.infer<typeof LatexSchema.Selection>) {
    const root = await LatexProject.root(input.root)
    const current = await state()
    if (current.closed) throw new LatexSchema.Error(409, "This workspace is closing.")
    if (current.locks.has(root.key) || active.has(root.path))
      throw new LatexSchema.Error(409, "This LaTeX project is busy. Wait or cancel its build first.")
    current.locks.add(root.key)
    try {
      const saved = await binding(root)
      if (saved && saved.binding.revision !== input.expectedRevision)
        throw new LatexSchema.Error(409, "The LaTeX binding changed. Refresh before changing it.")
      if (!saved && input.expectedRevision) throw new LatexSchema.Error(409, "The LaTeX binding no longer exists.")
      const main = await LatexProject.main(root, input.main)
      const next: Record = {
        owner: root.owner,
        key: root.key,
        ...saved,
        binding: {
          root: root.root,
          main,
          driver: input.driver,
          program: input.program,
          revision: crypto.randomUUID(),
          updatedAt: Date.now(),
        },
      }
      await write(project(root), next)
      return view(root, current)
    } finally {
      current.locks.delete(root.key)
    }
  }

  export async function refresh(input: z.infer<typeof LatexSchema.Refresh>) {
    const root = await LatexProject.root(input.root)
    const current = await state()
    const key = `${root.key}:${JSON.stringify([...input.editors].sort())}`
    const previous = current.refresh.get(key)
    if (previous) return previous
    const pending = (async () => {
      const result = await LatexProject.scan(root, { editors: input.editors, signal: current.abort.signal })
      current.checked.set(root.key, { revision: result.manifest.revision, checkedAt: Date.now() })
      return { ...(await view(root, current)), editors: result.editors }
    })()
    current.refresh.set(key, pending)
    try {
      return await pending
    } finally {
      current.refresh.delete(key)
    }
  }

  export async function start(input: z.infer<typeof LatexSchema.Start>) {
    const root = await LatexProject.root(input.root)
    const current = await state()
    if (current.closed) throw new LatexSchema.Error(409, "This workspace is closing.")
    if (current.locks.has(root.key) || active.has(root.path))
      throw new LatexSchema.Error(409, "A LaTeX build is already running for this project.")
    if (active.size >= 2)
      throw new LatexSchema.Error(409, "Two LaTeX builds are already running. Wait for one to finish.")
    current.locks.add(root.key)
    active.add(root.path)
    try {
      const saved = await binding(root)
      if (!saved || saved.binding.revision !== input.bindingRevision)
        throw new LatexSchema.Error(409, "Select or refresh the main document before compiling.")
      await LatexProject.main(root, saved.binding.main)
      const id = crypto.randomUUID()
      const data: Stored = {
        owner: root.owner,
        key: root.key,
        build: {
          id,
          root: root.root,
          main: saved.binding.main,
          bindingRevision: saved.binding.revision,
          state: "preparing",
          createdAt: Date.now(),
          diagnostics: [],
          log: "",
          truncated: false,
          pdf: false,
        },
      }
      const job: Job = {
        root,
        data,
        abort: new AbortController(),
        done: Promise.resolve(),
        settled: false,
        blocked: false,
        previous: saved.lastSuccessful,
      }
      await write(document(root, id), data)
      await write(project(root), { ...saved, latest: id })
      if (current.closed) throw new LatexSchema.Error(409, "This workspace is closing.")
      current.checked.delete(root.key)
      current.jobs.set(id, job)
      job.done = execute(job, saved.binding, input, current).finally(async () => {
        job.settled = true
        if (!job.blocked) {
          active.delete(root.path)
          current.locks.delete(root.key)
        }
        for (const [id, item] of [...current.jobs]) {
          if (current.jobs.size <= 20) break
          if (item.settled && !item.blocked) current.jobs.delete(id)
        }
        if (!job.blocked) await cleanup({ root: root.root }).catch(() => undefined)
      })
      return structuredClone(data.build)
    } catch (error) {
      active.delete(root.path)
      current.locks.delete(root.key)
      throw error
    }
  }

  async function execute(
    job: Job,
    bound: LatexSchema.Binding,
    input: z.infer<typeof LatexSchema.Start>,
    current: State,
  ) {
    const build = job.data.build
    const base = path.resolve(Global.Path.cache, "latex", "jobs")
    const scratch = path.join(base, build.id)
    const source = path.join(scratch, "source")
    const output = path.join(scratch, "output")
    try {
      await fs.mkdir(source, { recursive: true })
      await fs.mkdir(output)
      const snapshot = await LatexProject.scan(job.root, { destination: source, signal: job.abort.signal })
      build.sourceRevision = snapshot.manifest.revision
      if (input.sourceRevision && input.sourceRevision !== build.sourceRevision)
        throw new LatexSchema.Error(409, "Saved source files changed before compilation. Refresh and try again.")
      await write(path.join(home(job.root), "manifests", `${build.id}.json`), {
        owner: job.root.owner,
        key: job.root.key,
        bindingRevision: bound.revision,
        ...snapshot.manifest,
      })
      const tool = await LatexCompiler.select(
        bound,
        await LatexProject.head(path.join(source, bound.main)),
        (await Config.getGlobal()).latex ?? {},
      )
      // TeX's included chapter auxiliary files require matching output folders.
      for (const item of snapshot.manifest.files) {
        const rel = path.relative(path.dirname(bound.main), path.dirname(item.path))
        const target = path.resolve(output, rel)
        if (LatexProject.contains(output, target)) await fs.mkdir(target, { recursive: true })
      }
      job.abort.signal.throwIfAborted()
      build.state = "running"
      build.driver = tool.driver
      build.program = tool.program
      build.startedAt = Date.now()
      await write(document(job.root, build.id), job.data)
      const result = await LatexCompiler.compile({
        root: job.root,
        binding: bound,
        tool,
        source,
        files: snapshot.manifest.files.map((file) => file.path),
        output,
        downloads: input.allowDownloads,
        signal: job.abort.signal,
        update: (log, truncated) => {
          build.log = log
          build.truncated = truncated
        },
      })
      build.log = result.log
      build.truncated = result.truncated
      build.diagnostics = result.diagnostics
      job.abort.signal.throwIfAborted()
      if (result.code !== 0 || result.error || result.diagnostics.some((item) => item.severity === "error"))
        throw new Error(result.error ?? "LaTeX compilation failed. See the compiler log and diagnostics.")
      const stat = await fs.lstat(result.pdf).catch(() => undefined)
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 5 || stat.size > 100 * 1024 * 1024)
        throw new Error("The compiler did not produce a supported PDF (maximum 100 MiB).")
      const bytes = await fs.readFile(result.pdf)
      if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("The compiler output is not a PDF.")
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false }).catch(() => undefined)
      if (!pdf || !pdf.getPageCount()) throw new Error("The compiler output is not a readable PDF.")
      job.abort.signal.throwIfAborted()
      const saved = await binding(job.root)
      if (!saved || saved.binding.revision !== bound.revision || saved.latest !== build.id)
        throw new Error("The main document changed while compiling. This result was not published.")
      await fs.mkdir(path.dirname(artifact(job.root, build.id)), { recursive: true })
      await fs.writeFile(artifact(job.root, build.id), bytes, { flag: "wx", mode: 0o600 })
      job.abort.signal.throwIfAborted()
      job.data.pdfHash = LatexProject.hash(bytes)
      job.data.pdfSize = bytes.length
      const checked = await LatexProject.scan(job.root, { signal: job.abort.signal }).catch(() => undefined)
      job.abort.signal.throwIfAborted()
      if (checked) current.checked.set(job.root.key, { revision: checked.manifest.revision, checkedAt: Date.now() })
      else current.checked.delete(job.root.key)
      build.state = "succeeded"
      build.pdf = true
      build.completedAt = Date.now()
      await write(document(job.root, build.id), job.data)
      await write(project(job.root), { ...saved, lastSuccessful: build.id })
    } catch (error) {
      job.blocked = error instanceof LatexCompiler.StopError
      build.state = job.abort.signal.aborted && !job.blocked ? "cancelled" : "failed"
      build.pdf = false
      build.error =
        job.abort.signal.aborted && !job.blocked
          ? "LaTeX compilation cancelled."
          : error instanceof Error
            ? error.message
            : "LaTeX compilation failed."
      build.completedAt = Date.now()
      if (!build.diagnostics.some((item) => item.severity === "error"))
        build.diagnostics.push({ severity: "error", message: build.error })
      await fs.rm(artifact(job.root, build.id), { force: true }).catch(() => undefined)
      await write(document(job.root, build.id), job.data).catch(() => undefined)
    } finally {
      // Only our fixed UUID child of the dedicated jobs directory is removed.
      if (!job.blocked && path.dirname(scratch) === base && identifier.safeParse(path.basename(scratch)).success)
        await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  export async function get(id: string) {
    const root = await LatexProject.root()
    return structuredClone((await loaded(root, id, await state())).build)
  }

  export async function cancel(id: string) {
    const current = await state()
    const root = await LatexProject.root()
    await loaded(root, id, current)
    const job = current.jobs.get(id)
    if (job && !job.settled) {
      job.abort.abort()
      await job.done
    }
    return get(id)
  }

  async function published(root: LatexProject.Root, id: string, current: State) {
    const data = await loaded(root, id, current)
    if (data.build.state !== "succeeded" || !data.build.pdf || !data.pdfHash || !data.pdfSize)
      throw new LatexSchema.Error(404, "This build has no successfully published PDF.")
    const file = artifact(root, id)
    const stat = await fs.lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== data.pdfSize)
      throw new LatexSchema.Error(404, "The compiled PDF is unavailable.")
    const bytes = await fs.readFile(file)
    if (LatexProject.hash(bytes) !== data.pdfHash)
      throw new LatexSchema.Error(409, "The compiled PDF changed after publication.")
    return { bytes, hash: data.pdfHash, data }
  }

  export async function pdf(id: string) {
    const root = await LatexProject.root()
    using lock = await Lock.read(mutex(root))
    const result = await published(root, id, await state())
    return { bytes: result.bytes, hash: result.hash }
  }

  async function notes(root: LatexProject.Root, data: Stored) {
    const file = annotation(root, data.build.id)
    const value: unknown = await Bun.file(file)
      .json()
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        throw new LatexSchema.Error(409, "The saved build annotations cannot be read.")
      })
    const source = { path: `latex-build:${data.build.id}`, fingerprint: data.pdfHash! }
    if (value === undefined)
      return {
        owner: data.owner,
        key: data.key,
        revision: "0",
        data: { version: "1.2" as const, source, annotations: [] as PdfAnnotations.Item[] },
        references: [] as string[],
        leases: {} as { [token: string]: number },
      }
    const parsed = review.safeParse(value)
    if (
      !parsed.success ||
      parsed.data.owner !== data.owner ||
      parsed.data.key !== data.key ||
      parsed.data.data.source.path !== source.path ||
      parsed.data.data.source.fingerprint !== source.fingerprint
    )
      throw new LatexSchema.Error(409, "The saved build annotations do not match this PDF.")
    return parsed.data
  }

  async function records(root: LatexProject.Root, current: State) {
    const files = await fs.readdir(path.join(home(root), "builds")).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as string[]
      throw err
    })
    const rows = await Promise.all(
      files
        .filter((file) => file.endsWith(".json") && identifier.safeParse(file.slice(0, -5)).success)
        .map(async (file) => {
          const parsed = stored.safeParse(
            await Bun.file(path.join(home(root), "builds", file))
              .json()
              .catch(() => undefined),
          )
          if (
            !parsed.success ||
            parsed.data.owner !== root.owner ||
            parsed.data.key !== root.key ||
            parsed.data.build.id !== file.slice(0, -5)
          )
            return
          const data = parsed.data
          const active = current.jobs.get(data.build.id)
          return { data, active: !!active && (!active.settled || active.blocked) }
        }),
    )
    return rows
      .filter((row) => row !== undefined)
      .sort((a, b) => b.data.build.createdAt - a.data.build.createdAt || b.data.build.id.localeCompare(a.data.build.id))
  }

  async function versions(root: LatexProject.Root, current: State) {
    const rows = await records(root, current)
    return Promise.all(
      rows
        .filter(({ data, active }) => !active && data.build.state === "succeeded" && data.build.pdf && data.pdfHash)
        .map(async ({ data }) => {
          const value = await notes(root, data)
          return {
            build: data.build,
            pdfHash: data.pdfHash!,
            annotationCount: value.data.annotations.length,
            referenced: value.references.length > 0,
            viewing: Object.values(value.leases).some((until) => until > Date.now()),
          }
        }),
    )
  }

  export async function list(input: { root: string }) {
    const root = await LatexProject.root(input.root)
    using lock = await Lock.read(mutex(root))
    return versions(root, await state())
  }

  export async function annotations(id: string) {
    const root = await LatexProject.root()
    using lock = await Lock.read(mutex(root))
    const result = await published(root, id, await state())
    const value = await notes(root, result.data)
    return { status: "ready" as const, data: value.data, revision: value.revision }
  }

  export async function annotate(id: string, input: { data: PdfAnnotations.File; revision: string }) {
    const root = await LatexProject.root()
    using lock = await Lock.write(mutex(root))
    const result = await published(root, id, await state())
    const value = await notes(root, result.data)
    if (input.revision !== value.revision)
      throw new LatexSchema.Error(409, "Annotations changed. Reload before saving.")
    const data = PdfAnnotations.File.parse(input.data)
    if (data.source.path !== value.data.source.path || data.source.fingerprint !== result.hash)
      throw new LatexSchema.Error(409, "These annotations belong to a different PDF build.")
    const next = { ...value, data, revision: crypto.randomUUID() }
    await write(annotation(root, id), next)
    return { status: "ready" as const, data: next.data, revision: next.revision }
  }

  export async function exportAnnotations(id: string) {
    const root = await LatexProject.root()
    using lock = await Lock.read(mutex(root))
    const result = await published(root, id, await state())
    return PdfAnnotations.render(result.bytes, (await notes(root, result.data)).data.annotations)
  }

  export async function lease(id: string, token?: string) {
    const root = await LatexProject.root()
    using lock = await Lock.write(mutex(root))
    const data = (await published(root, id, await state())).data
    const value = await notes(root, data)
    const key = token ? identifier.parse(token) : crypto.randomUUID()
    const expiresAt = Date.now() + 90_000
    const leases = Object.fromEntries(Object.entries(value.leases).filter(([, until]) => until > Date.now()))
    if (!leases[key] && Object.keys(leases).length >= 64)
      throw new LatexSchema.Error(409, "Too many active viewers for this PDF build.")
    await write(annotation(root, id), { ...value, leases: { ...leases, [key]: expiresAt } })
    return { token: key, expiresAt }
  }

  export async function release(id: string, token: string) {
    const root = await LatexProject.root()
    using lock = await Lock.write(mutex(root))
    const value = await notes(root, (await published(root, id, await state())).data)
    const leases = Object.fromEntries(
      Object.entries(value.leases).filter(([key, until]) => key !== token && until > Date.now()),
    )
    await write(annotation(root, id), { ...value, leases })
    return true
  }

  export async function reference(id: string, reference: string) {
    const root = await LatexProject.root()
    using lock = await Lock.write(mutex(root))
    const value = await notes(root, (await published(root, id, await state())).data)
    if (value.references.includes(reference)) return true
    await write(annotation(root, id), { ...value, references: [...value.references, reference] })
    return true
  }

  export async function cleanup(input: { root: string }) {
    const root = await LatexProject.root(input.root)
    const current = await state()
    using lock = await Lock.write(mutex(root))
    const saved = await binding(root)
    const rows = await records(root, current)
    const all = await versions(root, current)
    const ordinary = all.filter((row) => !row.annotationCount && !row.referenced && !row.viewing)
    const keep = new Set([saved?.latest, saved?.lastSuccessful, ...ordinary.slice(0, 3).map((row) => row.build.id)])
    const expired = new Set(ordinary.filter((row) => !keep.has(row.build.id)).map((row) => row.build.id))
    for (const row of rows
      .filter(({ data, active }) => !active && ["failed", "cancelled"].includes(data.build.state))
      .slice(20)) {
      if (!keep.has(row.data.build.id)) expired.add(row.data.build.id)
    }
    const removed: string[] = []
    for (const id of expired) {
      // All targets are fixed UUID children of this workspace's artifact store.
      await fs.rm(artifact(root, id), { force: true })
      await fs.rm(path.join(home(root), "manifests", `${id}.json`), { force: true })
      await fs.rm(annotation(root, id), { force: true })
      await fs.rm(document(root, id), { force: true })
      current.jobs.delete(id)
      removed.push(id)
    }
    return { removed, versions: all.filter((row) => !expired.has(row.build.id)) }
  }
}
