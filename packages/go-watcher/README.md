# go-watcher

Native watcher sidecar for [`packages/opencode/src/file/watcher.ts`](../opencode/src/file/watcher.ts).

On Linux worktree watches, `packages/opencode` now requires this binary and uses it as the watcher backend. The TypeScript side still owns:

- subscription timeout and cooldown
- active-directory leases
- limited-mode fallback policy
- watcher-hint driven resync
- bus event publishing
- git watcher setup

The Go sidecar owns directory registration, recursive scanning in full mode, limited watch-set replacement, and event delivery.

## Binary discovery

`packages/opencode/src/file/watcher.ts` resolves the sidecar in this order:

1. `OPENCODE_GO_WATCHER_PATH`
2. local dev binary at `packages/go-watcher/bin/opencode-watcher`
3. packaged binary at `dirname(process.execPath)/native/opencode-watcher`

If no binary is found, the Linux worktree watcher fails. There is no Bun child fallback on the current path.

## Transport

Protocol is newline-delimited JSON over stdio:

- parent writes control messages to `stdin`
- child writes protocol messages to `stdout`
- child may write human-readable logs to `stderr`

Protocol version is explicit in every message with `"v": 1`.

## Parent flow

Full mode:

1. spawn the sidecar
2. send one `start` message with `mode: "full"`
3. wait for `ready`
4. stream `event`
5. kill the process on unsubscribe or shutdown

Limited mode:

1. spawn the sidecar after full subscribe times out or fails
2. send one `start` message with `mode: "limited"` and initial `dirs`
3. wait for `ready`
4. send `sync` messages whenever watcher hints change
5. stream `event`
6. kill the process on unsubscribe or shutdown

There is no separate `stop` message.

## Messages

### `start`

Sent exactly once after spawn.

```json
{
  "v": 1,
  "type": "start",
  "root": "/abs/project/path",
  "ignore": ["**/{node_modules,.git}/**", "**/{node_modules,.git}"],
  "filter": ["**/*.log", "Thumbs.db"],
  "mode": "full",
  "dirs": []
}
```

Rules:

- `root` must be absolute.
- `ignore` is used for watcher-registration pruning.
- `filter` only suppresses emitted events.
- `mode` is `"full"` or `"limited"`. Empty mode is treated as `"full"` by the decoder.
- `dirs` matters only in limited mode.

### `sync`

Sent only after `ready`, and only for limited mode.

```json
{
  "v": 1,
  "type": "sync",
  "dirs": ["src", "src/components", "/abs/project/path/docs"]
}
```

Rules:

- relative entries are resolved against `root`
- paths outside `root` are rejected
- missing paths and non-directories are skipped
- ignored directories are skipped and counted in `ignored`
- each sync replaces the current limited watch set
- limited mode is non-recursive: the sidecar watches the listed directories themselves, not their full subtrees

### `ready`

Emitted after startup work completes.

```json
{
  "v": 1,
  "type": "ready",
  "watched": 421,
  "ignored": 37
}
```

Meaning:

- in full mode, `watched` is the number of registered directories after the initial recursive scan
- in limited mode, `watched` is the number of currently watched hint directories after the first `Sync`
- `ignored` is the number of directories skipped during that startup pass

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
- `fsnotify.Remove` and `fsnotify.Rename` both map to `unlink`
- `fsnotify.Write` and `fsnotify.Chmod` both map to `change`
- TypeScript maps these to Parcel-style `create` / `update` / `delete` before publishing `file.watcher.updated`

### `error`

Fatal startup failure:

```json
{
  "v": 1,
  "type": "error",
  "stage": "start",
  "fatal": true,
  "error": "add watch /abs/project/path/foo: no space left on device"
}
```

Non-fatal runtime error:

```json
{
  "v": 1,
  "type": "error",
  "stage": "sync",
  "fatal": false,
  "error": "watch dir escapes root: ../tmp"
}
```

Known stages in the current implementation:

- `decode`
- `start`
- `sync`
- `event`

Before `ready`, an `error` rejects startup. After `ready`, TypeScript logs the error and forwards it through the watcher callback.

## Ignore vs filter

This split is the main contract.

`ignore` applies before watcher registration:

- full mode skips ignored subtrees during `filepath.WalkDir`
- full mode never calls `Add()` on ignored directories
- later-created ignored directories are not recursively scanned
- limited mode refuses to watch ignored hint directories

`filter` applies after fs events are received:

- matching paths do not emit protocol `event` messages
- filtering does not reduce watcher count

If you need to reduce inotify pressure, change `ignore`, not `filter`.

## Current implementation shape

The sidecar is intentionally small:

- one `fsnotify.Watcher`
- one startup decoder reading NDJSON from `stdin`
- one `Matcher` for ignore
- one `Matcher` for filter
- one `dirs` map tracking active directory watches

Full mode:

- runs `Scan(root, match, add)` once at startup
- recursively registers directories
- on later directory create, runs `Scan(item, match, add)` again for that subtree

Limited mode:

- skips recursive startup scan
- applies `Sync(dirs)` at startup and on every later `sync`
- removes watches not present in the newest hint set

## Matching notes

Matching is root-relative and slash-normalized before glob evaluation.

Current matcher policy:

- preserve the ignore/filter semantics sent by TypeScript
- keep ignore strong enough to prevent unwanted watcher registration
- reject bad input rather than silently broadening watch coverage

The matcher uses `github.com/bmatcuk/doublestar/v4`. Keep call-site patterns explicit and aligned with `packages/opencode/src/file/ignore.ts`.

## Local development

Build the local sidecar with:

```bash
go build -o bin/opencode-watcher ./cmd/opencode-watcher
```

Useful verification commands:

```bash
go test ./...
```

```bash
cd ../opencode && bun typecheck
```
