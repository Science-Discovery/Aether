import { skipSafeZoneOnboarding, withSession } from "../actions"
import { test, expect } from "../fixtures"

type Sdk = Parameters<typeof withSession>[0]

const modeLabels = {
  off: "Permissions: confirm all",
  safe: "Permissions: safe zone",
  full: "Permissions: auto-accept all",
}

const serverMode = (sdk: Sdk, sessionID: string) => sdk.session.preference.get({ sessionID }).then((r) => r.data?.mode)

test.setTimeout(120_000)

test("permission button cycles session mode through off, safe, full", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, "e2e permission mode cycle", async (session) => {
    await gotoSession(session.id)

    const button = page.locator('[data-action="prompt-permissions"]').first()
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute("aria-label", modeLabels.off)
    await expect(button).toHaveAttribute("aria-pressed", "false")

    await button.click()
    await skipSafeZoneOnboarding(page)
    await expect(button).toHaveAttribute("aria-label", modeLabels.safe)
    await expect(button).toHaveAttribute("aria-pressed", "true")
    await expect.poll(() => serverMode(sdk, session.id), { timeout: 10_000 }).toBe("safe")

    await button.click()
    await expect(button).toHaveAttribute("aria-label", modeLabels.full)
    await expect(button).toHaveAttribute("aria-pressed", "true")
    await expect.poll(() => serverMode(sdk, session.id), { timeout: 10_000 }).toBe("full")

    await button.click()
    await expect(button).toHaveAttribute("aria-label", modeLabels.off)
    await expect(button).toHaveAttribute("aria-pressed", "false")
    await expect.poll(() => serverMode(sdk, session.id), { timeout: 10_000 }).toBe("off")
  })
})
