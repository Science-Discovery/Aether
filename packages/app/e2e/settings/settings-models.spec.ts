import type { Locator } from "@playwright/test"
import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { closeDialog, openSettings } from "../actions"

async function state(list: Locator, values: boolean[]) {
  await expect(list).toHaveCount(values.length)
  await Promise.all(
    values.map((value, index) =>
      expect(list.nth(index).locator('[data-slot="switch-input"]')).toHaveAttribute(
        "aria-checked",
        String(value),
      ),
    ),
  )
}

test("hiding a model removes it from the model picker", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")

  const command = page.locator('[data-slash-id="model.choose"]')
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const picker = page.getByRole("dialog")
  await expect(picker).toBeVisible()

  const target = picker.locator('[data-slot="list-item"]').first()
  await expect(target).toBeVisible()

  const key = await target.getAttribute("data-key")
  if (!key) throw new Error("Failed to resolve model key from list item")

  const name = (await target.locator("span").first().innerText()).trim()
  if (!name) throw new Error("Failed to resolve model name from list item")

  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)

  const settings = await openSettings(page)

  await settings.getByRole("tab", { name: "Models" }).click()
  const search = settings.getByPlaceholder("Search models")
  await expect(search).toBeVisible()
  await search.fill(name)

  const toggle = settings.locator('[data-component="switch"]').filter({ hasText: name }).first()
  const input = toggle.locator('[data-slot="switch-input"]')
  await expect(toggle).toBeVisible()
  await expect(input).toHaveAttribute("aria-checked", "true")
  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "false")

  await closeDialog(page, settings)

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const pickerAgain = page.getByRole("dialog")
  await expect(pickerAgain).toBeVisible()
  await expect(pickerAgain.locator('[data-slot="list-item"]').first()).toBeVisible()

  await expect(pickerAgain.locator(`[data-slot="list-item"][data-key="${key}"]`)).toHaveCount(0)

  await page.keyboard.press("Escape")
  await expect(pickerAgain).toHaveCount(0)
})

test("showing a hidden model restores it to the model picker", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")

  const command = page.locator('[data-slash-id="model.choose"]')
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const picker = page.getByRole("dialog")
  await expect(picker).toBeVisible()

  const target = picker.locator('[data-slot="list-item"]').first()
  await expect(target).toBeVisible()

  const key = await target.getAttribute("data-key")
  if (!key) throw new Error("Failed to resolve model key from list item")

  const name = (await target.locator("span").first().innerText()).trim()
  if (!name) throw new Error("Failed to resolve model name from list item")

  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)

  const settings = await openSettings(page)

  await settings.getByRole("tab", { name: "Models" }).click()
  const search = settings.getByPlaceholder("Search models")
  await expect(search).toBeVisible()
  await search.fill(name)

  const toggle = settings.locator('[data-component="switch"]').filter({ hasText: name }).first()
  const input = toggle.locator('[data-slot="switch-input"]')
  await expect(toggle).toBeVisible()
  await expect(input).toHaveAttribute("aria-checked", "true")

  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "false")

  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "true")

  await closeDialog(page, settings)

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const pickerAgain = page.getByRole("dialog")
  await expect(pickerAgain).toBeVisible()

  await expect(pickerAgain.locator(`[data-slot="list-item"][data-key="${key}"]`)).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(pickerAgain).toHaveCount(0)
})

test("provider toggle controls every model without affecting other providers", async ({ page, project }) => {
  const model = (id: string, name: string) => ({
    id,
    name,
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    tool_call: true,
    limit: { context: 1, output: 1 },
  })
  const providers = {
    all: [
      {
        id: "bulk-alpha-e2e",
        name: "Bulk Alpha E2E",
        env: [],
        models: {
          "alpha-one-e2e": model("alpha-one-e2e", "Alpha One E2E"),
          "alpha-two-e2e": model("alpha-two-e2e", "Alpha Two E2E"),
          "alpha-three-e2e": model("alpha-three-e2e", "Alpha Three E2E"),
        },
      },
      {
        id: "bulk-beta-e2e",
        name: "Bulk Beta E2E",
        env: [],
        models: {
          "beta-one-e2e": model("beta-one-e2e", "Beta One E2E"),
        },
      },
    ],
    default: {
      "bulk-alpha-e2e": "alpha-one-e2e",
      "bulk-beta-e2e": "beta-one-e2e",
    },
    connected: ["bulk-alpha-e2e", "bulk-beta-e2e"],
  }

  await page.route(/\/provider(?:\?.*)?$/, (route) => route.fulfill({ json: providers }))
  await project.open()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Models" }).click()

  const group = settings.locator(
    '[data-component="settings-model-provider"][data-provider="bulk-alpha-e2e"]',
  )
  const other = settings.locator(
    '[data-component="settings-model-provider"][data-provider="bulk-beta-e2e"]',
  )
  await expect(group).toBeVisible()
  await expect(other).toBeVisible()

  const bulk = group.locator('[data-action="toggle-provider-models"]')
  const input = bulk.getByRole("switch", { name: "Toggle all Bulk Alpha E2E models" })
  const rows = group.locator('[data-component="switch"]:not([data-action="toggle-provider-models"])')
  const peer = other.locator('[data-action="toggle-provider-models"]')
  const guard = peer.getByRole("switch", { name: "Toggle all Bulk Beta E2E models" })
  const rest = other.locator('[data-component="switch"]:not([data-action="toggle-provider-models"])')

  await expect(input).toHaveAccessibleName("Toggle all Bulk Alpha E2E models")
  await expect(input).toHaveAttribute("aria-checked", "true")
  await state(rows, [true, true, true])
  await expect(guard).toHaveAttribute("aria-checked", "true")
  await state(rest, [true])

  await input.focus()
  await expect(input).toBeFocused()
  await input.press("Space")
  await expect(input).toHaveAttribute("aria-checked", "false")
  await state(rows, [false, false, false])
  await expect(guard).toHaveAttribute("aria-checked", "true")
  await state(rest, [true])

  await rows.first().locator('[data-slot="switch-control"]').click()
  await state(rows, [true, false, false])
  await expect(input).toHaveAttribute("aria-checked", "false")

  await bulk.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "true")
  await state(rows, [true, true, true])

  const search = settings.getByPlaceholder("Search models")
  await search.fill("Alpha One E2E")
  await expect(group).toBeVisible()
  await state(rows, [true])

  await bulk.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "false")
  await state(rows, [false])

  await search.fill("")
  await state(rows, [false, false, false])
  await expect(guard).toHaveAttribute("aria-checked", "true")
  await state(rest, [true])

  await bulk.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", "true")
  await state(rows, [true, true, true])

  await closeDialog(page, settings)
})
