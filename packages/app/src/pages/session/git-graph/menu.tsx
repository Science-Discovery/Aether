import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import type { CommitLogItem } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { DialogSelect } from "@/components/dialog-select"
import { DialogAddTag } from "@/components/git-graph/dialog-add-tag"
import { DialogCherryPick } from "@/components/git-graph/dialog-cherry-pick"
import { DialogCreateBranch } from "@/components/git-graph/dialog-create-branch"
import { DialogMerge } from "@/components/git-graph/dialog-merge"
import { DialogRebase } from "@/components/git-graph/dialog-rebase"
import { canDropCommit } from "./model"
import type { Ref } from "./refs"

type Target =
  | {
      kind: "commit"
      hash: string
      x: number
      y: number
    }
  | {
      kind: "ref"
      hash: string
      ref: Ref
      x: number
      y: number
    }

type Data = {
  commits: CommitLogItem[]
  head: string | null
  branch: string | null
  branches: string[]
  tags: string[]
  remotes: string[]
}

type Cmd = {
  args: string[]
  title: string
}

type Snap = {
  target: Target
  data: Data
  alwaysCheckout: boolean
  onAlwaysCheckout: (value: boolean) => void
  onRun: (cmd: Cmd) => void
}

type Parent = {
  hash: string
  message: string
  index: number
}

const short = (hash: string) => hash.slice(0, 7)

const branch = (ref: Ref) => (ref.kind === "remote" && ref.remote ? ref.name.slice(ref.remote.length + 1) : ref.name)

function MenuItem(props: { disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      class="block w-full px-2 py-1 text-left text-xs text-text-base hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:bg-transparent"
      disabled={props.disabled}
      onClick={() => {
        if (props.disabled) return
        props.onClick()
      }}
    >
      {props.children}
    </button>
  )
}

function Sep() {
  return <div class="my-1 h-px bg-border-weaker-base" />
}

function Confirm(props: {
  title: string
  body: string
  action: string
  danger?: boolean
  onAction: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog title={props.title} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">{props.body}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              dialog.close()
              props.onAction()
            }}
          >
            {props.action}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function CheckoutDialog(props: { hash: string; always: boolean; onAlways: (value: boolean) => void; onAction: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [always, setAlways] = createSignal(props.always)

  return (
    <Dialog title="Checkout Commit" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to checkout commit <b>{short(props.hash)}</b>? This will result in a 'detached HEAD'
          state.
        </p>
        <Checkbox checked={always()} onChange={setAlways}>
          Always Accept
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              dialog.close()
              props.onAlways(always())
              props.onAction()
            }}
          >
            Yes, checkout
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function RenameDialog(props: { name: string; branches: string[]; onAction: (name: string) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal(props.name)

  return (
    <Dialog title="Rename Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Enter the new name for branch <b>{props.name}</b>:
        </p>
        <TextField label="Name" value={name()} onChange={setName} />
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            disabled={!name().trim() || name().trim() === props.name || props.branches.includes(name().trim())}
            onClick={() => {
              dialog.close()
              props.onAction(name().trim())
            }}
          >
            Rename Branch
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function DeleteBranchDialog(props: {
  name: string
  current: boolean
  remotes: string[]
  onAction: (opts: { force: boolean; remotes: string[] }) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [force, setForce] = createSignal(false)
  const [remote, setRemote] = createSignal(false)

  return (
    <Dialog title="Delete Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to delete the branch <b>{props.name}</b>?
        </p>
        <Checkbox checked={force()} onChange={setForce}>
          Force Delete
        </Checkbox>
        <Show when={props.remotes.length > 0}>
          <Checkbox
            checked={remote()}
            onChange={setRemote}
            description={`This branch is on the remote${props.remotes.length > 1 ? "s" : ""}: ${props.remotes.join(", ")}`}
          >
            Delete this branch on the remote{props.remotes.length > 1 ? "s" : ""}
          </Checkbox>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            disabled={props.current}
            onClick={() => {
              dialog.close()
              props.onAction({ force: force(), remotes: remote() ? props.remotes : [] })
            }}
          >
            Yes, delete
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function PushBranchDialog(props: {
  name: string
  remotes: string[]
  onAction: (opts: { remotes: string[]; upstream: boolean; mode: "normal" | "force-with-lease" | "force" }) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [remotes, setRemotes] = createSignal(props.remotes.length === 1 ? props.remotes : [props.remotes[0]!].filter(Boolean))
  const [upstream, setUpstream] = createSignal(true)
  const [mode, setMode] = createSignal<"normal" | "force-with-lease" | "force">("normal")
  const toggle = (remote: string, value: boolean) => {
    setRemotes(value ? [...remotes(), remote] : remotes().filter((item) => item !== remote))
  }

  return (
    <Dialog title="Push Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to push the branch <b>{props.name}</b>
          {props.remotes.length === 1 ? (
            <>
              {" "}
              to the remote <b>{props.remotes[0]}</b>?
            </>
          ) : (
            "?"
          )}
        </p>
        <div class="flex flex-col gap-2">
          <Show when={props.remotes.length > 1}>
            <For each={props.remotes}>
              {(remote) => (
                <Checkbox checked={remotes().includes(remote)} onChange={(value) => toggle(remote, value)}>
                  {remote}
                </Checkbox>
              )}
            </For>
          </Show>
          <Checkbox checked={upstream()} onChange={setUpstream}>
            Set Upstream
          </Checkbox>
          <Checkbox checked={mode() === "normal"} onChange={(value) => value && setMode("normal")}>
            Normal
          </Checkbox>
          <Checkbox checked={mode() === "force-with-lease"} onChange={(value) => value && setMode("force-with-lease")}>
            Force With Lease
          </Checkbox>
          <Checkbox checked={mode() === "force"} onChange={(value) => value && setMode("force")}>
            Force
          </Checkbox>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            disabled={remotes().length === 0}
            onClick={() => {
              dialog.close()
              props.onAction({ remotes: remotes(), upstream: upstream(), mode: mode() })
            }}
          >
            Yes, push
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function RemoteCheckoutDialog(props: {
  remote: string
  name: string
  branches: string[]
  onAction: (opts: { name: string; existing: boolean }) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal(props.name)
  const exists = () => props.branches.includes(name().trim())

  return (
    <Dialog title="Checkout Remote Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Enter the name of the new branch you would like to create when checking out <b>{props.remote}</b>:
        </p>
        <TextField label="Name" value={name()} onChange={setName} />
        <Show when={exists()}>
          <p class="text-sm text-text-weaker">
            The name <b>{name().trim()}</b> is already used by another branch:
          </p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Show
            when={exists()}
            fallback={
              <Button
                disabled={!name().trim()}
                onClick={() => {
                  dialog.close()
                  props.onAction({ name: name().trim(), existing: false })
                }}
              >
                Checkout Branch
              </Button>
            }
          >
            <Button variant="ghost" onClick={() => setName("")}>
              Choose another branch name
            </Button>
            <Button
              disabled={!name().trim()}
              onClick={() => {
                dialog.close()
                props.onAction({ name: name().trim(), existing: true })
              }}
            >
              Checkout the existing branch & pull changes
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

function FetchDialog(props: { remote: string; name: string; onAction: (force: boolean) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [force, setForce] = createSignal(false)

  return (
    <Dialog title="Fetch Into Local Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to fetch the remote branch <b>{props.remote}</b> into the local branch{" "}
          <b>{props.name}</b>?
        </p>
        <Checkbox checked={force()} onChange={setForce} description="Force the local branch to be reset to this remote branch.">
          Force Fetch
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              dialog.close()
              props.onAction(force())
            }}
          >
            Yes, fetch
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function PullDialog(props: {
  remote: string
  name: string
  branch: string | null
  full: string
  onAction: (opts: { noFastForward: boolean; squash: boolean }) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [noFastForward, setNoFastForward] = createSignal(false)
  const [squash, setSquash] = createSignal(false)

  return (
    <Dialog title="Pull Branch" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to pull the remote branch <b>{props.full}</b> into{" "}
          {props.branch ? (
            <>
              <b>{props.branch}</b> (the current branch)
            </>
          ) : (
            "the current branch"
          )}
          ? If a merge is required:
        </p>
        <Checkbox checked={noFastForward()} onChange={setNoFastForward}>
          Create a new commit even if fast-forward is possible
        </Checkbox>
        <Checkbox
          checked={squash()}
          onChange={setSquash}
          description="Create a single commit on the current branch whose effect is the same as merging this remote branch."
        >
          Squash
        </Checkbox>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              dialog.close()
              props.onAction({ noFastForward: noFastForward(), squash: squash() })
            }}
          >
            Yes, pull
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function DeleteTagDialog(props: { name: string; remotes: string[]; onAction: (remote: string | null) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [remote, setRemote] = createSignal<string | null>(null)

  return (
    <Dialog title="Delete Tag" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to delete the tag <b>{props.name}</b>?
        </p>
        <Show when={props.remotes.length > 0}>
          <div class="flex flex-col gap-2">
            <p class="text-xs text-text-weaker">
              {props.remotes.length === 1 ? "Also delete on remote" : "Do you also want to delete the tag on a remote:"}
            </p>
            <For each={props.remotes}>
              {(item) => (
                <Checkbox checked={remote() === item} onChange={(value) => setRemote(value ? item : null)}>
                  {item}
                </Checkbox>
              )}
            </For>
          </div>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              dialog.close()
              props.onAction(remote())
            }}
          >
            Yes, delete
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function PushTagDialog(props: { name: string; remotes: string[]; onAction: (remotes: string[]) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [remotes, setRemotes] = createSignal(props.remotes.length === 1 ? props.remotes : [])

  const toggle = (remote: string, value: boolean) => {
    setRemotes(value ? [...remotes(), remote] : remotes().filter((item) => item !== remote))
  }

  return (
    <Dialog title="Push Tag" fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-4">
        <p class="text-sm text-text-base">
          Are you sure you want to push the tag <b>{props.name}</b>
          {props.remotes.length === 1 ? (
            <>
              {" "}
              to the remote <b>{props.remotes[0]}</b>?
            </>
          ) : (
            "? Select the remote(s) to push the tag to:"
          )}
        </p>
        <For each={props.remotes}>
          {(remote) => (
            <Checkbox checked={remotes().includes(remote)} onChange={(value) => toggle(remote, value)}>
              {remote}
            </Checkbox>
          )}
        </For>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            disabled={remotes().length === 0}
            onClick={() => {
              dialog.close()
              props.onAction(remotes())
            }}
          >
            Yes, push
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function GitGraphMenu(props: {
  target: Target
  data: Data
  alwaysCheckout: boolean
  onAlwaysCheckout: (value: boolean) => void
  onClose: () => void
  onRun: (cmd: Cmd) => void
  onShow: (node: () => JSX.Element) => void
}) {
  const language = useLanguage()
  const [pos, setPos] = createSignal({ x: props.target.x, y: props.target.y, ready: false })
  let box: HTMLDivElement | undefined

  createEffect(() => {
    const x = props.target.x
    const y = props.target.y
    setPos({ x, y, ready: false })
    const id = requestAnimationFrame(() => {
      const rect = box?.getBoundingClientRect()
      if (!rect) return
      const left = x + rect.width < window.innerWidth ? x - 2 : Math.max(2, x - rect.width + 2)
      const top = y + rect.height < window.innerHeight ? y - 2 : Math.max(2, y - rect.height + 2)
      setPos({ x: Math.max(2, left), y: Math.max(2, top), ready: true })
    })
    onCleanup(() => cancelAnimationFrame(id))
  })

  const commit = () => props.data.commits.find((item) => item.hash === props.target.hash)
  const parents = (): Parent[] =>
    (commit()?.parents ?? []).map((hash, idx) => ({
      hash,
      message: props.data.commits.find((item) => item.hash === hash)?.message ?? "",
      index: idx + 1,
    }))
  const run = (args: string[], title: string) => {
    const onRun = props.onRun
    props.onClose()
    onRun({ args, title })
  }
  const show = (node: (snap: Snap) => JSX.Element) => {
    const snap = {
      target: props.target,
      data: props.data,
      alwaysCheckout: props.alwaysCheckout,
      onAlwaysCheckout: props.onAlwaysCheckout,
      onRun: props.onRun,
    }
    props.onShow(() => node(snap))
  }
  const copy = (text: string, title: string) => {
    navigator.clipboard.writeText(text)
    showToast({ variant: "success", title })
    props.onClose()
  }
  const ref = () => (props.target.kind === "ref" ? props.target.ref : null)
  const mergeArgs = (base: string[], opts: { noFastForward: boolean; squash: boolean; noCommit?: boolean }) => {
    const args = [...base]
    if (opts.squash) args.push("--squash")
    else if (opts.noFastForward) args.push("--no-ff")
    if (opts.noCommit) args.push("--no-commit")
    return args
  }
  const checkout = () => {
    if (props.alwaysCheckout) {
      run(["checkout", props.target.hash], `Checkout ${short(props.target.hash)}`)
      return
    }
    show((snap) => (
      <CheckoutDialog
        hash={snap.target.hash}
        always={snap.alwaysCheckout}
        onAlways={snap.onAlwaysCheckout}
        onAction={() => snap.onRun({ args: ["checkout", snap.target.hash], title: `Checkout ${short(snap.target.hash)}` })}
      />
    ))
  }
  const create = (name?: string, check = false) =>
    show((snap) => (
      <DialogCreateBranch
        hash={snap.target.hash}
        branches={snap.data.branches}
        initialName={name}
        initialCheckout={check}
        onAction={(opts) => {
          if (!opts.checkout) {
            snap.onRun({
              args: ["branch", ...(opts.force ? ["-f"] : []), opts.name, snap.target.hash],
              title: `Create branch ${opts.name}`,
            })
            return
          }
          if (!opts.force) {
            snap.onRun({ args: ["checkout", "-b", opts.name, snap.target.hash], title: `Create branch ${opts.name}` })
            return
          }
          snap.onRun({ args: ["branch", "-f", opts.name, snap.target.hash], title: `Create branch ${opts.name}` })
          snap.onRun({ args: ["checkout", opts.name], title: `Checkout ${opts.name}` })
        }}
      />
    ))
  const addTag = () =>
    show((snap) => (
      <DialogAddTag
        hash={snap.target.hash}
        tags={snap.data.tags}
        remotes={snap.data.remotes}
        onAction={(opts) => {
          const args = ["tag", ...(opts.force ? ["-f"] : [])]
          if (opts.type === "annotated") args.push("-a", opts.name, "-m", opts.message)
          else args.push(opts.name)
          args.push(snap.target.hash)
          snap.onRun({ args, title: `Add tag ${opts.name}` })
          if (opts.remote) snap.onRun({ args: ["push", opts.remote, opts.name], title: `Push tag ${opts.name}` })
        }}
      />
    ))
  const merge = (name = props.target.hash, actionOn: "Branch" | "Commit" | "Remote Tracking Branch" = "Commit") =>
    show((snap) => (
      <DialogMerge
        name={name}
        branch={snap.data.branch ?? ""}
        actionOn={actionOn}
        onAction={(opts) =>
          snap.onRun({
            args: mergeArgs(["merge", name], opts),
            title: `Merge ${actionOn === "Commit" ? short(name) : name}`,
          })
        }
      />
    ))
  const rebase = (name = props.target.hash, actionOn: "Branch" | "Commit" = "Commit") =>
    show((snap) => (
      <DialogRebase
        name={actionOn === "Commit" ? short(name) : name}
        branch={snap.data.branch ?? ""}
        actionOn={actionOn}
        onAction={(opts) => {
          snap.onRun({
            args: opts.interactive
              ? ["rebase", "--interactive", name]
              : ["rebase", name, ...(opts.ignoreDate ? ["--ignore-date"] : [])],
            title: `Rebase onto ${actionOn === "Commit" ? short(name) : name}`,
          })
        }}
      />
    ))
  const reset = () =>
    show((snap) => (
      <DialogSelect
        title="Reset Current Branch to This Commit"
        description={`Are you sure you want to reset ${
          snap.data.branch ? `${snap.data.branch} (the current branch)` : "the current branch"
        } to commit ${short(snap.target.hash)}?`}
        options={[
          { mode: "soft", label: "Soft - Keep all changes, but reset head" },
          { mode: "mixed", label: "Mixed - Keep working tree, but reset index" },
          { mode: "hard", label: "Hard - Discard all changes" },
        ]}
        value={(item) => item.mode}
        label={(item) => item.label}
        defaultValue="mixed"
        actionLabel="Yes, reset"
        onAction={(item) =>
          snap.onRun({
            args: ["reset", `--${item.mode}`, snap.target.hash],
            title: `Reset --${item.mode} ${short(snap.target.hash)}`,
          })
        }
      />
    ))
  const revert = () => {
    if (parents().length > 1) {
      const opts = parents()
      show((snap) => (
        <DialogSelect
          title="Revert Commit"
          description={`Are you sure you want to revert merge commit ${short(snap.target.hash)}? Choose the parent hash on the main branch, to revert the commit relative to:`}
          options={opts}
          value={(item) => String(item.index)}
          label={(item) => `${short(item.hash)}: ${item.message}`}
          defaultValue="1"
          actionLabel="Yes, revert"
          onAction={(item) =>
            snap.onRun({
              args: ["revert", "--no-edit", "-m", String(item.index), snap.target.hash],
              title: `Revert ${short(snap.target.hash)}`,
            })
          }
        />
      ))
      return
    }
    show((snap) => (
      <Confirm
        title="Revert Commit"
        body={`Are you sure you want to revert commit ${short(snap.target.hash)}?`}
        action="Yes, revert"
        onAction={() => snap.onRun({ args: ["revert", "--no-edit", snap.target.hash], title: `Revert ${short(snap.target.hash)}` })}
      />
    ))
  }
  const cherry = () => {
    const opts = parents()
    show((snap) => (
      <DialogCherryPick
        hash={snap.target.hash}
        parents={opts}
        onAction={(opts) => {
          const args = ["cherry-pick"]
          if (opts.noCommit) args.push("--no-commit")
          if (opts.recordOrigin) args.push("-x")
          if (opts.parentIndex) args.push("-m", String(opts.parentIndex))
          args.push(snap.target.hash)
          snap.onRun({ args, title: `Cherry-pick ${short(snap.target.hash)}` })
        }}
      />
    ))
  }
  const drop = () =>
    show((snap) => (
      <Confirm
        title="Drop Commit"
        body={`Are you sure you want to permanently drop commit ${short(snap.target.hash)}?`}
        action="Yes, drop"
        danger
        onAction={() => snap.onRun({ args: ["rebase", "--onto", `${snap.target.hash}^`, snap.target.hash], title: `Drop ${short(snap.target.hash)}` })}
      />
    ))
  const headMenu = (item: Ref) => {
    const name = item.name
    const current = props.data.branch === name
    const remotes = item.kind === "head" ? item.remotes.map((remote) => remote.name) : []
    return (
      <>
        <MenuItem disabled={current} onClick={() => run(["checkout", name], `Checkout ${name}`)}>
          Checkout Branch
        </MenuItem>
        <MenuItem onClick={() => show((snap) => <RenameDialog name={name} branches={snap.data.branches} onAction={(next) => snap.onRun({ args: ["branch", "-m", name, next], title: `Rename ${name}` })} />)}>
          Rename Branch...
        </MenuItem>
        <MenuItem
          disabled={current}
          onClick={() =>
            show((snap) => (
              <DeleteBranchDialog
                name={name}
                current={current}
                remotes={remotes}
                onAction={(opts) => {
                  snap.onRun({ args: ["branch", opts.force ? "-D" : "-d", name], title: `Delete ${name}` })
                  opts.remotes.forEach((remote) =>
                    snap.onRun({ args: ["push", remote, "--delete", name], title: `Delete ${remote}/${name}` }),
                  )
                }}
              />
            ))
          }
        >
          Delete Branch...
        </MenuItem>
        <MenuItem disabled={current} onClick={() => merge(name, "Branch")}>Merge into Current Branch...</MenuItem>
        <MenuItem disabled={current} onClick={() => rebase(name, "Branch")}>
          Rebase Current Branch on Branch...
        </MenuItem>
        <Show when={props.data.remotes.length > 0}>
          <MenuItem
            onClick={() =>
              show((snap) => (
                <PushBranchDialog
                  name={name}
                  remotes={snap.data.remotes}
                  onAction={(opts) =>
                    opts.remotes.forEach((remote) =>
                      snap.onRun({
                        args: [
                          "push",
                          remote,
                          name,
                          ...(opts.upstream ? ["--set-upstream"] : []),
                          ...(opts.mode === "force-with-lease" ? ["--force-with-lease"] : opts.mode === "force" ? ["--force"] : []),
                        ],
                        title: `Push ${name}`,
                      }),
                    )
                  }
                />
              ))
            }
          >
            Push Branch...
          </MenuItem>
        </Show>
        <Sep />
        <MenuItem onClick={() => copy(name, "Copied branch name")}>Copy Branch Name to Clipboard</MenuItem>
      </>
    )
  }
  const remoteMenu = (item: Ref) => {
    if (item.kind !== "remote") return null
    const name = branch(item)
    const remote = item.remote ?? item.name.split("/")[0] ?? ""
    return (
      <>
        <MenuItem
          onClick={() =>
            show((snap) => (
              <RemoteCheckoutDialog
                remote={item.name}
                name={name}
                branches={snap.data.branches}
                onAction={(opts) => {
                  if (opts.existing) {
                    snap.onRun({ args: ["checkout", opts.name], title: `Checkout ${opts.name}` })
                    snap.onRun({ args: ["pull", remote, name], title: `Pull ${name}` })
                    return
                  }
                  snap.onRun({ args: ["checkout", "-b", opts.name, item.name], title: `Checkout ${opts.name}` })
                }}
              />
            ))
          }
        >
          Checkout Remote Branch...
        </MenuItem>
        <Show when={props.data.branches.includes(name)}>
          <MenuItem onClick={() => show((snap) => <FetchDialog remote={item.name} name={name} onAction={(force) => snap.onRun({ args: ["fetch", ...(force ? ["-f"] : []), remote, `${name}:${name}`], title: `Fetch ${name}` })} />)}>
            Fetch into Local Branch...
          </MenuItem>
        </Show>
        <MenuItem onClick={() => show((snap) => <Confirm title="Delete Remote Branch" body={`Are you sure you want to delete the remote branch ${item.name}?`} action="Yes, delete" danger onAction={() => snap.onRun({ args: ["push", remote, "--delete", name], title: `Delete ${item.name}` })} />)}>
          Delete Remote Branch...
        </MenuItem>
        <Sep />
        <MenuItem onClick={() => merge(item.name, "Remote Tracking Branch")}>Merge into current branch...</MenuItem>
        <MenuItem
          onClick={() =>
            show((snap) => (
              <PullDialog
                remote={remote}
                name={name}
                branch={snap.data.branch}
                full={item.name}
                onAction={(opts) =>
                  snap.onRun({
                    args: ["pull", remote, name, ...(opts.squash ? ["--squash"] : opts.noFastForward ? ["--no-ff"] : [])],
                    title: `Pull ${name}`,
                  })
                }
              />
            ))
          }
        >
          Pull into current branch...
        </MenuItem>
        <Sep />
        <MenuItem onClick={() => copy(item.name, "Copied remote branch name")}>Copy Remote Branch Name</MenuItem>
      </>
    )
  }
  const tagMenu = (item: Ref) => (
    <>
      <Show when={item.kind === "tag" && item.annotated}>
        <MenuItem onClick={() => run(["show", item.name], `Show tag ${item.name}`)}>View Details</MenuItem>
      </Show>
      <Show when={props.data.remotes.length > 0}>
        <MenuItem onClick={() => show((snap) => <PushTagDialog name={item.name} remotes={snap.data.remotes} onAction={(items) => items.forEach((remote) => snap.onRun({ args: ["push", remote, item.name], title: `Push tag ${item.name}` }))} />)}>
          Push Tag...
        </MenuItem>
      </Show>
      <MenuItem
        onClick={() =>
          show((snap) => (
            <DeleteTagDialog
              name={item.name}
              remotes={snap.data.remotes}
              onAction={(remote) => {
                if (remote) snap.onRun({ args: ["push", remote, "--delete", item.name], title: `Delete remote tag ${item.name}` })
                snap.onRun({ args: ["tag", "-d", item.name], title: `Delete tag ${item.name}` })
              }}
            />
          ))
        }
      >
        Delete Tag...
      </MenuItem>
      <Sep />
      <MenuItem onClick={() => copy(item.name, "Copied tag name")}>Copy Tag Name to Clipboard</MenuItem>
    </>
  )

  return (
    <Portal>
      <div
        ref={(el) => {
          box = el
        }}
        class="fixed z-[1001] min-w-[220px] rounded border border-border-weaker-base bg-surface-base py-1 shadow-lg"
        style={{ left: `${pos().x}px`, top: `${pos().y}px`, opacity: pos().ready ? "1" : "0" }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Show
          when={ref()}
          fallback={
            <>
              <MenuItem onClick={addTag}>Add Tag...</MenuItem>
              <MenuItem onClick={() => create()}>Create Branch...</MenuItem>
              <Sep />
              <MenuItem onClick={checkout}>{props.alwaysCheckout ? "Checkout" : "Checkout..."}</MenuItem>
              <MenuItem onClick={cherry}>Cherry Pick Commit...</MenuItem>
              <MenuItem onClick={revert}>Revert Commit...</MenuItem>
              <MenuItem disabled={!canDropCommit(props.data.commits, props.target.hash, props.data.head)} onClick={drop}>
                Drop Commit...
              </MenuItem>
              <Sep />
              <MenuItem onClick={() => merge()}>Merge into Current Branch...</MenuItem>
              <MenuItem onClick={() => rebase()}>Rebase Current Branch on This Commit...</MenuItem>
              <MenuItem onClick={reset}>Reset Current Branch to This Commit...</MenuItem>
              <Sep />
              <MenuItem onClick={() => copy(props.target.hash, language.t("session.tab.gitGraph.copiedHash"))}>
                Copy Commit Hash to Clipboard
              </MenuItem>
              <MenuItem onClick={() => copy(commit()?.message ?? "", language.t("session.tab.gitGraph.copiedMessage"))}>
                Copy Commit Subject to Clipboard
              </MenuItem>
            </>
          }
        >
          {(item) => (
            <>
              <Show when={item().kind === "head"}>{headMenu(item())}</Show>
              <Show when={item().kind === "remote"}>{remoteMenu(item())}</Show>
              <Show when={item().kind === "tag"}>{tagMenu(item())}</Show>
            </>
          )}
        </Show>
      </div>
    </Portal>
  )
}
