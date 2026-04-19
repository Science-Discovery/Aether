import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import type { BranchTreeRow as BranchTreeRowModel } from "./branch-tree-model"

export function BranchTreeRow(props: {
  row: BranchTreeRowModel
  railWidth: number
  onSelect: () => void
  onFork: () => void
  onRename: () => void
}) {
  const language = useLanguage()

  return (
    <div
      role="button"
      tabIndex={0}
      class="group/branch-row relative z-10 cursor-pointer border-b border-border-weaker-base outline-none last:border-b-0"
      onClick={() => props.onSelect()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        props.onSelect()
      }}
    >
      <div
        class="flex min-h-[48px] items-center gap-3 pr-2 transition-colors"
        classList={{
          "bg-surface-base": props.row.isCurrent,
          "hover:bg-background-stronger": !props.row.isCurrent,
        }}
        style={{ "padding-left": `${props.railWidth + 10}px` }}
      >
        <div class="min-w-0 flex-1 py-1.5">
          <div
            class="truncate text-12-medium"
            classList={{
              "text-text-strong": props.row.isCurrent,
              "text-text-base": !props.row.isCurrent,
            }}
          >
            {props.row.title}
          </div>
          <div class="mt-0.5 truncate text-[11px] leading-4 text-text-weak">{props.row.previewText}</div>
        </div>

        <div class="shrink-0 opacity-0 transition-opacity group-hover/branch-row:opacity-100 group-focus-within/branch-row:opacity-100">
          <DropdownMenu placement="bottom-end">
            <DropdownMenu.Trigger
              as={IconButton}
              icon="dot-grid"
              variant="ghost"
              class="size-6 rounded-md"
              aria-label={language.t("common.moreOptions")}
              onClick={(event: MouseEvent) => event.stopPropagation()}
              onPointerDown={(event: PointerEvent) => event.stopPropagation()}
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Content onClick={(event: MouseEvent) => event.stopPropagation()}>
                <DropdownMenu.Item disabled={props.row.isCurrent} onSelect={props.onSelect}>
                  <DropdownMenu.ItemLabel>{language.t("notification.action.goToSession")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={props.onFork}>
                  <DropdownMenu.ItemLabel>{language.t("command.session.fork")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={props.onRename}>
                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
