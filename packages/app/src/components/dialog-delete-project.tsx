import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useMutation } from "@tanstack/solid-query"
import { Show, Switch, Match } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { getFilename } from "@opencode-ai/util/path"

export function DialogDeleteProject(props: { project: LocalProject }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()

  const folderName = () => props.project.name || getFilename(props.project.worktree)

  const countQuery = useMutation(() => ({
    mutationFn: async () => {
      const result = await globalSDK.client.project.sessionCount({ projectID: props.project.id! })
      return result.data!.count
    },
  }))

  const deleteMutation = useMutation(() => ({
    mutationFn: async () => {
      const result = await globalSDK.client.project.delete({ projectID: props.project.id! })
      return result.data!
    },
  }))

  const close = () => dialog.close()

  countQuery.mutate()

  return (
    <Dialog title={language.t("dialog.project.delete.title")} fit persistent class="w-full max-w-[480px] mx-auto">
      <div class="flex flex-col gap-4 p-6 pt-0">
        <Switch>
          <Match when={countQuery.isPending || countQuery.isError}>
            <p class="text-sm text-text-weak">{language.t("common.loading")}</p>
          </Match>
          <Match when={countQuery.data! > 0}>
            <div class="flex flex-col gap-3">
              <p class="text-sm text-text-base">
                {language.t("dialog.project.delete.hasSessions", {
                  count: countQuery.data!,
                  name: folderName(),
                })}
              </p>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>
                  {language.t("common.ok")}
                </Button>
              </div>
            </div>
          </Match>
          <Match when={deleteMutation.data?.status === "ok"}>
            <p class="text-sm text-text-base">{language.t("dialog.project.delete.deleted", { name: folderName() })}</p>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                {language.t("common.ok")}
              </Button>
            </div>
          </Match>
          <Match when={countQuery.data === 0}>
            <p class="text-sm text-text-base">{language.t("dialog.project.delete.confirm", { name: folderName() })}</p>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                {language.t("common.cancel")}
              </Button>
              <Button variant="primary" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                {deleteMutation.isPending ? language.t("common.deleting") : language.t("common.delete")}
              </Button>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
