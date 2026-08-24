import { test, expect } from "../fixtures"
import { clickListItem, closeDialog, openSettings } from "../actions"

test("connecting a provider updates the active project immediately", async ({ page, sdk, gotoSession }) => {
  await sdk.auth.remove({ providerID: "anthropic" }).catch(() => undefined)

  try {
    await gotoSession()

    const settings = await openSettings(page)
    await settings.getByRole("tab", { name: "Providers" }).click()

    const connected = page.locator('[data-component="connected-providers-section"]')
    await expect(connected.getByText("Anthropic", { exact: true })).toHaveCount(0)

    await settings.getByRole("button", { name: "Show more providers" }).click()

    const picker = page.getByRole("dialog").filter({ has: page.getByPlaceholder("Search providers") })
    await clickListItem(picker, { key: "anthropic" })

    const dialog = page.getByRole("dialog").filter({ has: page.getByLabel("Anthropic API key") })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Anthropic API key").fill("e2e-anthropic-key")
    await dialog.getByRole("button", { name: "Continue" }).click()
    await expect(dialog).toHaveCount(0)

    await expect(connected.getByText("Anthropic", { exact: true })).toHaveCount(1)

    await closeDialog(page, picker)
    await expect(connected.getByText("Anthropic", { exact: true })).toBeVisible()
    await closeDialog(page, settings)
  } finally {
    await sdk.auth.remove({ providerID: "anthropic" }).catch(() => undefined)
  }
})
