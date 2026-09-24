import fs from "node:fs/promises"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { openSidebar, setWorkspacesEnabled } from "../actions"
import { sidebarNavSelector } from "../selectors"

const runTriggerSelector = (slug: string) =>
  `${sidebarNavSelector} [data-action="workspace-run-script"][data-workspace="${slug}"]`
const tooltipSelector = '[data-component="tooltip"]'

async function addScript(directory: string) {
  const bin = path.join(directory, ".aether", ".bin")
  await fs.mkdir(bin, { recursive: true })
  const name = process.platform === "win32" ? "run.bat" : "run.sh"
  await fs.writeFile(path.join(bin, name), process.platform === "win32" ? "@echo ok\r\n" : "echo ok\n")
  return name
}

async function openWorkspaceRow(page: Page, slug: string) {
  await page.setViewportSize({ width: 1400, height: 800 })
  await openSidebar(page)
  await setWorkspacesEnabled(page, slug, true)

  const trigger = page.locator(runTriggerSelector(slug))
  await expect(trigger).toBeVisible()
  return trigger
}

async function selectScript(page: Page, trigger: Locator, name: string) {
  await trigger.click({ button: "right" })
  await page.getByRole("menuitemradio", { name }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.mouse.move(700, 400)
}

test("run button shows an adding hint on hover even with no scripts", async ({ page, withProject }) => {
  await withProject(async ({ slug }) => {
    const trigger = await openWorkspaceRow(page, slug)
    await expect(trigger.locator("button")).toBeDisabled()

    await trigger.hover()
    await expect(page.locator(tooltipSelector).filter({ hasText: "No runnable scripts" })).toBeVisible()
  })
})

test("run button reports a successful script run on hover", async ({ page, withProject }) => {
  await withProject(async ({ directory, slug }) => {
    const name = await addScript(directory)
    const trigger = await openWorkspaceRow(page, slug)

    await selectScript(page, trigger, name)
    const button = trigger.locator("button")
    await expect(button).toBeEnabled()
    await expect(button).toContainText(`Run: ${name}`)

    await button.click()
    await page.mouse.move(0, 0)
    await trigger.hover()
    await expect(page.locator(tooltipSelector).filter({ hasText: `Ran: ${name}` })).toBeVisible()
  })
})

test("run button reports launch failures on hover", async ({ page, withProject }) => {
  await withProject(async ({ directory, slug }) => {
    const name = await addScript(directory)
    const trigger = await openWorkspaceRow(page, slug)

    await selectScript(page, trigger, name)
    const button = trigger.locator("button")
    await expect(button).toBeEnabled()

    await page.route(/\/pty(\?|$)/, (route) => route.abort())
    await button.click()
    await page.mouse.move(0, 0)
    await trigger.hover()
    await expect(page.locator(tooltipSelector).filter({ hasText: `Failed to run ${name}` })).toBeVisible()
  })
})
