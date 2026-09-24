import { test, expect, type Page } from "../fixtures"
import { promptSelector } from "../selectors"
import { sessionIDFromUrl } from "../actions"
import { writeFile } from "node:fs/promises"
import path from "node:path"

const rateLimitBody = { error: { message: "您的账户已达到速率限制，请您控制请求频率" } }
const certificateBody = { error: { message: "unknown certificate verification error" } }
const card = "[data-slot='session-turn-assistant-content'] .error-card"
const banner = "[data-slot='session-turn-retry']"

async function send(page: Page, text: string) {
  await page.locator(promptSelector).click()
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
}

async function stop(page: Page) {
  await page.locator(promptSelector).click()
  await page.keyboard.press("Escape")
  await expect(page.locator(banner)).toHaveCount(0, { timeout: 30_000 })
}

async function textBelowCard(page: Page, reference: string) {
  return page.evaluate((reference) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let ref: Element | undefined
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(reference)) {
        ref = node.parentElement!
        break
      }
    }
    const card = document.querySelector(".error-card")
    if (!ref || !card) return false
    return !!(card.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING)
  }, reference)
}

async function disableMemory(directory: string) {
  await writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      memory: { enabled: false, dailyReflect: { enabled: false } },
    }),
  )
}

test("rate limit banner clears after recovery and the error stays inline in history", async ({
  page,
  project,
  assistant,
  llm,
}) => {
  test.setTimeout(420_000)
  await project.open({ setup: disableMemory })

  for (let i = 0; i < 30; i++) await assistant.error(429, rateLimitBody)
  await send(page, "e2e rate limit prompt")
  await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })
  const sessionID = sessionIDFromUrl(page.url())
  if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)
  project.trackSession(sessionID)

  await expect(page.locator(banner)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(card)).toContainText("您的账户已达到速率限制，请您控制请求频率", { timeout: 120_000 })
  await llm.reset()
  await stop(page)

  await expect(page.locator(card)).toHaveCount(1)

  await assistant.reply("recovered after rate limit")
  await send(page, "e2e rate limit follow up")
  await expect(page.getByText("recovered after rate limit")).toBeVisible({ timeout: 90_000 })

  await expect(page.locator(banner)).toHaveCount(0)
  await expect(page.locator(card)).toHaveCount(1)
  expect(await textBelowCard(page, "recovered after rate limit")).toBe(true)
})

test("certificate error card stays in history below the recovered conversation", async ({
  page,
  project,
  assistant,
  llm,
}) => {
  test.skip(!!process.env.CI, "conn-kind errors back off 30s/60s/120s and outrun slow CI runners; run locally")
  test.setTimeout(420_000)
  await project.open({ setup: disableMemory })

  for (let i = 0; i < 30; i++) await assistant.error(429, certificateBody)
  await send(page, "e2e certificate prompt")
  await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })
  const sessionID = sessionIDFromUrl(page.url())
  if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)
  project.trackSession(sessionID)

  await expect(page.locator(card)).toContainText("unknown certificate verification error", { timeout: 300_000 })
  await llm.reset()
  await stop(page)

  await expect(page.locator(card)).toHaveCount(1)

  await assistant.reply("recovered after certificate error")
  await send(page, "e2e certificate follow up")
  await expect(page.getByText("recovered after certificate error")).toBeVisible({ timeout: 90_000 })

  await expect(page.locator(banner)).toHaveCount(0)
  await expect(page.locator(card)).toHaveCount(1)
  expect(await textBelowCard(page, "recovered after certificate error")).toBe(true)
})
