import { test, expect } from "../fixtures"
import { assistantText, sessionIDFromUrl } from "../actions"
import { promptSelector } from "../selectors"

test("can send a prompt and receive a reply", async ({ page, project, assistant }) => {
  test.setTimeout(120_000)

  const pageErrors: string[] = []
  const onPageError = (err: Error) => {
    pageErrors.push(err.message)
  }
  page.on("pageerror", onPageError)

  try {
    const token = `E2E_OK_${Date.now()}`
    await project.open()
    await assistant.reply(token)
    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type(`Reply with exactly: ${token}`)
    await page.keyboard.press("Enter")

    await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })
    const sessionID = sessionIDFromUrl(page.url())
    if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)
    project.trackSession(sessionID)

    await expect.poll(() => assistant.calls()).toBeGreaterThanOrEqual(1)
    await expect.poll(() => assistantText(project.sdk, sessionID), { timeout: 30_000 }).toContain(token)
  } finally {
    page.off("pageerror", onPageError)
  }

  if (pageErrors.length > 0) {
    throw new Error(`Page error(s):\n${pageErrors.join("\n")}`)
  }
})
