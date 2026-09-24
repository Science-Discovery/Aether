import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { describe, expect, test } from "vitest"
import { createTurnCollapse } from "./message-collapse"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup() {
  const [src, setSrc] = createStore({
    session: undefined as string | undefined,
    ready: false,
    rendered: [] as string[],
    turns: [] as string[],
  })
  return createRoot((dispose) => {
    const collapse = createTurnCollapse({
      session: () => src.session,
      ready: () => src.ready,
      rendered: () => src.rendered,
      turns: () => src.turns,
    })
    return {
      collapse,
      set: setSrc,
      close: dispose,
    }
  })
}

describe("turn collapse", () => {
  test("snapshot waits for the message page before default-collapsing", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()
    expect(collapse.is("m1")).toBe(false)
    expect(collapse.is("m2")).toBe(false)

    set("ready", true)
    await tick()
    expect(collapse.is("m1")).toBe(true)
    expect(collapse.is("m2")).toBe(false)
    close()
  })

  test("history prepend folds loaded turns but never the tail", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", ready: true, rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()
    expect(collapse.is("m1")).toBe(true)
    expect(collapse.is("m2")).toBe(false)

    set({ rendered: ["m0", "m1", "m2"], turns: ["m0", "m1", "m2"] })
    await tick()
    expect(collapse.is("m0")).toBe(true)
    expect(collapse.is("m1")).toBe(true)
    expect(collapse.is("m2")).toBe(false)
    close()
  })

  test("newly completed latest round stays expanded", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", ready: true, rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()

    set({ rendered: ["m1", "m2", "m3"], turns: ["m1", "m2", "m3"] })
    await tick()
    expect(collapse.is("m1")).toBe(true)
    expect(collapse.is("m2")).toBe(false)
    expect(collapse.is("m3")).toBe(false)
    close()
  })

  test("manual tail collapse survives until the tail advances", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", ready: true, rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()
    collapse.set("m2", true)
    expect(collapse.is("m2")).toBe(true)

    set({ rendered: ["m1", "m2", "m3"], turns: ["m1", "m2", "m3"] })
    await tick()
    expect(collapse.is("m3")).toBe(false)
    expect(collapse.is("m2")).toBe(true)
    expect(collapse.is("m1")).toBe(true)
    close()
  })

  test("collapse all folds every turn, expand all clears and holds", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", ready: true, rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()
    collapse.all()
    expect(collapse.is("m1")).toBe(true)
    expect(collapse.is("m2")).toBe(true)

    set({ rendered: ["m0", "m1", "m2"], turns: ["m0", "m1", "m2"] })
    await tick()
    expect(collapse.is("m0")).toBe(true)

    collapse.none()
    expect(collapse.is("m0")).toBe(false)
    expect(collapse.is("m1")).toBe(false)
    expect(collapse.is("m2")).toBe(false)

    set({ rendered: ["z0", "m0", "m1", "m2"], turns: ["z0", "m0", "m1", "m2"] })
    await tick()
    expect(collapse.is("z0")).toBe(false)
    close()
  })

  test("switching sessions re-derives the default collapse", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", ready: true, rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()
    expect(collapse.is("m1")).toBe(true)

    set({ session: "s2", rendered: ["n1", "n2"], turns: ["n1", "n2"] })
    await tick()
    expect(collapse.is("n1")).toBe(true)
    expect(collapse.is("n2")).toBe(false)
    expect(collapse.is("m1")).toBe(false)

    set({ session: "s1", rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()
    expect(collapse.is("m1")).toBe(true)
    expect(collapse.is("m2")).toBe(false)
    close()
  })

  test("empty page then first arriving turn stays expanded", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", ready: true, rendered: [], turns: [] })
    await tick()

    set({ rendered: ["m1"], turns: ["m1"] })
    await tick()
    expect(collapse.is("m1")).toBe(false)
    close()
  })

  test("late tail correction expands a wrongly folded tail", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", ready: true, rendered: ["m1", "m2"], turns: ["m1", "m2"] })
    await tick()
    expect(collapse.is("m2")).toBe(false)

    collapse.set("m3", true)
    set({ rendered: ["m1", "m2", "m3"], turns: ["m1", "m2", "m3"] })
    await tick()
    expect(collapse.is("m3")).toBe(false)
    expect(collapse.is("m1")).toBe(true)
    close()
  })

  test("page arriving after a message stub does not fold the tail", async () => {
    const { collapse, set, close } = setup()
    set({ session: "s1", rendered: [], turns: ["m2"] })
    await tick()
    set({ rendered: ["m1", "m2"], turns: ["m1", "m2"], ready: true })
    await tick()
    expect(collapse.is("m1")).toBe(true)
    expect(collapse.is("m2")).toBe(false)
    close()
  })
})
