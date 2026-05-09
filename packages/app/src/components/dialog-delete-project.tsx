import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useQuery, useMutation } from "@tanstack/solid-query"
import { Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/util/path"

export function DialogDeleteProject(props: { project: LocalProject; onConfirm?: () => void }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()

  const folderName = () => props.project.name || getFilename(props.project.worktree)

  const sessionCount = useQuery(() => ({
    queryKey: ["project-session-count", props.project.id],
    queryFn: async () => {
      const result = await globalSDK.client.project.sessionCount({ projectID: props.project.id! })
      return result.data?.count ?? 0
    },
  }))

  const deleteMutation = useMutation(() => ({
    mutationFn: async () => {
      const result = await globalSDK.client.project.delete({ projectID: props.project.id! })
      return result.data!
    },
  }))

  const close = () => dialog.close()

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
                          deleteMutation.mutate()
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
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" onClick={close}>
                      {language.t("common.ok")}
                    </Button>
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
