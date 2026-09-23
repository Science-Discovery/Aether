import { batch, createEffect, createMemo, on } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

type TurnCollapseInput = {
  session: () => string | undefined
  ready: () => boolean
  rendered: () => string[]
  turns: () => string[]
}

const folded = (ids: string[]) => Object.fromEntries(ids.map((item) => [item, true] as const))

export function createTurnCollapse(input: TurnCollapseInput) {
  const [state, setState] = createStore({
    session: "",
    done: false,
    mode: {} as Record<string, "default" | "open" | "closed">,
    prev: {} as Record<string, string[]>,
    tail: {} as Record<string, string | undefined>,
    map: {} as Record<string, Record<string, true>>,
  })

  createEffect(
    on(input.session, (id) => {
      setState({ session: id ?? "", done: false })
      if (!id) return
      setState("mode", id, "default")
      setState("prev", id, [])
      setState("tail", id, undefined)
      setState("map", id, reconcile({}))
    }),
  )

  createEffect(() => {
    const id = input.session()
    if (!id || !input.ready() || state.session !== id || state.done) return
    const ids = input.turns()
    const tail = ids[ids.length - 1]
    batch(() => {
      setState(
        "map",
        id,
        reconcile(Object.fromEntries(ids.filter((item) => item !== tail).map((item) => [item, true] as const))),
      )
      setState("prev", id, input.rendered().slice())
      setState("tail", id, tail)
      setState("done", true)
    })
  })

  createEffect(() => {
    const id = input.session()
    if (!id || !input.ready() || state.session !== id || !state.done) return
    const prev = state.prev[id] ?? []
    const next = input.rendered()
    if (prev.length === next.length && prev.every((item, idx) => item === next[idx])) return
    setState("prev", id, next.slice())
    if (next.length <= prev.length) return
    const off = next.length - prev.length
    if (!prev.every((item, idx) => item === next[idx + off])) return
    if ((state.mode[id] ?? "default") === "open") return
    const ids = input.turns()
    const tail = ids[ids.length - 1]
    const seen = new Set(ids)
    const add = next.slice(0, off).filter((item) => seen.has(item) && item !== tail)
    if (add.length === 0) return
    setState("map", id, reconcile({ ...(state.map[id] ?? {}), ...folded(add) }))
  })

  createEffect(() => {
    const id = input.session()
    if (!id || !input.ready() || state.session !== id || !state.done) return
    if ((state.mode[id] ?? "default") !== "default") return
    const ids = input.turns()
    const tail = ids[ids.length - 1]
    if (!tail || state.tail[id] === tail) return
    setState("tail", id, tail)
    const map = state.map[id]
    if (!map?.[tail]) return
    const next = { ...map }
    delete next[tail]
    setState("map", id, reconcile(next))
  })

  const collapsed = createMemo(() => {
    const id = input.session()
    if (!id) return {}
    return state.map[id] ?? {}
  })

  return {
    is: (messageID: string) => !!collapsed()[messageID],
    set: (messageID: string, value: boolean) => {
      const id = input.session()
      if (!id) return
      const current = state.map[id] ?? {}
      if (value) {
        setState("map", id, reconcile({ ...current, [messageID]: true }))
        return
      }
      if (!current[messageID]) return
      const next = { ...current }
      delete next[messageID]
      setState("map", id, reconcile(next))
    },
    all: () => {
      const id = input.session()
      if (!id) return
      setState("mode", id, "closed")
      setState("map", id, reconcile(folded(input.turns())))
    },
    none: () => {
      const id = input.session()
      if (!id) return
      setState("mode", id, "open")
      setState("map", id, reconcile({}))
    },
  }
}
