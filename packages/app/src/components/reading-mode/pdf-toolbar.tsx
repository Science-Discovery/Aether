import { type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useReadingMode } from "@/context/reading-mode"

export const PdfToolbar: Component = () => {
  const language = useLanguage()
  const rm = useReadingMode()

  const prevPage = () => rm.setPage(Math.max(1, rm.store.currentPage - 1))
  const nextPage = () => rm.setPage(Math.min(rm.store.totalPages, rm.store.currentPage + 1))

  const zoomIn = () => { rm.setFitWidth(false); rm.setZoom(Math.min(4, rm.store.zoom + 0.25)) }
  const zoomOut = () => { rm.setFitWidth(false); rm.setZoom(Math.max(0.25, rm.store.zoom - 0.25)) }
  const toggleFitWidth = () => rm.setFitWidth(!rm.store.fitWidth)

  const handlePageInput = (e: Event) => {
    const val = parseInt((e.target as HTMLInputElement).value, 10)
    if (!isNaN(val) && val >= 1 && val <= rm.store.totalPages) rm.setPage(val)
  }

  return (
    <div class="flex items-center gap-1 px-2 py-1 border-b border-border-base bg-surface-base flex-wrap shrink-0">
      {/* Navigation */}
      <Button
        variant="ghost"
        class="size-7 p-0"
        onClick={prevPage}
        disabled={rm.store.currentPage <= 1}
        title={language.t("reading.toolbar.prevPage")}
      >
        <Icon name="chevron-left" class="size-4" />
      </Button>

      <div class="flex items-center gap-1 text-sm text-text-base">
        {/* Wider input: w-16 fits 4-digit page numbers; hide browser spin arrows via CSS */}
        <input
          type="number"
          class="w-16 text-center bg-surface-raised-base rounded px-1 py-0.5 text-sm border border-border-base focus:outline-none focus:border-border-base-hover [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          value={rm.store.currentPage}
          min={1}
          max={rm.store.totalPages || 1}
          onChange={handlePageInput}
        />
        <span class="text-text-muted">/</span>
        <span class="text-text-muted">{rm.store.totalPages || "—"}</span>
      </div>

      <Button
        variant="ghost"
        class="size-7 p-0"
        onClick={nextPage}
        disabled={rm.store.currentPage >= rm.store.totalPages}
        title={language.t("reading.toolbar.nextPage")}
      >
        <Icon name="chevron-right" class="size-4" />
      </Button>

      <div class="w-px h-5 bg-border-base mx-1" />

      {/* Zoom */}
      <Button variant="ghost" class="size-7 p-0" onClick={zoomOut} title={language.t("reading.toolbar.zoomOut")}>
        <Icon name="dash" class="size-4" />
      </Button>

      {/* Always show numeric zoom; show "FW" indicator when fit-width is on */}
      <span class="text-sm text-text-muted w-14 text-center select-none">
        {Math.round(rm.store.zoom * 100)}%{rm.store.fitWidth ? " ⇔" : ""}
      </span>

      <Button variant="ghost" class="size-7 p-0" onClick={zoomIn} title={language.t("reading.toolbar.zoomIn")}>
        <Icon name="plus" class="size-4" />
      </Button>

      <Button
        variant="ghost"
        class="size-7 p-0"
        onClick={toggleFitWidth}
        title={language.t("reading.toolbar.fitWidth")}
        classList={{ "bg-surface-raised-base-hover": rm.store.fitWidth }}
      >
        <Icon name="expand" class="size-4" />
      </Button>

      <div class="w-px h-5 bg-border-base mx-1" />

      {/* Night mode */}
      <Button
        variant="ghost"
        class="size-7 p-0"
        onClick={() => rm.setNightMode(!rm.store.nightMode)}
        title={language.t("reading.toolbar.nightMode")}
        classList={{ "bg-surface-raised-base-hover": rm.store.nightMode }}
      >
        <Icon name="eye" class="size-4" />
      </Button>

      {/* Continuous reading mode toggle */}
      <Button
        variant="ghost"
        class="size-7 p-0"
        onClick={() => rm.setContinuousMode(!rm.store.continuousMode)}
        title={language.t("reading.toolbar.continuousMode")}
        classList={{ "bg-surface-raised-base-hover": rm.store.continuousMode }}
      >
        <Icon name="bullet-list" class="size-4" />
      </Button>
    </div>
  )
}
