import { createMemo, createSignal, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { computeTabLabel } from "@/utils/tab-name"

export function FileVisual(props: { path: string; active?: boolean; otherPaths?: string[] }): JSX.Element {
  const label = createMemo(() => {
    if (props.otherPaths && props.otherPaths.length > 0) {
      return computeTabLabel(props.path, props.otherPaths)
    }
    // Fallback: just use the filename
    const parts = props.path.replace(/[\/\\]+$/, "").split(/[\/\\]/)
    return parts[parts.length - 1] ?? ""
  })

  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="text-14-medium truncate">{label()}</span>
    </div>
  )
}

export function SortableTab(props: { tab: string; onTabClose: (tab: string) => void; allTabs?: string[] }): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const otherPaths = createMemo(() => {
    const myPath = path()
    if (!myPath || !props.allTabs) return []
    return props.allTabs
      .filter((t) => t !== props.tab)
      .map((t) => file.pathFromTab(t))
      .filter((p): p is string => !!p && p !== myPath)
  })
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} otherPaths={otherPaths()} />
  })

  let wrapperRef: HTMLDivElement | undefined
  const [clipped, setClipped] = createSignal(false)

  const checkClipped = () => {
    const el = wrapperRef
    if (!el) return
    const list = el.closest('[data-slot="tabs-list"]') as HTMLElement | null
    if (!list) return
    const elRect = el.getBoundingClientRect()
    const stickyRight = list.querySelector('.sticky.right-0') as HTMLElement | null
    const rightBound = stickyRight ? stickyRight.getBoundingClientRect().left : list.getBoundingClientRect().right
    setClipped(elRect.right > rightBound + 2)
  }

  return (
    <div
      ref={wrapperRef}
      use:sortable
      class="h-full flex items-center"
      classList={{ "opacity-0": sortable.isActiveDraggable }}
      onMouseEnter={checkClipped}
      onMouseLeave={() => setClipped(false)}
    >
      <div class="relative">
        <Tabs.Trigger
          value={props.tab}
          closeButton={
            <TooltipKeybind
              title={language.t("common.closeTab")}
              keybind={command.keybind("tab.close")}
              placement="bottom"
              gutter={10}
            >
              <IconButton
                icon="close-small"
                variant="ghost"
                class="h-5 w-5"
                onClick={() => props.onTabClose(props.tab)}
                aria-label={language.t("common.closeTab")}
              />
            </TooltipKeybind>
          }
          hideCloseButton
          onMiddleClick={() => props.onTabClose(props.tab)}
        >
          <Show when={content()}>{(value) => value()}</Show>
        </Tabs.Trigger>
        {/* Overlay close button for clipped tabs */}
        <Show when={clipped()}>
          <div
            class="absolute right-0 top-0 bottom-0 flex items-center z-10"
            style={{
              background: "linear-gradient(to right, transparent, var(--background-stronger) 40%)",
              "padding-left": "16px",
              "padding-right": "2px",
            }}
          >
            <IconButton
              icon="close-small"
              variant="ghost"
              class="h-5 w-5"
              onClick={() => props.onTabClose(props.tab)}
              aria-label={language.t("common.closeTab")}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}
