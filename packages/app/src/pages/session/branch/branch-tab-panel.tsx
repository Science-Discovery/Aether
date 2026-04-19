import { useNavigate, useParams } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2"
import { DialogFork } from "@/components/dialog-fork"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { produce, reconcile } from "solid-js/store"
import { buildBranchTreeRows, type BranchTreeRow } from "./branch-tree-model"
import { BranchTreeList } from "./branch-tree-list"

type BranchTreeResponse =
  | {
      kind: "tree"
      treeID: string
      sessions: Session[]
    }
  | {
      kind: "legacy"
      message: string
    }

function mergeSessionsByID(existing: Session[], incoming: Session[]) {
  const merged = new Map(existing.map((session) => [session.id, session] as const))
  for (const session of incoming) merged.set(session.id, session)
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function BranchTabPanel(props: { sessionID: string }) {
  const params = useParams()
  const navigate = useNavigate()
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const zh = createMemo(() => language.locale() === "zh" || language.locale() === "zht")
  const [loading, setLoading] = createSignal(false)
  const [tree, setTree] = createSignal<BranchTreeResponse>()
  const [errorMessage, setErrorMessage] = createSignal<string>()

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    let cancelled = false

    void (async () => {
      setLoading(true)
      setErrorMessage(undefined)
      try {
        const result = await sdk.client.session.tree({ sessionID })
        const payload = result.data as BranchTreeResponse | undefined
        if (!payload) throw new Error("Missing branch tree response")
        if (cancelled) return

        setTree(payload)

        if (payload.kind === "tree") {
          sync.set("session", reconcile(mergeSessionsByID(untrack(() => sync.data.session), payload.sessions), { key: "id" }))

          const treeSessionIDs = new Set(payload.sessions.map((session) => session.id))
          const externalParentIDs = [...new Set(payload.sessions.map((session) => session.parentID).filter(Boolean) as string[])]
            .filter((parentID) => !treeSessionIDs.has(parentID))

          await Promise.all(
            [...payload.sessions.map((session) => session.id), ...externalParentIDs].map((targetSessionID) =>
              sync.session.sync(targetSessionID).catch(() => undefined),
            ),
          )
        }
      } catch (error) {
        console.error("Failed to load branch tree", error)
        if (cancelled) return
        setTree(undefined)
        setErrorMessage(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    onCleanup(() => {
      cancelled = true
    })
  })

  const rows = createMemo(() => {
    const payload = tree()
    if (!payload || payload.kind !== "tree") return []

    return buildBranchTreeRows({
      currentSessionID: props.sessionID,
      treeSessions: payload.sessions,
      allSessions: sync.data.session,
      messagesBySession: sync.data.message,
      partsByMessage: sync.data.part,
      previewPlaceholder: zh() ? "暂无内容" : "No messages yet",
    }).rows
  })

  const hint = createMemo(() =>
    zh() ? "当前任务树中的分支会显示在这里。" : "Branches for this task tree appear here.",
  )

  const fullHint = createMemo(() =>
    zh() ? "按创建顺序展示当前任务树。" : "This task tree is ordered by creation time.",
  )

  const legacyHint = createMemo(() =>
    zh()
      ? "这个会话属于旧体系，不提供新的分支树视图。你仍然可以正常使用 Aether 原有的 fork。"
      : "This is a legacy session. The new branch tree is unavailable, but the existing fork flow still works.",
  )

  const renameTitle = (row: BranchTreeRow) => {
    dialog.show(() => {
      const [value, setValue] = createSignal(row.title)
      const [saving, setSaving] = createSignal(false)

      const save = async () => {
        const next = value().trim()
        if (!next || next === row.title || saving()) {
          dialog.close()
          return
        }

        setSaving(true)
        try {
          await sdk.client.session.update({ sessionID: row.id, title: next })
          sync.set(
            produce((draft) => {
              const sessions = draft.session ?? []
              const index = sessions.findIndex((session) => session.id === row.id)
              if (index !== -1) sessions[index].title = next
            }),
          )
          dialog.close()
        } catch (err) {
          const message =
            err && typeof err === "object" && "data" in err && typeof err.data === "object" && err.data && "message" in err.data
              ? String((err.data as { message?: string }).message ?? language.t("common.requestFailed"))
              : err instanceof Error
                ? err.message
                : language.t("common.requestFailed")

          showToast({
            title: language.t("common.requestFailed"),
            description: message,
          })
          setSaving(false)
        }
      }

      return (
        <Dialog
          title={language.t("common.rename")}
          action={
            <div class="flex gap-2">
              <button class="px-3 py-1.5" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </button>
              <button class="px-3 py-1.5 font-semibold" disabled={saving()} onClick={() => void save()}>
                {saving() ? `${language.t("common.loading")}${language.t("common.loading.ellipsis")}` : language.t("common.save")}
              </button>
            </div>
          }
        >
          <div class="py-3">
            <input
              autofocus
              type="text"
              value={value()}
              onInput={(event) => setValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save()
                if (event.key === "Escape") dialog.close()
              }}
              class="w-full rounded-md border border-border-base bg-background-stronger px-3 py-2 text-13-regular text-text-strong outline-none"
            />
          </div>
        </Dialog>
      )
    })
  }

  const openSession = (sessionID: string) => {
    if (!params.dir || !sessionID || sessionID === props.sessionID) return
    navigate(`/${params.dir}/session/${sessionID}`)
  }

  return (
    <div class="h-full min-h-0 overflow-hidden bg-background-base">
      <div class="flex h-full min-h-0 flex-col">
        <div class="border-b border-border-weaker-base px-4 py-3">
          <div class="text-12-regular text-text-weak">
            <Switch>
              <Match when={loading() && !tree()}>
                {`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}
              </Match>
              <Match when={tree()?.kind === "legacy"}>{legacyHint()}</Match>
              <Match when={tree()?.kind === "tree" && rows().length > 1}>{fullHint()}</Match>
              <Match when={errorMessage()}>{errorMessage()}</Match>
              <Match when={true}>{hint()}</Match>
            </Switch>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-hidden">
          <Switch>
            <Match when={tree()?.kind === "legacy"}>
              <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div class="text-13-medium text-text-base">{zh() ? "旧会话" : "Legacy session"}</div>
                <div class="max-w-72 text-12-regular text-text-weak">{legacyHint()}</div>
              </div>
            </Match>
            <Match when={rows().length > 0}>
              <BranchTreeList
                rows={rows()}
                onSelect={(row) => openSession(row.id)}
                onFork={(row) => dialog.show(() => <DialogFork sessionID={row.id} />)}
                onRename={renameTitle}
              />
            </Match>
            <Match when={true}>
              <div class="flex h-full items-center justify-center px-6 text-center text-12-regular text-text-weak">
                <Show when={!loading()} fallback={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}>
                  {errorMessage() ?? hint()}
                </Show>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}
