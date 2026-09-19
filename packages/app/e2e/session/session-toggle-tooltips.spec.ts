import { test, expect } from "../fixtures"

const cases = [
  { panel: "terminal-panel", open: "Open terminal", close: "Close terminal" },
  { panel: "review-panel", open: "Open review", close: "Close review" },
  { panel: "file-tree-panel", open: "Open file tree", close: "Close file tree" },
]

test.describe("session toggle tooltips", () => {
  for (const { panel, open, close } of cases) {
    test(`tooltip reflects ${panel} state`, async ({ page, gotoSession }) => {
      await gotoSession()

      const button = page.locator(`[aria-controls="${panel}"]`)
      await expect(button).toBeVisible()

      if ((await button.getAttribute("aria-expanded")) === "true") {
        await button.click()
      }
      await expect(button).toHaveAttribute("aria-expanded", "false")

      await button.hover()
      await expect(page.locator('[data-component="tooltip"]').filter({ hasText: open })).toBeVisible()

      await button.click()
      await expect(button).toHaveAttribute("aria-expanded", "true")

      await page.mouse.move(0, 0)
      await button.hover()
      await expect(page.locator('[data-component="tooltip"]').filter({ hasText: close })).toBeVisible()

      await button.click()
      await expect(button).toHaveAttribute("aria-expanded", "false")
    })
  }
})
