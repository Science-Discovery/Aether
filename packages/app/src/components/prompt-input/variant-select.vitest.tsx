import { afterEach, expect, test } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { cycleModelVariant, resolveModelVariant } from "@/context/model-variant"
import { VariantSelect } from "./variant-select"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()))

function setup() {
  const host = document.createElement("div")
  document.body.append(host)
  const [state, set] = createStore({
    variants: ["none", "default", "low", "high"],
    selected: null as string | null,
    configured: "high",
  })
  const dispose = render(
    () => (
      <VariantSelect
        variants={state.variants}
        current={resolveModelVariant(state)}
        label="Default"
        provider="Groq"
        onSelect={(value) => set("selected", value ?? null)}
      />
    ),
    host,
  )
  cleanup.push(() => {
    dispose()
    host.remove()
  })
  const trigger = () => host.querySelector<HTMLButtonElement>("[data-action=prompt-model-variant]")!
  const open = async () => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const select = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) => item.textContent === label)
    expect(item).toBeDefined()
    item!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { state, set, trigger, open, select }
}

test("distinguishes automatic defaults from a provider's literal default effort", async () => {
  const value = setup()
  expect(value.trigger().textContent).toBe("Default")
  await value.open()
  expect([...document.querySelectorAll("[role=option]")].map((item) => item.textContent)).toEqual([
    "Default",
    "none",
    "default (Groq)",
    "low",
    "high",
  ])
  await value.select("default (Groq)")
  expect(value.state.selected).toBe("default")
  expect(resolveModelVariant(value.state)).toBe("default")
  expect(value.trigger().textContent).toBe("default (Groq)")

  await value.open()
  await value.select("Default")
  expect(value.state.selected).toBeNull()
  expect(resolveModelVariant(value.state)).toBeUndefined()
  expect(value.trigger().textContent).toBe("Default")
})

test("tracks refreshed effort options and keyboard cycling without reserving provider names", async () => {
  const value = setup()
  value.set("selected", "none")
  value.set("selected", cycleModelVariant(value.state) ?? null)
  expect(value.state.selected).toBe("default")
  expect(value.trigger().textContent).toBe("default (Groq)")
  value.set("selected", cycleModelVariant(value.state) ?? null)
  expect(value.state.selected).toBe("low")

  value.set("variants", ["default", "automatic", "effort:default"])
  expect(value.trigger().textContent).toBe("Default")
  await value.open()
  await value.select("automatic")
  expect(value.state.selected).toBe("automatic")
  expect(value.trigger().textContent).toBe("automatic")
  await value.open()
  await value.select("effort:default")
  expect(value.state.selected).toBe("effort:default")
  value.set("selected", cycleModelVariant(value.state) ?? null)
  expect(value.state.selected).toBeNull()
  expect(value.trigger().textContent).toBe("Default")
})
