import { test, expect } from "../fixtures"
import { confirmSubmit, promptSend } from "../fixtures"
import { assistantText, waitSessionIdle } from "../actions"
import { promptSelector } from "../selectors"
import { writeFile } from "node:fs/promises"
import path from "node:path"

const tail = "记住最后这一行"
type Page = import("@playwright/test").Page

async function timelineViewport(page: Page) {
  return page.evaluateHandle(() => {
    const list = document.querySelector('[data-slot="session-turn-list"]')
    const view = list?.closest(".scroll-view__viewport")
    if (!(view instanceof HTMLElement)) throw new Error("timeline viewport not found")
    return view
  })
}

async function placement(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector('[data-slot="session-turn-list"]')?.closest(".scroll-view__viewport")
    const pin = view?.querySelector('[data-slot="session-turn-message-content"]')
    const bubble = pin?.querySelector("[data-slot='user-message-text']")
    if (!(view instanceof HTMLElement) || !(pin instanceof HTMLElement) || !(bubble instanceof HTMLElement))
      throw new Error("user message placement is unavailable")
    const title = view.querySelector("[data-session-title]")
    const rect = bubble.getBoundingClientRect()
    const style = getComputedStyle(pin)
    return {
      gap: rect.top - (title?.getBoundingClientRect().bottom ?? view.getBoundingClientRect().top),
      bottom: view.getBoundingClientRect().bottom - rect.bottom,
      height: rect.height,
      pin: pin.getBoundingClientRect().height,
      room: view.clientHeight - (Number.parseFloat(style.top) || 0),
      line: Number.parseFloat(getComputedStyle(bubble).lineHeight),
      position: style.position,
      sticky: pin.getAttribute("data-sticky"),
      shift: style.getPropertyValue("--pin-shift"),
    }
  })
}

async function pinned(page: Page) {
  await expect.poll(async () => (await placement(page)).position).toBe("sticky")
  await expect.poll(async () => Math.abs((await placement(page)).gap - 8)).toBeLessThan(1)
  const state = await placement(page)
  expect(state.sticky).toBe("true")
  expect(state.bottom).toBeGreaterThanOrEqual(0)
  expect(state.shift.trim()).toBe("")
  return state
}

for (const lines of [4, 32]) {
  test(
    lines === 4
      ? "multiline prompts stay fully below the title and retain click actions"
      : "oversized prompts scroll normally and repin after resizing",
    async ({ page, project, assistant, llm }) => {
      test.setTimeout(300_000)

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
        const prev = await promptSend(page)
        await prompt.click()
        for (let index = 0; index < lines; index++) {
          if (index > 0) await page.keyboard.press("Shift+Enter")
          await page.keyboard.type(index === lines - 1 ? tail : `第${index + 1}行：完整保留这一行`)
        }
        await expect.poll(async () => (await prompt.textContent()) ?? "").toContain(tail)

        // Enter can be a silent no-op under CI load; confirmSubmit retries via the
        // probe, and the probe poll observes the accepted submission server-side
        // instead of racing the optimistic URL navigation.
        await confirmSubmit(page, prev)
        await expect
          .poll(
            async () => {
              const value = await promptSend(page)
              if (value.count <= prev.count) return ""
              if (!value.sessionID || !value.directory) return ""
              return value.sessionID
            },
            { timeout: 90_000 },
          )
          .not.toBe("")
        const submission = await promptSend(page)
        if (!submission.sessionID || !submission.directory)
          throw new Error(`Prompt probe did not record the submission: ${JSON.stringify(submission)}`)
        const sessionID = submission.sessionID
        project.trackSession(sessionID, submission.directory)

        const content = page.locator('[data-slot="session-turn-assistant-content"]')
        await expect(content).toBeAttached({ timeout: 60_000 })
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
        await page.evaluate(() => document.fonts.ready)
        const text = await page.locator("[data-slot='user-message-text']").first().textContent()
        expect(text?.split("\n")).toHaveLength(lines)
        await expect
          .poll(async () =>
            page.evaluate(() => {
              const list = document.querySelector('[data-slot="session-turn-list"]')
              const view = list?.closest(".scroll-view__viewport")
              if (!(view instanceof HTMLElement)) return Number.NaN
              view.scrollTop = 0
              const message = document.querySelector('[data-slot="session-turn-message-content"]')
              const assistantEl = document.querySelector('[data-slot="session-turn-assistant-content"]')
              if (!(message instanceof HTMLElement) || !(assistantEl instanceof HTMLElement)) return Number.NaN
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

        if (lines === 32) {
          const viewport = page.viewportSize()!
          await expect.poll(async () => (await placement(page)).position).toBe("static")
          const initial = await placement(page)
          expect(initial.sticky).toBe("false")
          expect(initial.pin).toBeGreaterThanOrEqual(initial.room)
          expect(Math.abs(initial.gap - 8)).toBeLessThan(1)
          expect(initial.height).toBeGreaterThanOrEqual(initial.line * lines)
          await page.evaluate((el) => {
            el.scrollTop = 200
          }, view)
          await expect.poll(async () => (await placement(page)).gap).toBeLessThan(0)
          expect((await placement(page)).position).toBe("static")

          await page.setViewportSize({ width: viewport.width, height: viewport.height + Math.ceil(initial.pin) + 200 })
          await page.evaluate((el) => {
            el.scrollTop = 200
          }, view)
          await pinned(page)
          await page.setViewportSize(viewport)
          await expect.poll(async () => (await placement(page)).position).toBe("static")
          await page.evaluate((el) => {
            el.scrollTop = 0
          }, view)
          await expect.poll(async () => Math.abs((await placement(page)).gap - 8)).toBeLessThan(1)
          expect(pageErrors).toEqual([])
          return
        }

        const initial = await pinned(page)
        expect(initial.height).toBeGreaterThanOrEqual(initial.line * lines)

        await page.evaluate((el) => {
          el.scrollTop = el.scrollHeight - el.clientHeight - 1500
        }, view)

        const current = await pinned(page)
        expect(Math.abs(current.height - initial.height)).toBeLessThan(1)

        const viewport = page.viewportSize()!
        await page.setViewportSize({ width: 420, height: viewport.height })
        await pinned(page)
        await page.setViewportSize(viewport)
        await pinned(page)

        const pin = page.locator('[data-slot="session-turn-message-content"]').first()
        await expect(pin).toContainText(tail)

        await page.locator("[data-slot='user-message-text']").first().click()
        await expect
          .poll(
            async () =>
              page.evaluate(() => {
                const view = document
                  .querySelector('[data-slot="session-turn-list"]')
                  ?.closest(".scroll-view__viewport")
                if (!(view instanceof HTMLElement)) return Number.NaN
                return view.scrollTop
              }),
            { timeout: 10_000 },
          )
          .toBeLessThan(200)

        await page.locator("[data-slot='user-message-text']").first().click()
        await expect(page.locator('[data-slot="session-turn-assistant-content"]')).toHaveCount(0)
        await expect(page.locator('[data-component="session-turn"][data-assistant-collapsed]')).toHaveCount(1)

        await page.locator('[data-slot="session-turn-assistant-toggle"]').click()
        await expect(content).toBeAttached()

        await page.evaluate((el) => {
          el.scrollTop = el.scrollHeight - el.clientHeight - 1500
        }, view)
        await pinned(page)
      } finally {
        page.off("pageerror", onPageError)
      }

      if (pageErrors.length > 0) {
        throw new Error(`Page error(s):\n${pageErrors.join("\n")}`)
      }
    },
  )
}
