import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useKeybind } from "../context/keybind"
import { DialogSessionList } from "./workspace/dialog-session-list"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

function openWorkspace(input: {
  dialog: ReturnType<typeof useDialog>
  route: ReturnType<typeof useRoute>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
  workspaceID: string
}) {
  input.sdk.setWorkspace(input.workspaceID)
  input.route.navigate({
    type: "home",
    workspaceID: input.workspaceID,
  })
  input.dialog.clear()
}

function DialogWorkspaceCreate(props: { onSelect: (workspaceID: string) => void }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [creating, setCreating] = createSignal<string>()

  onMount(() => {
    dialog.setSize("medium")
  })

  const options = createMemo(() => {
    const type = creating()
    if (type) {
      return [
        {
          title: `Creating ${type} workspace...`,
          value: "creating" as const,
          description: "This can take a while for remote environments",
        },
      ]
    }
    return [
      {
        title: "Worktree",
        value: "worktree" as const,
        description: "Create a local git worktree",
      },
    ]
  })

  const createWorkspace = async (type: string) => {
    if (creating()) return
    setCreating(type)

    const result = await sdk.client.experimental.workspace.create({ type, branch: null }).catch((err) => {
      console.log(err)
      return undefined
    })
    console.log(JSON.stringify(result, null, 2))
    const workspace = result?.data
    if (!workspace) {
      setCreating(undefined)
      toast.show({
        message: "Failed to create workspace",
        variant: "error",
      })
      return
    }
    await sync.workspace.sync()
    await props.onSelect(workspace.id)
    setCreating(undefined)
  }

  return (
    <DialogSelect
      title={creating() ? "Creating Workspace" : "New Workspace"}
      skipFilter={true}
      options={options()}
      onSelect={(option) => {
        if (option.value === "creating") return
        void createWorkspace(option.value)
      }}
    />
  )
}

export function DialogWorkspaceList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const keybind = useKeybind()
  const [toDelete, setToDelete] = createSignal<string>()
  const [counts, setCounts] = createSignal<Record<string, number | null | undefined>>({})

  const open = (workspaceID: string) =>
    openWorkspace({
      dialog,
      route,
      sdk,
      sync,
      toast,
      workspaceID,
    })

  async function selectWorkspace(workspaceID: string) {
    if (workspaceID === "__local__") {
      if (localCount() > 0) {
        dialog.replace(() => <DialogSessionList localOnly={true} />)
        return
      }
      route.navigate({
        type: "home",
      })
      dialog.clear()
      return
    }
    const count = counts()[workspaceID]
    if (count && count > 0) {
      dialog.replace(() => <DialogSessionList workspaceID={workspaceID} />)
      return
    }
    if (count === undefined) {
      const client = createOpencodeClient({
        baseUrl: sdk.url,
        fetch: sdk.fetch,
        directory: sync.data.path.directory || sdk.directory,
        experimental_workspaceID: workspaceID,
      })
      const listed = await client.session.list({ roots: true, limit: 1 }).catch(() => undefined)
      if (listed?.data?.length) {
        dialog.replace(() => <DialogSessionList workspaceID={workspaceID} />)
        return
      }
    }
    sdk.setWorkspace(workspaceID)
    route.navigate({
      type: "home",
      workspaceID,
    })
    dialog.clear()
  }

  const currentWorkspaceID = createMemo(() => {
    if (route.data.type === "session") {
      return sync.session.get(route.data.sessionID)?.workspaceID ?? "__local__"
    }
    return "__local__"
  })

  const localCount = createMemo(
    () => sync.data.session.filter((session) => !session.workspaceID && !session.parentID).length,
  )

  let run = 0
  createEffect(() => {
    const workspaces = sync.data.workspaceList
    const next = ++run
    if (!workspaces.length) {
      setCounts({})
      return
    }
    setCounts(Object.fromEntries(workspaces.map((workspace) => [workspace.id, undefined])))
    void Promise.all(
      workspaces.map(async (workspace) => {
        const client = createOpencodeClient({
          baseUrl: sdk.url,
          fetch: sdk.fetch,
          directory: sync.data.path.directory || sdk.directory,
          experimental_workspaceID: workspace.id,
        })
        const result = await client.session.list({ roots: true }).catch(() => undefined)
        return [workspace.id, result ? (result.data?.length ?? 0) : null] as const
      }),
    ).then((entries) => {
      if (run !== next) return
      setCounts(Object.fromEntries(entries))
    })
  })

  const options = createMemo(() => [
    {
      title: "Local",
      value: "__local__",
      category: "Workspace",
      description: "Use the local machine",
      footer: `${localCount()} session${localCount() === 1 ? "" : "s"}`,
    },
    ...sync.data.workspaceList.map((workspace) => {
      const count = counts()[workspace.id]
      return {
        title:
          toDelete() === workspace.id
            ? `Delete ${workspace.id}? Press ${keybind.print("session_delete")} again`
            : workspace.id,
        value: workspace.id,
        category: workspace.type,
        description: workspace.branch ? `Branch ${workspace.branch}` : undefined,
        footer:
          count === undefined
            ? "Loading sessions..."
            : count === null
              ? "Sessions unavailable"
              : `${count} session${count === 1 ? "" : "s"}`,
      }
    }),
    {
      title: "+ New workspace",
      value: "__create__",
      category: "Actions",
      description: "Create a new workspace",
    },
  ])

  onMount(() => {
    dialog.setSize("large")
    void sync.workspace.sync()
  })

  return (
    <DialogSelect
      title="Workspaces"
      skipFilter={true}
      options={options()}
      current={currentWorkspaceID()}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        setToDelete(undefined)
        if (option.value === "__create__") {
          dialog.replace(() => <DialogWorkspaceCreate onSelect={(workspaceID) => open(workspaceID)} />)
          return
        }
        void selectWorkspace(option.value)
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (option.value === "__create__" || option.value === "__local__") return
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            setToDelete(undefined)
            const workspace = sync.data.workspaceList.find((w) => w.id === option.value)
            if (workspace?.branch) {
              const confirmed = await DialogConfirm.show(
                dialog,
                "Delete branch",
                `Also delete branch "${workspace.branch}"?`,
                "delete",
              )
              const deleteBranch = confirmed === true
              const result = await sdk.client.experimental.workspace
                .remove({ id: option.value, deleteBranch })
                .catch(() => undefined)
              if (result?.error) {
                toast.show({
                  message: "Failed to delete workspace",
                  variant: "error",
                })
                return
              }
            } else {
              const result = await sdk.client.experimental.workspace.remove({ id: option.value }).catch(() => undefined)
              if (result?.error) {
                toast.show({
                  message: "Failed to delete workspace",
                  variant: "error",
                })
                return
              }
            }
            if (currentWorkspaceID() === option.value) {
              route.navigate({
                type: "home",
              })
            }
            await sync.workspace.sync()
          },
        },
      ]}
    />
  )
}
