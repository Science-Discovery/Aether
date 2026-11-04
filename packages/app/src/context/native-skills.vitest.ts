import { describe, expect, test } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeCodexSkills } from "@opencode-ai/sdk/v2"
import { createNativeSkills } from "./native-skills"

const catalog = (name: string): NativeCodexSkills => ({
  state: "ready",
  skills: [{ name, path: `/${name}/SKILL.md`, description: name }],
  errors: [],
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("Codex skills catalog", () => {
  test("loads lazily and refreshes explicitly without reloading on each popup", async () => {
    let dispose!: VoidFunction
    const calls: boolean[] = []
    const value = createRoot((cleanup) => {
      dispose = cleanup
      const [state, setState] = createStore({ active: false })
      const skills = createNativeSkills({
        key: () => "server/project",
        active: () => state.active,
        read: async (refresh) => {
          calls.push(refresh)
          return catalog("a")
        },
      })
      return { skills, setState }
    })
    expect(calls).toEqual([])
    value.setState("active", true)
    await tick()
    expect(calls).toEqual([false])
    value.setState("active", false)
    value.setState("active", true)
    await tick()
    expect(calls).toEqual([false])
    await value.skills.refresh()
    expect(calls).toEqual([false, true])
    dispose()
  })
  test("late catalog responses cannot cross server, project or backend boundaries", async () => {
    let dispose!: VoidFunction
    let resolve!: (value: NativeCodexSkills) => void
    const waiting = new Promise<NativeCodexSkills>((yes) => {
      resolve = yes
    })
    const value = createRoot((cleanup) => {
      dispose = cleanup
      const [state, setState] = createStore({ key: "old" })
      return {
        setState,
        skills: createNativeSkills({
          key: () => state.key,
          active: () => true,
          read: () => (state.key === "old" ? waiting : Promise.resolve(catalog("new"))),
        }),
      }
    })
    value.setState("key", "new")
    await tick()
    resolve(catalog("old"))
    await tick()
    expect(value.skills.data()?.skills[0].name).toBe("new")
    value.setState("key", "")
    await tick()
    expect(value.skills.data()).toBeUndefined()
    dispose()
  })
  test("discovery failure is visible and preserves no stale selectable skills", async () => {
    let dispose!: VoidFunction
    let fail = false
    const value = createRoot((cleanup) => {
      dispose = cleanup
      return createNativeSkills({
        key: () => "scope",
        active: () => true,
        read: async () => {
          if (fail) throw new Error("offline")
          return catalog("a")
        },
      })
    })
    await tick()
    fail = true
    await value.refresh()
    expect(value.error()).toBe("offline")
    expect(value.data()).toBeUndefined()
    expect(value.loading()).toBe(false)
    dispose()
  })
})
