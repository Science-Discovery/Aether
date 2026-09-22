import { test, expect } from "../fixtures"
import { assistantText, sessionIDFromUrl, waitSessionIdle } from "../actions"
import { promptSelector } from "../selectors"
import { writeFile } from "node:fs/promises"
import path from "node:path"

const tail = "记住最后这一行"

async function timelineViewport(page: import("@playwright/test").Page) {
  return page.evaluateHandle(() => {
    const list = document.querySelector('[data-slot="session-turn-list"]')
    const view = list?.closest(".scroll-view__viewport")
    if (!(view instanceof HTMLElement)) throw new Error("timeline viewport not found")
    return view
  })
}

test("scrolled assistant output pins the user prompt tail and collapses on click", async ({
  page,
  project,
  assistant,
  llm,
}) => {
  test.setTimeout(180_000)

  const pageErrors: string[] = []
  const onPageError = (err: Error) => {
    pageErrors.push(err.message)
  }
  page.on("pageerror", onPageError)

  try {
    await project.open({
      setup: async (directory) => {
        await writeFile(
          path.join(directory, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            memory: { enabled: false, dailyReflect: { enabled: false } },
          }),
        )
      },
    })

    const body = Array.from({ length: 240 }, (_, i) => `段落 ${i + 1}：这是一段用于撑长输出的测试文本内容。`).join(
      "\n\n",
    )
    await assistant.reply(`${body}\n\n结束`)

    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type("帮我写一段很长的输出用于测试")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type(tail)
    await page.keyboard.press("Enter")

    await expect(page).toHaveURL(/\/session\/[^/?#]+/, { timeout: 30_000 })
    const sessionID = sessionIDFromUrl(page.url())
    if (!sessionID) throw new Error(`Failed to parse session id from url: ${page.url()}`)
    project.trackSession(sessionID)

    const content = page.locator('[data-slot="session-turn-assistant-content"]')
    await expect(content).toBeAttached()
    await waitSessionIdle(project.sdk, sessionID, 120_000)

    const calls = await assistant.calls()
    const misses = await llm.misses()
    if (calls < 1 || misses.length > 0) {
      const raw = await project.sdk.session.messages({ sessionID, limit: 50 }).then((r) => r.data ?? [])
      const summary = raw.map((m) => ({
        role: m.info.role,
        error: (m.info as { error?: unknown }).error,
        parts: m.parts.map((p) => p.type),
      }))
      throw new Error(
        `LLM diagnostics: calls=${calls} misses=${JSON.stringify(misses).slice(0, 600)} messages=${JSON.stringify(summary).slice(0, 800)}`,
      )
    }

    await expect.poll(() => assistantText(project.sdk, sessionID), { timeout: 30_000 }).toContain("结束")

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const list = document.querySelector('[data-slot="session-turn-list"]')
          const view = list?.closest(".scroll-view__viewport")
          if (!(view instanceof HTMLElement)) return 0
          return view.scrollHeight
        }),
      )
      .toBeGreaterThan(4000)

    const view = await timelineViewport(page)
    await page.evaluate((el) => {
      el.scrollTop = 0
    }, view)
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const message = document.querySelector('[data-slot="session-turn-message-content"]')
          const assistantEl = document.querySelector('[data-slot="session-turn-assistant-content"]')
          const first = assistantEl?.firstElementChild
          if (
            !(message instanceof HTMLElement) ||
            !(assistantEl instanceof HTMLElement) ||
            !(first instanceof HTMLElement)
          )
            return Number.NaN
          return Math.round(assistantEl.getBoundingClientRect().top - message.getBoundingClientRect().bottom)
        }),
      )
      .toBe(18)

    const innerGap = await page.evaluate(() => {
      const assistantEl = document.querySelector('[data-slot="session-turn-assistant-content"]')
      const first = assistantEl?.firstElementChild
      if (!(assistantEl instanceof HTMLElement) || !(first instanceof HTMLElement)) return Number.NaN
      return Math.round(first.getBoundingClientRect().top - assistantEl.getBoundingClientRect().top)
    })
    expect(innerGap).toBeGreaterThanOrEqual(0)

    await page.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 1500
    }, view)

    const pinnedBubble = await page.evaluate(() => {
      const view = document.querySelector('[data-slot="session-turn-list"]')?.closest(".scroll-view__viewport")
      const pin = document.querySelector('[data-slot="session-turn-message-content"]')
      const bubble = pin?.querySelector("[data-slot='user-message-text']")
      if (!(view instanceof HTMLElement) || !(pin instanceof HTMLElement) || !(bubble instanceof HTMLElement))
        return { top: Number.NaN, bubbleBottom: Number.NaN }
      const viewTop = view.getBoundingClientRect().top
      return {
        top: Math.round(pin.getBoundingClientRect().top - viewTop),
        bubbleBottom: Math.round(bubble.getBoundingClientRect().bottom - viewTop),
      }
    })
    expect(pinnedBubble.top).toBeLessThanOrEqual(64)
    expect(pinnedBubble.bubbleBottom).toBeGreaterThanOrEqual(38)
    expect(pinnedBubble.bubbleBottom).toBeLessThanOrEqual(130)

    const pin = page.locator('[data-slot="session-turn-message-content"]').first()
    await expect(pin).toContainText(tail)

    await page.locator("[data-slot='user-message-text']").first().click()
    await expect(page.locator('[data-slot="session-turn-assistant-content"]')).toHaveCount(0)
    await expect(page.locator('[data-component="session-turn"][data-assistant-collapsed]')).toHaveCount(1)

    await page.locator('[data-slot="session-turn-assistant-toggle"]').click()
    await expect(content).toBeAttached()

    await page.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 1500
    }, view)
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const view = document.querySelector('[data-slot="session-turn-list"]')?.closest(".scroll-view__viewport")
            const bubble = document
              .querySelector('[data-slot="session-turn-message-content"]')
              ?.querySelector("[data-slot='user-message-text']")
            if (!(view instanceof HTMLElement) || !(bubble instanceof HTMLElement)) return Number.NaN
            return Math.round(bubble.getBoundingClientRect().bottom - view.getBoundingClientRect().top)
          }),
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(130)
  } finally {
    page.off("pageerror", onPageError)
  }

  if (pageErrors.length > 0) {
    throw new Error(`Page error(s):\n${pageErrors.join("\n")}`)
  }
})
