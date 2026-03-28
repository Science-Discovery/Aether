import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"

type Find = {
  root: () => HTMLElement | undefined
  active?: () => boolean
}

const all = "opencode-chat-find"
const cur = "opencode-chat-find-current"
const styleID = "opencode-chat-find-style"

function editable(node: unknown) {
  if (!(node instanceof HTMLElement)) return false
  if (node.isContentEditable) return true
  if (node.closest("[contenteditable='true']")) return true
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName)
}

function owns(root: HTMLElement | undefined, node: unknown) {
  if (!root) return false
  if (!(node instanceof Node)) return false
  return root.contains(node)
}

function clearMarks() {
  const css = (globalThis as { CSS?: { highlights?: { delete: (name: string) => void } } }).CSS?.highlights
  if (!css) return
  css.delete(all)
  css.delete(cur)
}

function style() {
  if (typeof document === "undefined") return
  if (document.getElementById(styleID)) return
  const el = document.createElement("style")
  el.id = styleID
  el.textContent = `
::highlight(${all}) {
  background-color: rgb(from var(--surface-warning-base) r g b / 0.35);
}

::highlight(${cur}) {
  background-color: rgb(from var(--surface-warning-strong) r g b / 0.55);
}
`
  document.head.appendChild(el)
}

export function chatRanges(root: HTMLElement, text: string) {
  const q = text.toLowerCase()
  const out: Range[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walk.nextNode()

  while (node) {
    if (node instanceof Text && node.data) {
      const p = node.parentElement
      if (p && !editable(p) && !p.closest("[data-chat-find-ignore]")) {
        const hay = node.data.toLowerCase()
        let i = hay.indexOf(q)
        while (i !== -1) {
          const r = document.createRange()
          r.setStart(node, i)
          r.setEnd(node, i + text.length)
          out.push(r)
          i = hay.indexOf(q, i + text.length)
        }
      }
    }
    node = walk.nextNode()
  }

  return out
}

function jump(range: Range) {
  const n = range.startContainer
  const el = n instanceof Element ? n : n.parentElement
  el?.scrollIntoView({ block: "center", inline: "nearest" })
}

function paint(list: Range[], i: number) {
  const css = (globalThis as unknown as { CSS?: { highlights?: any }; Highlight?: any }).CSS?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: any }).Highlight
  if (!css || typeof Highlight !== "function") return

  css.delete(all)
  css.delete(cur)

  const active = list[i]
  if (active) css.set(cur, new Highlight(active))

  const rest = list.filter((_, idx) => idx !== i)
  if (rest.length > 0) css.set(all, new Highlight(...rest))
}

export function createChatFind(input: Find) {
  let ref: HTMLInputElement | undefined
  let list: Range[] = []
  let frame: number | undefined

  const [state, setState] = createStore({
    open: false,
    query: "",
    index: 0,
    count: 0,
    pos: { top: 8, right: 8 },
  })

  const open = () => state.open
  const query = () => state.query
  const index = () => state.index
  const count = () => state.count
  const pos = () => state.pos
  const enabled = () => input.active?.() ?? true

  const clear = () => {
    list = []
    setState("count", 0)
    setState("index", 0)
    clearMarks()
  }

  const place = () => {
    const root = input.root()
    if (!root) return
    const box = root.getBoundingClientRect()
    const raw = parseFloat(getComputedStyle(root).getPropertyValue("--session-title-height"))
    const head = Number.isNaN(raw) ? 0 : raw
    setState("pos", {
      top: Math.round(box.top) + head - 4,
      right: Math.round(window.innerWidth - box.right) + 8,
    })
  }

  const apply = (opts?: { reset?: boolean; scroll?: boolean }) => {
    if (!open()) return
    const q = query().trim()
    if (!q) {
      clear()
      return
    }

    const root = input.root()
    if (!root) return

    list = chatRanges(root, q)
    const n = list.length
    const i = n ? Math.min(opts?.reset ? 0 : index(), n - 1) : 0
    setState("count", n)
    setState("index", i)
    paint(list, i)

    if (!opts?.scroll) return
    const r = list[i]
    if (r) jump(r)
  }

  const schedule = (opts?: { reset?: boolean; scroll?: boolean }) => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      apply(opts)
    })
  }

  const close = () => {
    setState("open", false)
    setState("query", "")
    clear()
  }

  const focus = () => {
    if (!enabled()) return
    if (!open()) setState("open", true)
    requestAnimationFrame(() => {
      place()
      apply({ scroll: true })
      ref?.focus()
      ref?.select()
    })
  }

  const next = (dir: 1 | -1) => {
    if (!open()) return
    const n = count()
    if (n <= 0) return
    const i = (index() + dir + n) % n
    setState("index", i)
    paint(list, i)
    const r = list[i]
    if (r) jump(r)
  }

  onMount(() => {
    style()

    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!enabled()) return
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey) return

      const root = input.root()
      const scope = owns(root, event.target) || owns(root, document.activeElement)
      const k = event.key.toLowerCase()

      if (k === "f") {
        if (!scope) return
        if (editable(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        focus()
        return
      }

      if (k !== "g") return
      if (!open()) return
      if (!scope) return
      event.preventDefault()
      event.stopPropagation()
      next(event.shiftKey ? -1 : 1)
    }

    window.addEventListener("keydown", key, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", key, { capture: true }))
  })

  createEffect(() => {
    if (!open()) return

    place()
    const resize = () => place()
    window.addEventListener("resize", resize, { passive: true })

    const root = input.root()
    const watch = typeof ResizeObserver === "undefined" || !root ? undefined : new ResizeObserver(() => place())
    if (watch && root) watch.observe(root)

    onCleanup(() => {
      window.removeEventListener("resize", resize)
      watch?.disconnect()
    })
  })

  createEffect(() => {
    if (!open()) return
    schedule({ scroll: false })
  })

  createEffect(() => {
    if (!open()) return
    const root = input.root()
    if (!root) return

    const watch = new MutationObserver(() => schedule())
    watch.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    onCleanup(() => watch.disconnect())
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearMarks()
  })

  return {
    open,
    query,
    index,
    count,
    pos,
    setInput: (el: HTMLInputElement) => {
      ref = el
    },
    setQuery: (value: string) => {
      setState("query", value)
      setState("index", 0)
      apply({ reset: true, scroll: true })
    },
    close,
    next,
    onInputKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== "Enter") return
      event.preventDefault()
      next(event.shiftKey ? -1 : 1)
    },
  }
}

export function ChatFindBar(props: {
  find: ReturnType<typeof createChatFind>
  text: {
    placeholder: string
    prev: string
    next: string
    close: string
  }
}) {
  const label = createMemo(() => (props.find.count() ? `${props.find.index() + 1}/${props.find.count()}` : "0/0"))

  return (
    <Portal>
      <div
        class="fixed z-50 flex h-8 items-center gap-2 rounded-md border border-border-base bg-background-base px-3 shadow-md"
        style={{
          top: `${props.find.pos().top}px`,
          right: `${props.find.pos().right}px`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Icon name="magnifying-glass" size="small" class="text-text-weak shrink-0" />
        <input
          ref={props.find.setInput}
          placeholder={props.text.placeholder}
          value={props.find.query()}
          class="w-44 bg-transparent outline-none text-14-regular text-text-strong placeholder:text-text-weak"
          onInput={(e) => props.find.setQuery(e.currentTarget.value)}
          onKeyDown={(e) => props.find.onInputKeyDown(e as KeyboardEvent)}
        />
        <div class="shrink-0 text-12-regular text-text-weak tabular-nums text-right" style={{ width: "10ch" }}>
          {label()}
        </div>
        <div class="flex items-center">
          <button
            type="button"
            class="size-6 grid place-items-center rounded text-text-weak hover:bg-surface-base-hover hover:text-text-strong disabled:opacity-40 disabled:pointer-events-none"
            disabled={props.find.count() === 0}
            aria-label={props.text.prev}
            onClick={() => props.find.next(-1)}
          >
            <Icon name="chevron-down" size="small" class="rotate-180" />
          </button>
          <button
            type="button"
            class="size-6 grid place-items-center rounded text-text-weak hover:bg-surface-base-hover hover:text-text-strong disabled:opacity-40 disabled:pointer-events-none"
            disabled={props.find.count() === 0}
            aria-label={props.text.next}
            onClick={() => props.find.next(1)}
          >
            <Icon name="chevron-down" size="small" />
          </button>
        </div>
        <button
          type="button"
          class="size-6 grid place-items-center rounded text-text-weak hover:bg-surface-base-hover hover:text-text-strong"
          aria-label={props.text.close}
          onClick={props.find.close}
        >
          <Icon name="close-small" size="small" />
        </button>
      </div>
    </Portal>
  )
}
