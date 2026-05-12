# go-watcher

Native watcher sidecar for `packages/opencode/src/file/watcher.ts`.

This package replaces the Bun child on the Linux worktree watch path with a smaller standalone binary. The TypeScript side keeps ownership of:

- active-directory gating
- startup timeout and cooldown
- bus event publishing
- git watcher setup
- fallback and degradation policy

The Go sidecar only owns recursive directory watching and event delivery.

## Current status

The current implementation is wired into `packages/opencode/src/file/watcher.ts`.

Linux worktree watcher startup now does this:

1. try `OPENCODE_GO_WATCHER_PATH`
2. in local dev, try `packages/go-watcher/bin/opencode-watcher`
3. in packaged builds, try `dirname(process.execPath)/native/opencode-watcher`
4. if no Go binary is found, fall back to the older Bun `watcher-child.ts` path

This means local development can opt into the Go watcher immediately without changing the rest of the watcher lifecycle.

## Goals

- Keep the parent/child protocol minimal and stable.
- Make Linux worktree watch startup cheaper than a Bun child.
- Support real subtree ignore semantics.
- Guarantee that ignored directories are not registered as watchers.
- Keep shutdown simple: parent kills child, child exits fast.

## Non-goals

- No shared long-lived daemon in v1.
- No config parsing in Go.
- No active-directory logic in Go.
- No git-specific watch path in Go.
- No "best effort" ignore that still registers ignored subtrees.

## Protocol v1

Transport:

- parent writes one JSON line to child `stdin`
- child writes JSON lines to `stdout`
- child writes human-readable logs to `stderr`
- protocol version is explicit

Parent startup flow:

1. spawn binary
2. write one `start` message
3. wait for `ready`
4. stream `event`
5. kill process on timeout, unsubscribe, or parent shutdown

Child shutdown flow:

- `SIGTERM` or `SIGINT` triggers cleanup and exit
- no separate `stop` message in v1

## Input

The parent sends exactly one message:

```json
{
  "v": 1,
  "type": "start",
  "root": "/abs/project/path",
  "ignore": [
    "node_modules",
    "**/node_modules",
    "**/node_modules/**",
    ".git",
    "**/.git",
    "**/.git/**"
  ],
  "filter": [
    "Thumbs.db",
    "*.log",
    "logs/**"
  ]
}
```

Rules:

- `root` must be absolute.
- `ignore` is interpreted relative to `root` and is used for pre-registration subtree pruning.
- `filter` is interpreted relative to `root` for path globs, and patterns without `/` are matched against the basename before events are emitted.
- glob syntax is handled by `github.com/bmatcuk/doublestar/v4`.
- watcher ignores should use explicit patterns such as `**/{node_modules,dist,.git}` when they mean "match this directory name at any depth".
- the child may reject unsupported patterns instead of silently weakening semantics.

### Important note about brace globs

The current repo-level `FileIgnore.WATCH` value is a brace glob like:

```txt
**/{node_modules,bower_components,...,.gradle}
```

The Go matcher passes this through to `doublestar`, so the TypeScript launcher can send the watcher ignore pattern unchanged.

## Output

### `ready`

Emitted only after the initial crawl and watcher registration are complete.

```json
{
  "v": 1,
  "type": "ready",
  "watched": 421,
  "ignored": 37
}
```

Meaning:

- `watched` is the real number of registered directories
- `ignored` is the number of directories skipped during initial crawl

### `event`

```json
{
  "v": 1,
  "type": "event",
  "path": "/abs/project/path/src/file.ts",
  "event": "change"
}
```

Rules:

- `path` is absolute
- `event` is one of `add`, `change`, `unlink`
- parent keeps the existing TS mapping to bus events

### `error`

Fatal startup or runtime errors:

```json
{
  "v": 1,
  "type": "error",
  "stage": "start",
  "fatal": true,
  "error": "failed to add watcher for /abs/project/path/foo: no space left on device"
}
```

Non-fatal runtime warnings are allowed too:

```json
{
  "v": 1,
  "type": "error",
  "stage": "event",
  "fatal": false,
  "error": "rename event dropped for transient path /abs/project/path/tmp"
}
```

Stage values in v1:

- `decode`
- `start`
- `watch`
- `event`
- `shutdown`

## Required ignore semantics

This is the most important contract in v1.

`ignore` must apply before recursive watcher registration, not only after events are received.

If a directory is ignored:

- do not call `Add` on that directory
- do not recurse into that directory during the initial crawl
- do not add watchers for later children created under that ignored subtree
- do not emit events for paths under that subtree

Examples:

- if `root/node_modules` matches ignore, `root/node_modules` itself must not be watched
- if `root/packages/a/node_modules` matches ignore, that subtree must also be skipped before registration
- if an ignored directory is created later, the parent directory may emit one create event, but the child must not descend and register watchers beneath it

This is stricter than "filter matching events". Filtering after registration does not solve watch-count pressure.

## Actual implementation

The current watcher is a thin recursive layer built on top of `github.com/fsnotify/fsnotify`.

It does not use a library-managed recursive watcher.

Current shape:

- one `fsnotify.Watcher`
- one explicit initial crawl with `filepath.WalkDir`
- one matcher compiled from the incoming ignore list
- one `dirs` map for registered directories
- on directory create: `os.Stat()` the path, and if it is a directory, re-run the same recursive `Scan()` path before adding deeper watchers

This keeps the crucial control point in our code:

- ignore is checked before `Add()`
- ignored subtrees are skipped with `filepath.SkipDir`
- later-created ignored directories are also denied recursive registration

This is why the current implementation chose `fsnotify` instead of direct `inotify` syscalls or a higher-level recursive wrapper.

## Matching rules

The parent TS side already expands ignore rules for watcher setup. Go should preserve those semantics rather than inventing a new ignore language.

Current matcher behavior:

- root-relative paths are slash-normalized before matching
- plain directory-name forms still have dedicated fast-path handling
- generic glob matching uses `github.com/bmatcuk/doublestar/v4`
- matching is case-sensitive on Linux
- paths outside `root` are rejected during normalization

Matcher policy:

1. preserve the current watcher ignore forms used by this repo
2. keep ignored-subtree pruning correct
3. reject ambiguous or unsupported input rather than silently broadening watcher coverage

Do not silently broaden watcher coverage.

## Local development

Build the local binary:

```bash
cd /mnt/data/Documents/opencode/packages/go-watcher
mkdir -p bin
go build -o bin/opencode-watcher ./cmd/opencode-watcher
```

After that, the normal app development flow will pick it up automatically.

You can also override the binary path explicitly:

```bash
OPENCODE_GO_WATCHER_PATH=/abs/path/to/opencode-watcher
```

If the binary is missing, TypeScript falls back to the Bun child implementation.

## Verification

Current useful checks:

```bash
cd /mnt/data/Documents/opencode/packages/go-watcher
go test ./...
```

```bash
cd /mnt/data/Documents/opencode/packages/opencode
bun test test/file/watcher.test.ts
```

The watcher test suite passing locally is the main confirmation that the Go sidecar and TS bridge are working together on the dev path.
