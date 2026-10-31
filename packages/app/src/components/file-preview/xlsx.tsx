import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { label, type Cell, type Reply, type Request, type Sheet, type Window } from "./xlsx-types"
import { text } from "./xlsx-text"
import "./xlsx.css"

function Grid(props: {
  sheet: Sheet
  cells: Cell[]
  images: Record<string, string>
  request: (range: Window) => void
}) {
  const language = useLanguage()
  let viewport!: HTMLDivElement
  const rows = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.sheet.rows.count
    },
    getScrollElement: () => viewport,
    estimateSize: (index) => props.sheet.rows.custom[index + 1] ?? props.sheet.rows.size,
    overscan: 3,
    paddingStart: 28,
  })
  const columns = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    horizontal: true,
    get count() {
      return props.sheet.columns.count
    },
    getScrollElement: () => viewport,
    estimateSize: (index) => props.sheet.columns.custom[index + 1] ?? props.sheet.columns.size,
    overscan: 2,
    paddingStart: 48,
  })
  const visible = createMemo(() => ({
    sheet: props.sheet.id,
    rows: rows
      .getVirtualItems()
      .filter((row) => row.size > 0)
      .map((row) => row.index + 1),
    columns: columns
      .getVirtualItems()
      .filter((column) => column.size > 0)
      .map((column) => column.index + 1),
  }))
  createEffect(() => {
    const range = visible()
    if (range.rows.length && range.columns.length) props.request(range)
  })
  const pictures = createMemo(() => {
    const vertical = rows.getVirtualItems()
    const horizontal = columns.getVirtualItems()
    if (!vertical.length || !horizontal.length) return []
    return props.sheet.images.filter(
      (image) =>
        image.top + image.height + 28 >= vertical[0].start &&
        image.top + 28 <= vertical.at(-1)!.end &&
        image.left + image.width + 48 >= horizontal[0].start &&
        image.left + 48 <= horizontal.at(-1)!.end,
    )
  })
  return (
    <div
      ref={viewport}
      class="xlsx-viewport"
      role="grid"
      tabIndex={0}
      aria-label={`${text(language.locale()).grid}: ${props.sheet.name}`}
      aria-rowcount={props.sheet.rows.count}
      aria-colcount={props.sheet.columns.count}
    >
      <div class="xlsx-canvas" style={{ width: `${columns.getTotalSize()}px`, height: `${rows.getTotalSize()}px` }}>
        <div class="xlsx-columns" role="row">
          <For each={columns.getVirtualItems().filter((column) => column.size > 0)}>
            {(column) => (
              <div
                class="xlsx-heading"
                role="columnheader"
                aria-colindex={column.index + 1}
                style={{ left: `${column.start}px`, width: `${column.size}px` }}
              >
                {label(column.index + 1)}
              </div>
            )}
          </For>
          <div class="xlsx-corner" />
        </div>
        <div class="xlsx-rows">
          <For each={rows.getVirtualItems().filter((row) => row.size > 0)}>
            {(row) => (
              <div
                class="xlsx-heading"
                role="rowheader"
                aria-rowindex={row.index + 1}
                style={{ top: `${row.start - 28}px`, height: `${row.size}px` }}
              >
                {row.index + 1}
              </div>
            )}
          </For>
        </div>
        <For each={props.cells}>
          {(cell) => (
            <div
              class="xlsx-cell"
              role="gridcell"
              aria-rowindex={cell.row}
              aria-colindex={cell.column}
              aria-rowspan={cell.rows > 1 ? cell.rows : undefined}
              aria-colspan={cell.columns > 1 ? cell.columns : undefined}
              data-address={cell.address}
              data-unformatted={cell.unformatted ? "true" : undefined}
              title={`${cell.address}: ${cell.missing ? text(language.locale()).uncalculated : cell.text}${cell.formula ? `\n=${cell.formula}` : ""}`}
              style={{
                ...cell.style,
                top: `${cell.top + 28}px`,
                left: `${cell.left + 48}px`,
                width: `${cell.width}px`,
                height: `${cell.height}px`,
              }}
            >
              <span class="xlsx-value">
                <Show
                  when={cell.missing}
                  fallback={
                    <Show when={cell.runs} fallback={cell.text}>
                      {(runs) => <For each={runs()}>{(run) => <span style={run.style}>{run.text}</span>}</For>}
                    </Show>
                  }
                >
                  <span class="xlsx-formula">={cell.formula}</span>
                  <span class="xlsx-uncalculated"> ({text(language.locale()).uncalculated})</span>
                </Show>
              </span>
            </div>
          )}
        </For>
        <For each={pictures()}>
          {(image) => (
            <img
              class="xlsx-image"
              src={props.images[image.id]}
              alt={text(language.locale()).image}
              draggable={false}
              style={{
                top: `${image.top + 28}px`,
                left: `${image.left + 48}px`,
                width: `${image.width}px`,
                height: `${image.height}px`,
              }}
            />
          )}
        </For>
      </div>
    </div>
  )
}

export default function Xlsx(props: { data: ArrayBuffer; path: string; onError: (error: unknown) => void }) {
  const language = useLanguage()
  const [state, setState] = createStore({
    sheets: [] as Sheet[],
    sheet: 0,
    cells: [] as Cell[],
    images: {} as Record<string, string>,
    loading: true,
    formatting: false,
  })
  const current = createMemo(() => state.sheets.find((sheet) => sheet.id === state.sheet))
  let worker: Worker | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  let pending: Window | undefined
  let sequence = 0
  let active = 0
  let busy = false
  let closed = false
  const urls: string[] = []
  const stop = () => {
    closed = true
    worker?.terminate()
    worker = undefined
    clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    urls.splice(0).forEach((url) => URL.revokeObjectURL(url))
  }
  const fail = (error: unknown) => {
    if (closed) return
    stop()
    props.onError(error)
  }
  const post = (request: Request, transfers: Transferable[] = []) => {
    if (!worker || closed) return
    active = request.id
    busy = true
    clearTimeout(timer)
    timer = setTimeout(() => fail(new Error(text(language.locale()).timeout)), 30_000)
    worker.postMessage(request, transfers)
  }
  const dispatch = () => {
    if (busy || !pending || closed) return
    const input = pending
    pending = undefined
    post({ id: ++sequence, type: "range", ...input })
  }
  const request = (input: Window) => {
    pending = input
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      dispatch()
    })
  }
  onMount(() => {
    try {
      worker = new Worker(new URL("./xlsx-worker.ts", import.meta.url), { type: "module" })
    } catch (error) {
      fail(error)
      return
    }
    worker.onmessage = (event: MessageEvent<Reply>) => {
      if (closed || event.data.id !== active) return
      clearTimeout(timer)
      busy = false
      const reply = event.data
      if (reply.type === "error") {
        fail(new Error(reply.message))
        return
      }
      if (reply.type === "loaded") {
        const images = Object.fromEntries(
          reply.images.map((image) => {
            const url = URL.createObjectURL(new Blob([image.data], { type: image.mime }))
            urls.push(url)
            return [image.id, url]
          }),
        )
        setState({ sheets: reply.sheets, sheet: reply.sheets[0]?.id ?? 0, images, loading: false })
        return
      }
      if (!pending && reply.sheet === state.sheet)
        setState({ cells: reply.cells, formatting: state.formatting || reply.cells.some((cell) => cell.unformatted) })
      dispatch()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      fail(new Error(text(language.locale()).failed))
    }
    worker.onmessageerror = () => fail(new Error(text(language.locale()).failed))
    // The parent owns its buffer for retries. Only transfer our worker's copy.
    const data = props.data.slice(0)
    post({ type: "load", id: ++sequence, data }, [data])
  })
  onCleanup(stop)
  return (
    <div class="xlsx-preview" data-component="xlsx-preview" data-file-content>
      <Show
        when={state.loading}
        fallback={
          <>
            <Show when={state.formatting}>
              <div class="xlsx-warning" role="status">
                {text(language.locale()).formatting}
              </div>
            </Show>
            <Show when={current()} keyed>
              {(sheet) => <Grid sheet={sheet} cells={state.cells} images={state.images} request={request} />}
            </Show>
            <div class="xlsx-sheets" role="tablist" aria-label={text(language.locale()).sheets}>
              <For each={state.sheets}>
                {(sheet) => (
                  <button
                    role="tab"
                    type="button"
                    aria-selected={sheet.id === state.sheet}
                    title={sheet.name}
                    onClick={() => {
                      if (state.sheet === sheet.id) return
                      pending = undefined
                      setState({ sheet: sheet.id, cells: [] })
                    }}
                  >
                    {sheet.name}
                  </button>
                )}
              </For>
            </div>
            <div
              class="shrink-0 truncate border-t border-border-weak-base px-3 py-1 text-xs text-text-weak"
              title={text(language.locale()).limitations}
            >
              {text(language.locale()).readonly}
            </div>
          </>
        }
      >
        <div class="xlsx-loading" role="status">
          <span>{text(language.locale()).loading}</span>
          <Button size="small" variant="ghost" onClick={() => fail(new Error(text(language.locale()).cancelled))}>
            {text(language.locale()).cancel}
          </Button>
        </div>
      </Show>
    </div>
  )
}
