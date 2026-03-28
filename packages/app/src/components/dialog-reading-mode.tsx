import { type Component, createSignal, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"

export const DialogReadingMode: Component = () => {
  const language = useLanguage()
  const dialogCtx = useDialog()
  const params = useParams()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const server = useServer()

  const [file, setFile] = createSignal<File | null>(null)
  const [uploading, setUploading] = createSignal(false)
  const [showAdvanced, setShowAdvanced] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [uploadProgress, setUploadProgress] = createSignal<string | null>(null)

  const MB = 1024 * 1024
  const GB = 1024 * MB
  const MAX_SIZE = GB // 1 GB hard limit (matches server maxRequestBodySize)
  const WARN_SIZE = 500 * MB // show a notice above 500 MB

  function formatSize(bytes: number) {
    if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
    if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`
    return `${(bytes / 1024).toFixed(0)} KB`
  }

  function pickFile(f: File | undefined) {
    if (!f) return
    if (f.type !== "application/pdf") { setError("仅支持 PDF 文件"); return }
    if (f.size > MAX_SIZE) { setError(`文件过大（${formatSize(f.size)}），上限为 1 GB`); return }
    setError(null)
    setFile(f)
  }

  // Advanced settings state
  const [translatePrompt, setTranslatePrompt] = createSignal(
    "请将以下英文内容翻译成中文，保留所有专业术语的英文原文（首次出现时括注中文），数学公式保持不变，保持原文的段落结构。",
  )
  const [questionPrompt, setQuestionPrompt] = createSignal(
    "用户正在阅读一份 PDF 文件，并选中了以下内容：\n\n【选中内容】\n{selected_content}\n\n用户的问题是：{user_question}\n\n你可以参考以下相关页面的内容来辅助回答：\n\n【参考页面内容】\n{context_pages}\n\n请针对用户选中的这部分内容，结合参考页面，给出清晰准确的回答。",
  )
  const [firstReadPrompt, setFirstReadPrompt] = createSignal(
    "请初步阅读这份PDF文件（或其中一部分），对文件的主要内容、结构和核心论点进行总结和概括。接下来用户可能会就文件中的具体内容向你提问，请在回答时参考你对全文的理解。",
  )
  const [contextPageRange, setContextPageRange] = createSignal<0 | 1 | 2>(1)
  const [disableAutoRead, setDisableAutoRead] = createSignal(false)

  let dropRef: HTMLDivElement | undefined
  let fileInputRef: HTMLInputElement | undefined

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    pickFile(e.dataTransfer?.files[0])
  }

  const handleStart = async () => {
    const f = file()
    if (!f) return
    setUploading(true)
    setError(null)
    setUploadProgress(f.size > WARN_SIZE ? `正在上传（${formatSize(f.size)}，请稍候…）` : null)

    try {
      const currentServer = server.current
      if (!currentServer) throw new Error("No server available")

      const form = new FormData()
      form.append("pdf", f)
      form.append(
        "settings",
        JSON.stringify({
          translatePrompt: translatePrompt(),
          questionPrompt: questionPrompt(),
          firstReadPrompt: firstReadPrompt(),
          contextPageRange: contextPageRange(),
          autoFirstRead: !disableAutoRead(),
        }),
      )

      const res = await fetch(`${currentServer.http.url}/reading-mode/session`, {
        method: "POST",
        body: form,
      })

      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || `HTTP ${res.status}`)
      }

      const session = await res.json()
      dialogCtx.close()

      // Navigate to the new reading session
      navigate(`/${encodeURIComponent(params.dir ?? "")}/session/${session.id}/reading`)
    } catch (e) {
      setError(String((e as Error)?.message ?? "Upload failed"))
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }

  return (
    <Dialog title={language.t("reading.dialog.title")} size="large">
      <div class="flex flex-col gap-4 p-4 max-h-[70vh] overflow-y-auto">
        <Show when={error()}>
          <div class="text-red-400 text-sm bg-surface-raised-base rounded p-2">{error()}</div>
        </Show>

        {/* File upload area */}
        <div>
          <p class="text-sm text-text-base mb-2">{language.t("reading.dialog.upload.label")}</p>
          <div
            ref={dropRef}
            class="border-2 border-dashed border-border-base rounded-lg p-6 text-center cursor-pointer hover:border-border-base-hover transition-colors"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef?.click()}
          >
            <Show
              when={file()}
              fallback={
                <>
                  <p class="text-sm text-text-base">{language.t("reading.dialog.upload.hint")}</p>
                  <p class="text-xs text-text-muted mt-1">{language.t("reading.dialog.upload.format")}</p>
                </>
              }
            >
              {(f) => (
                <div class="flex flex-col items-center gap-1">
                  <p class="text-sm text-text-strong">{f().name}</p>
                  <p class="text-xs text-text-muted">{formatSize(f().size)}</p>
                  <Show when={f().size > WARN_SIZE}>
                    <p class="text-xs text-yellow-500 mt-1">
                      文件较大，上传可能需要较长时间
                    </p>
                  </Show>
                </div>
              )}
            </Show>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            class="hidden"
            onChange={(e) => {
              pickFile(e.currentTarget.files?.[0])
              e.currentTarget.value = ""
            }}
          />
        </div>

        {/* Advanced settings collapsible */}
        <div>
          <button
            type="button"
            class="flex items-center gap-1 text-sm text-text-muted hover:text-text-base w-full text-left"
            onClick={() => setShowAdvanced(!showAdvanced())}
          >
            <span class="text-xs">{showAdvanced() ? "▼" : "▶"}</span>
            {language.t("reading.dialog.advanced")}
          </button>

          <Show when={showAdvanced()}>
            <div class="mt-3 flex flex-col gap-3 pl-3 border-l border-border-base">
              <label class="flex flex-col gap-1">
                <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.translatePrompt")}</span>
                <textarea
                  class="text-sm bg-surface-raised-base rounded p-2 border border-border-base resize-none focus:outline-none focus:border-border-base-hover"
                  rows={3}
                  value={translatePrompt()}
                  onInput={(e) => setTranslatePrompt(e.currentTarget.value)}
                />
              </label>

              <label class="flex flex-col gap-1">
                <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.questionPrompt")}</span>
                <textarea
                  class="text-sm bg-surface-raised-base rounded p-2 border border-border-base resize-none focus:outline-none focus:border-border-base-hover"
                  rows={4}
                  value={questionPrompt()}
                  onInput={(e) => setQuestionPrompt(e.currentTarget.value)}
                />
              </label>

              <label class="flex flex-col gap-1">
                <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.firstReadPrompt")}</span>
                <textarea
                  class="text-sm bg-surface-raised-base rounded p-2 border border-border-base resize-none focus:outline-none focus:border-border-base-hover"
                  rows={3}
                  value={firstReadPrompt()}
                  onInput={(e) => setFirstReadPrompt(e.currentTarget.value)}
                />
              </label>

              <label class="flex flex-col gap-1">
                <span class="text-xs text-text-muted">{language.t("reading.dialog.advanced.contextPageRange")}</span>
                <select
                  class="text-sm bg-surface-raised-base rounded p-2 border border-border-base focus:outline-none"
                  value={contextPageRange()}
                  onChange={(e) => setContextPageRange(parseInt(e.currentTarget.value) as 0 | 1 | 2)}
                >
                  <option value={0}>{language.t("reading.dialog.advanced.contextPage.0")}</option>
                  <option value={1}>{language.t("reading.dialog.advanced.contextPage.1")}</option>
                  <option value={2}>{language.t("reading.dialog.advanced.contextPage.2")}</option>
                </select>
              </label>

              <label class="flex items-center gap-2 text-sm text-text-base cursor-pointer">
                <input
                  type="checkbox"
                  checked={disableAutoRead()}
                  onChange={(e) => setDisableAutoRead(e.currentTarget.checked)}
                  class="rounded"
                />
                {language.t("reading.dialog.advanced.disableAutoRead")}
              </label>
            </div>
          </Show>
        </div>

        {/* Action buttons */}
        <div class="flex flex-col gap-2 pt-2">
          <Show when={uploadProgress()}>
            <p class="text-xs text-text-muted text-center">{uploadProgress()}</p>
          </Show>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => dialogCtx.close()} disabled={uploading()}>
              {language.t("reading.dialog.cancel")}
            </Button>
            <Button onClick={handleStart} disabled={!file() || uploading()}>
              {uploading() ? language.t("reading.dialog.uploading") : language.t("reading.dialog.start")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
