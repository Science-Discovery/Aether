import { createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { formatServerError } from "@/utils/server-errors"
import { affectedTabs, parentDir } from "@/utils/file-tree"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type Tabs = { all: () => string[]; close: (tab: string) => void }

/** File tree operations (create/rename/delete) shared by the side panel and the titlebar popover. */
export function createFileActions(input: { tabs?: () => Tabs | undefined; refresh?: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const file = useFile()
  const language = useLanguage()

  const fail = (title: string, err: unknown) =>
    showToast({ variant: "error", icon: "circle-x", title, description: formatServerError(err, language.t) })

  function create(dir: string, type: "file" | "directory") {
    const title = type === "file" ? language.t("fileTree.newFile") : language.t("fileTree.newFolder")
    const placeholder =
      type === "file" ? language.t("fileTree.newFilePlaceholder") : language.t("fileTree.newFolderPlaceholder")
    dialog.show(() => {
      const [name, setName] = createSignal("")
      const doCreate = async () => {
        const trimmed = name().trim()
        if (!trimmed) return
        dialog.close()
        const newPath = dir ? `${dir}/${trimmed}` : trimmed
        try {
          await sdk.client.file.create({ path: newPath, type })
          file.tree.refresh(dir)
          input.refresh?.()
          if (!file.tree.state(dir)?.expanded) file.tree.expand(dir)
        } catch (err) {
          fail(language.t("fileTree.createFailed"), err)
        }
      }
      return (
        <Dialog
          title={title}
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => dialog.close()} style={{ padding: "4px 12px", cursor: "pointer" }}>
                {language.t("common.cancel")}
              </button>
              <button onClick={doCreate} style={{ padding: "4px 12px", cursor: "pointer", "font-weight": "bold" }}>
                {language.t("common.confirm")}
              </button>
            </div>
          }
        >
          <div style={{ padding: "12px 0" }}>
            <input
              autofocus
              type="text"
              value={name()}
              placeholder={placeholder}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doCreate()
                if (e.key === "Escape") dialog.close()
              }}
              style={{ width: "100%", padding: "6px 8px", "box-sizing": "border-box" }}
            />
          </div>
        </Dialog>
      )
    })
  }

  function remove(node: FileNode) {
    const label = node.type === "directory" ? language.t("fileTree.folder") : language.t("fileTree.file")
    dialog.show(() => {
      const doRemove = async () => {
        dialog.close()
        try {
          await sdk.client.file.delete({ path: node.path })
          file.tree.refresh(parentDir(node.path))
          if (input.tabs) {
            for (const tab of affectedTabs(input.tabs()?.all() ?? [], file.pathFromTab, node)) input.tabs()?.close(tab)
          }
          file.setSelectedPaths((prev) => {
            if (!prev.has(node.path)) return prev
            const next = new Set(prev)
            next.delete(node.path)
            return next
          })
          input.refresh?.()
        } catch (err) {
          fail(language.t("fileTree.deleteFailed"), err)
        }
      }
      return (
        <Dialog
          title={language.t("fileTree.deleteTitle", { label })}
          description={language.t("fileTree.deleteConfirmDesc", { label, name: node.name })}
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => dialog.close()} style={{ padding: "4px 12px", cursor: "pointer" }}>
                {language.t("common.cancel")}
              </button>
              <button
                autofocus
                onClick={doRemove}
                style={{ padding: "4px 12px", cursor: "pointer", "font-weight": "bold", color: "red" }}
              >
                {language.t("common.delete")}
              </button>
            </div>
          }
        />
      )
    })
  }

  function rename(node: FileNode) {
    dialog.show(() => {
      const [name, setName] = createSignal(node.name)
      const doRename = async () => {
        const newName = name().trim()
        if (!newName || newName === node.name) {
          dialog.close()
          return
        }
        dialog.close()
        try {
          await sdk.client.file.rename({ path: node.path, name: newName })
          file.tree.refresh(parentDir(node.path))
          input.refresh?.()
        } catch (err) {
          fail(language.t("fileTree.renameFailed"), err)
        }
      }
      return (
        <Dialog
          title={language.t("fileTree.renameTitle")}
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => dialog.close()} style={{ padding: "4px 12px", cursor: "pointer" }}>
                {language.t("common.cancel")}
              </button>
              <button
                autofocus
                onClick={doRename}
                style={{ padding: "4px 12px", cursor: "pointer", "font-weight": "bold" }}
              >
                {language.t("common.confirm")}
              </button>
            </div>
          }
        >
          <input
            type="text"
            value={name()}
            ref={(el) =>
              setTimeout(() => {
                el.focus()
                el.select()
              }, 0)
            }
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doRename()
              if (e.key === "Escape") dialog.close()
            }}
            style={{
              width: "100%",
              padding: "6px 8px",
              background: "var(--surface-raised-base)",
              border: "1px solid var(--border-base)",
              "border-radius": "4px",
              color: "var(--text-strong)",
              "font-size": "14px",
              outline: "none",
            }}
          />
        </Dialog>
      )
    })
  }

  return { create, remove, rename }
}
