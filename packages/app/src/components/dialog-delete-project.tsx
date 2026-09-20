import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useQuery, useMutation } from "@tanstack/solid-query"
import { For, Show, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/util/path"

export function DialogDeleteProject(props: { project: LocalProject; onConfirm?: () => void }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [confirmCascade, setConfirmCascade] = createSignal(false)

  const folderName = () => props.project.name || getFilename(props.project.worktree)

  const sessionCount = useQuery(() => ({
    queryKey: ["project-session-count", props.project.id],
    queryFn: async () => {
      const result = await globalSDK.client.project.sessionCount({ projectID: props.project.id! })
      return result.data?.count ?? 0
    },
  }))

  const sessions = useQuery(() => ({
    queryKey: ["project-sessions-preview", props.project.id],
    queryFn: async () => {
      const result = await globalSDK.client.project.sessionsPreview({ projectID: props.project.id! })
      return result.data?.sessions ?? []
    },
  }))

  const deleteMutation = useMutation(() => ({
    mutationFn: async (cascade: boolean) => {
      const result = await globalSDK.client.project.delete({ projectID: props.project.id!, cascade })
      return result.data!
    },
  }))

  const close = () => dialog.close()

  const dateLabel = (time: number) =>
    new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })

  return (
    <Dialog title={language.t("dialog.project.delete.title")} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-6 pt-0">
        <Show
          when={sessionCount.data !== undefined && !sessionCount.isLoading}
          fallback={<p class="text-sm text-text-weak">{language.t("common.loading")}</p>}
        >
          <Show
            when={deleteMutation.data?.status === "ok"}
            fallback={
              <Show
                when={sessionCount.data! > 0}
                fallback={
                  <div class="flex flex-col gap-3">
                    <p class="text-sm text-text-base">
                      {language.t("dialog.project.delete.confirm", { name: folderName() })}
                    </p>
                    <div class="flex justify-end gap-2">
                      <Button variant="ghost" onClick={close}>
                        {language.t("common.cancel")}
                      </Button>
                      <Button
                        variant="primary"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          props.onConfirm?.()
                          deleteMutation.mutate(false)
                        }}
                      >
                        {deleteMutation.isPending ? language.t("common.deleting") : language.t("common.delete")}
                      </Button>
                    </div>
                  </div>
                }
              >
                <div class="flex flex-col gap-3">
                  <p class="text-sm text-text-base">
                    {language.t("dialog.project.delete.hasSessions", {
                      count: sessionCount.data!,
                      name: folderName(),
                    })}
                  </p>
                  <div class="flex max-h-48 flex-col gap-1 overflow-y-auto">
                    <For each={sessions.data ?? []}>
                      {(session) => (
                        <div class="flex items-baseline justify-between gap-2 rounded px-2 py-1 text-12-regular text-text-weak">
                          <span class="truncate">{session.title || session.id}</span>
                          <span class="shrink-0">
                            {session.time_archived
                              ? language.t("dialog.project.delete.sessionArchived")
                              : dateLabel(session.time_created)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                  <p class="text-12-regular text-text-weak">{language.t("dialog.project.delete.cascadeHint")}</p>
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" onClick={close}>
                      {language.t("common.cancel")}
                    </Button>
                    <Show
                      when={confirmCascade()}
                      fallback={
                        <Button variant="secondary" onClick={() => setConfirmCascade(true)}>
                          {language.t("dialog.project.delete.cascade")}
                        </Button>
                      }
                    >
                      <Button
                        variant="primary"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          props.onConfirm?.()
                          deleteMutation.mutate(true)
                        }}
                      >
                        {deleteMutation.isPending
                          ? language.t("common.deleting")
                          : language.t("dialog.project.delete.cascadeConfirm")}
                      </Button>
                    </Show>
                  </div>
                </div>
              </Show>
            }
          >
            <div class="flex flex-col gap-3">
              <p class="text-sm text-text-base">
                {language.t("dialog.project.delete.deleted", { name: folderName() })}
              </p>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>
                  {language.t("common.ok")}
                </Button>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
