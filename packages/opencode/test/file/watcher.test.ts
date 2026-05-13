import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Effect, Layer, ManagedRuntime, Option } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { FileWatcher } from "../../src/file/watcher"
import { ActiveDirectory } from "../../src/project/active-directory"
import { Instance } from "../../src/project/instance"

// Native @parcel/watcher bindings aren't reliably available in CI (missing on Linux, flaky on Windows)
const describeWatcher = FileWatcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const watcherConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)
const owner = "watcher-test"

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }
/** Run `body` with a live FileWatcher service. */
function withWatcher<E>(directory: string, body: Effect.Effect<void, E>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const layer: Layer.Layer<FileWatcher.Service, never, never> = FileWatcher.layer.pipe(
        Layer.provide(watcherConfigLayer),
      )
      const rt = ManagedRuntime.make(layer)
      try {
        ActiveDirectory.set(owner, directory)
        await rt.runPromise(FileWatcher.Service.use((s) => s.init()))
        await Effect.runPromise(ready(directory))
        await Effect.runPromise(body)
      } finally {
        ActiveDirectory.clear()
        await rt.dispose()
      }
    },
  })
}

function withWatcherInit<E>(directory: string, body: Effect.Effect<void, E>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const layer: Layer.Layer<FileWatcher.Service, never, never> = FileWatcher.layer.pipe(
        Layer.provide(watcherConfigLayer),
      )
      const rt = ManagedRuntime.make(layer)
      try {
        await rt.runPromise(FileWatcher.Service.use((s) => s.init()))
        await Effect.runPromise(body)
      } finally {
        ActiveDirectory.clear()
        await rt.dispose()
      }
    },
  })
}

async function startWatcher(directory: string) {
  const layer: Layer.Layer<FileWatcher.Service, never, never> = FileWatcher.layer.pipe(Layer.provide(watcherConfigLayer))
  const rt = ManagedRuntime.make(layer)
  await Instance.provide({
    directory,
    fn: async () => {
      await rt.runPromise(FileWatcher.Service.use((s) => s.init()))
    },
  })
  return async () => {
    await rt.dispose()
  }
}

function listen(directory: string, check: (evt: WatcherEvent) => boolean, hit: (evt: WatcherEvent) => void) {
  let done = false

  const unsub = Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
    if (done) return
    if (!check(evt.properties)) return
    hit(evt.properties)
  })

  return () => {
    if (done) return
    done = true
    unsub()
  }
}

function wait(directory: string, check: (evt: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<WatcherEvent>()
    const cleanup = yield* Effect.sync(() => {
      let off = () => {}
      off = listen(directory, check, (evt) => {
        off()
        Deferred.doneUnsafe(deferred, Effect.succeed(evt))
      })
      return off
    })
    return { cleanup, deferred }
  })
}

function nextUpdate<E>(
  directory: string,
  check: (evt: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  timeout = 15_000,
) {
  return Effect.acquireUseRelease(
    wait(directory, check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        return yield* Deferred.await(deferred).pipe(Effect.timeout(timeout))
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

/** Effect that asserts no matching event arrives within `ms`. */
function noUpdate<E>(
  directory: string,
  check: (evt: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  ms = 500,
) {
  return Effect.acquireUseRelease(
    wait(directory, check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption(`${ms} millis`))).toEqual(Option.none())
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

async function eventually(
  directory: string,
  check: (evt: WatcherEvent) => boolean,
  write: (attempt: number) => Promise<void>,
  opts?: { attempts?: number; pause?: number; name?: string },
) {
  const attempts = opts?.attempts ?? 60
  const pause = opts?.pause ?? 250
  const name = opts?.name ?? directory

  return await new Promise<WatcherEvent>((resolve, reject) => {
    let done = false
    const off = listen(directory, check, (evt) => {
      if (done) return
      done = true
      off()
      resolve(evt)
    })

    void (async () => {
      for (let i = 0; i < attempts; i += 1) {
        if (done) return
        await write(i)
        await new Promise((resolve) => setTimeout(resolve, pause))
      }
      if (done) return
      done = true
      off()
      reject(new Error("timed out waiting for watcher update"))
    })().catch((error) => {
      if (done) return
      done = true
      off()
      reject(error)
    })
  })
}

function ready(directory: string) {
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  const head = path.join(directory, ".git", "HEAD")

  return Effect.gen(function* () {
    yield* nextUpdate(
      directory,
      (evt) => evt.file === file && evt.event === "add",
      Effect.promise(() => fs.writeFile(file, "ready")),
    ).pipe(Effect.ensuring(Effect.promise(() => fs.rm(file, { force: true }).catch(() => undefined))), Effect.asVoid)

    const git = yield* Effect.promise(() =>
      fs
        .stat(head)
        .then(() => true)
        .catch(() => false),
    )
    if (!git) return

    const branch = `watch-${Math.random().toString(36).slice(2)}`
    const hash = yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(directory).quiet().text())
    yield* nextUpdate(
      directory,
      (evt) => evt.file === head && evt.event !== "unlink",
      Effect.promise(async () => {
        await fs.writeFile(path.join(directory, ".git", "refs", "heads", branch), hash.trim() + "\n")
        await fs.writeFile(head, `ref: refs/heads/${branch}\n`)
      }),
    ).pipe(Effect.asVoid)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWatcher("FileWatcher", () => {
  afterEach(async () => {
    ActiveDirectory.clear()
    await Instance.disposeAll()
  })

  test(
    "publishes root create, update, and delete events",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const file = path.join(tmp.path, "watch.txt")
      const dir = tmp.path
      const cases = [
        { event: "add" as const, trigger: Effect.promise(() => fs.writeFile(file, "a")) },
        { event: "change" as const, trigger: Effect.promise(() => fs.writeFile(file, "b")) },
        { event: "unlink" as const, trigger: Effect.promise(() => fs.unlink(file)) },
      ]

      await withWatcher(
        dir,
        Effect.forEach(cases, ({ event, trigger }) =>
          nextUpdate(dir, (evt) => evt.file === file && evt.event === event, trigger).pipe(
            Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event }))),
          ),
        ),
      )
    },
    { timeout: 30_000 },
  )

  test(
    "watches non-git roots",
    async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "plain.txt")
      const dir = tmp.path

      await withWatcher(
        dir,
        nextUpdate(
          dir,
          (e) => e.file === file && e.event === "add",
          Effect.promise(() => fs.writeFile(file, "plain")),
        ).pipe(Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event: "add" })))),
      )
    },
    { timeout: 30_000 },
  )

  test(
    "only watches the active directory once one is selected",
    async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "active.txt")

      await withWatcherInit(
        tmp.path,
        Effect.promise(async () => {
          await Effect.runPromise(
            noUpdate(
              tmp.path,
              (evt) => evt.file === file,
              Effect.promise(() => fs.writeFile(file, "idle")),
            ),
          )
          ActiveDirectory.set(owner, tmp.path)
          const evt = await eventually(
            tmp.path,
            (event) => event.file === file && event.event !== "unlink",
            (attempt) => fs.writeFile(file, `live-${attempt}`),
            { attempts: 60, pause: 250 },
          )
          expect(evt.file).toBe(file)
          expect(["add", "change"]).toContain(evt.event)
        }),
      )
    },
    { timeout: 30_000 },
  )

  test(
    "watches multiple leased directories concurrently",
    async () => {
      await using a = await tmpdir()
      await using b = await tmpdir()
      const afile = path.join(a.path, "a.txt")
      const bfile = path.join(b.path, "b.txt")

      const stopA = await startWatcher(a.path)
      const stopB = await startWatcher(b.path)

      try {
        ActiveDirectory.set("a", a.path)
        ActiveDirectory.set("b", b.path)

        const [aevt, bevt] = await Promise.all([
          Instance.provide({
            directory: a.path,
            fn: () =>
              eventually(
                a.path,
                (evt) => evt.file === afile && evt.event !== "unlink",
                (attempt) => fs.writeFile(afile, `a-${attempt}`),
                { name: "a" },
              ),
          }),
          Instance.provide({
            directory: b.path,
            fn: () =>
              eventually(
                b.path,
                (evt) => evt.file === bfile && evt.event !== "unlink",
                (attempt) => fs.writeFile(bfile, `b-${attempt}`),
                { name: "b" },
              ),
          }),
        ])

        expect(aevt.file).toBe(afile)
        expect(bevt.file).toBe(bfile)
        expect(["add", "change"]).toContain(aevt.event)
        expect(["add", "change"]).toContain(bevt.event)
      } finally {
        ActiveDirectory.clear()
        await stopB()
        await stopA()
      }
    },
    { timeout: 30_000 },
  )

  test(
    "cleanup stops publishing events",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const file = path.join(tmp.path, "after-dispose.txt")

      // Start and immediately stop the watcher (withWatcher disposes on exit)
      await withWatcher(tmp.path, Effect.void)

      // Now write a file — no watcher should be listening
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          Effect.runPromise(
            noUpdate(
              tmp.path,
              (e) => e.file === file,
              Effect.promise(() => fs.writeFile(file, "gone")),
            ),
          ),
      })
    },
    { timeout: 30_000 },
  )

  test(
    "ignores .git/index changes",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const gitIndex = path.join(tmp.path, ".git", "index")
      const edit = path.join(tmp.path, "tracked.txt")

      await withWatcher(
        tmp.path,
        noUpdate(
          tmp.path,
          (e) => e.file === gitIndex,
          Effect.promise(async () => {
            await fs.writeFile(edit, "a")
            await $`git add .`.cwd(tmp.path).quiet().nothrow()
          }),
        ),
      )
    },
    { timeout: 30_000 },
  )

  test(
    "publishes .git/HEAD events",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const head = path.join(tmp.path, ".git", "HEAD")
      const branch = `watch-${Math.random().toString(36).slice(2)}`
      await $`git branch ${branch}`.cwd(tmp.path).quiet()

      await withWatcher(
        tmp.path,
        nextUpdate(
          tmp.path,
          (evt) => evt.file === head && evt.event !== "unlink",
          Effect.promise(() => fs.writeFile(head, `ref: refs/heads/${branch}\n`)),
        ).pipe(
          Effect.tap((evt) =>
            Effect.sync(() => {
              expect(evt.file).toBe(head)
              expect(["add", "change"]).toContain(evt.event)
            }),
          ),
        ),
      )
    },
    { timeout: 30_000 },
  )
})
