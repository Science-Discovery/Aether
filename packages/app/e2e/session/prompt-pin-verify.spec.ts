import { test, expect, settingsKey } from "../fixtures"
import { confirmSubmit, promptSend } from "../fixtures"
import { assistantText, closeDialog, openSettings, waitSessionIdle } from "../actions"
import { promptSelector } from "../selectors"
import { copyFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { raw, reply } from "../../../opencode/test/lib/llm-server"
import { sessionPath } from "../utils"

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
      : "long prompts collapse, expand without following the stream, and retain adaptive pinning",
    async ({ page, project, assistant, llm }) => {
      test.setTimeout(300_000)

      const pageErrors: string[] = []
      const onPageError = (err: Error) => {
        pageErrors.push(err.message)
      }
      page.on("pageerror", onPageError)
      const gate = Promise.withResolvers<void>()

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
        if (lines === 4) await assistant.reply(`${body}\n\n结束`)
        if (lines === 32) {
          const first = reply().text(body).item()
          const last = reply().text(`\n\n${body}\n\n结束`).stop().item()
          if (first.type !== "sse" || last.type !== "sse") throw new Error("Expected streaming replies")
          await llm.push(raw({ head: [...first.head, ...first.tail], tail: last.tail, wait: gate.promise }))
        }

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
        if (lines === 4) await waitSessionIdle(project.sdk, sessionID, 120_000)

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

        await expect(content).toContainText("段落 240", { timeout: 30_000 })

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
        const text = await page.locator("[data-slot='user-message-content']").first().textContent()
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
          const toggle = page.locator('[data-slot="user-message-toggle"]').first()
          await expect(toggle).toHaveAttribute("aria-expanded", "false")
          const collapsed = await pinned(page)
          expect(collapsed.height).toBeLessThan(collapsed.line * 13)
          await page.evaluate((el) => {
            el.scrollTop = 200
          }, view)
          await pinned(page)
          await expect.poll(async () => (await project.sdk.session.status()).data?.[sessionID]?.type).toBe("busy")
          await expect(content).not.toContainText("结束")

          await toggle.click()
          await expect(toggle).toHaveAttribute("aria-expanded", "true")
          await expect(content).toBeVisible()
          await expect.poll(async () => (await placement(page)).position).toBe("static")
          const initial = await placement(page)
          expect(initial.sticky).toBe("false")
          expect(initial.pin).toBeGreaterThanOrEqual(initial.room)
          expect(Math.abs(initial.gap - 8)).toBeLessThan(1)
          expect(initial.height).toBeGreaterThanOrEqual(initial.line * lines)
          gate.resolve()
          await waitSessionIdle(project.sdk, sessionID, 120_000)
          await expect.poll(() => assistantText(project.sdk, sessionID), { timeout: 30_000 }).toContain("结束")
          await expect
            .poll(async () => page.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop, view))
            .toBeGreaterThan(1500)
          await expect.poll(async () => Math.abs((await placement(page)).gap - 8)).toBeLessThan(1)

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
          await expect(toggle).toHaveAttribute("aria-expanded", "true")

          await toggle.click()
          await expect(toggle).toHaveAttribute("aria-expanded", "false")
          await pinned(page)
          await expect(content).toBeVisible()

          await toggle.focus()
          await page.keyboard.press("Enter")
          await expect(toggle).toHaveAttribute("aria-expanded", "true")
          await expect.poll(async () => (await placement(page)).position).toBe("static")
          await page.keyboard.press("Space")
          await expect(toggle).toHaveAttribute("aria-expanded", "false")
          await pinned(page)

          await page
            .locator('[data-slot="user-message-text"]')
            .first()
            .evaluate((el: HTMLElement) => {
              el.tabIndex = -1
              el.focus()
            })
          await page.keyboard.press("Control+f")
          const find = page.getByPlaceholder("Find", { exact: true })
          await expect(find).toBeVisible()
          await find.fill(tail)
          await expect(toggle).toHaveAttribute("aria-expanded", "true")
          await expect
            .poll(() =>
              page.evaluate(() => {
                const marks = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
                const range = marks?.get("opencode-chat-find-current")?.values().next().value
                const view = document
                  .querySelector('[data-slot="session-turn-list"]')
                  ?.closest(".scroll-view__viewport")
                if (!range || !(view instanceof HTMLElement)) return false
                const rect = range.getBoundingClientRect()
                const floor = view.querySelector("[data-session-title]")?.getBoundingClientRect().bottom
                return (
                  rect.top >= (floor ?? view.getBoundingClientRect().top) &&
                  rect.bottom <= view.getBoundingClientRect().bottom
                )
              }),
            )
            .toBe(true)
          await find.press("Escape")
          await expect(find).toHaveCount(0)
          await toggle.click()
          await expect(toggle).toHaveAttribute("aria-expanded", "false")
          await pinned(page)
          await expect(content).toBeVisible()
          await page.evaluate((el) => {
            el.scrollTop = 0
          }, view)
          await expect.poll(async () => Math.abs((await placement(page)).gap - 8)).toBeLessThan(1)
          expect(pageErrors).toEqual([])
          return
        }

        const initial = await pinned(page)
        expect(initial.height).toBeGreaterThanOrEqual(initial.line * lines)
        await expect(page.locator('[data-slot="user-message-toggle"]')).toHaveCount(0)

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
        gate.resolve()
        page.off("pageerror", onPageError)
      }

      if (pageErrors.length > 0) {
        throw new Error(`Page error(s):\n${pageErrors.join("\n")}`)
      }
    },
  )
}

test("reading mode folds long user messages and preserves the global setting across reloads", async ({
  page,
  project,
  llm,
}) => {
  test.setTimeout(180_000)
  await project.open({
    setup: async (dir) => {
      await copyFile(
        new URL("../../../opencode/test/tool/fixtures/cid-chinese.pdf", import.meta.url),
        path.join(dir, "sample.pdf"),
      )
      await writeFile(
        path.join(dir, "opencode.json"),
        JSON.stringify({ memory: { enabled: false, dailyReflect: { enabled: false } } }),
      )
    },
  })
  const opened = await project.sdk.readingMode.session.fromFile({
    path: "sample.pdf",
    settings: { autoFirstRead: false },
  })
  const session = opened.data?.session
  if (!session) throw new Error(`Reading session creation failed: ${JSON.stringify(opened.error)}`)
  project.trackSession(session.id)
  const text = Array.from({ length: 32 }, (_, i) => (i === 31 ? tail : `阅读模式第${i + 1}行`)).join("\n")
  await project.sdk.session.prompt({ sessionID: session.id, noReply: true, parts: [{ type: "text", text }] })
  // The isolated backend starts in packages/opencode, unlike the workspace
  // session. Preserve that workspace context for the iframe's binary request.
  await page.route("**/reading-mode/pdf?*", (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set("directory", project.directory)
    return route.continue({ url: url.toString() })
  })
  const pdf = page.waitForResponse((res) => new URL(res.url()).pathname === "/reading-mode/pdf")
  await page.goto(`${sessionPath(project.directory, session.id)}/reading`)
  const response = await pdf
  expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
  await expect(page.getByTitle("PDF Viewer", { exact: true })).toBeVisible()
  await expect(page.frameLocator('iframe[title="PDF Viewer"]').locator("#viewer .page canvas").first()).toBeVisible()
  const toggle = page.locator('[data-slot="user-message-toggle"]').first()
  const body = page.locator('[data-slot="user-message-content"]').first()
  await expect(body).toHaveText(text)
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await page.screenshot({ path: test.info().outputPath("reading-collapsed.png") })
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect.poll(async () => (await placement(page)).position).toBe("static")
  await page.screenshot({ path: test.info().outputPath("reading-expanded.png") })
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")

  const dialog = await openSettings(page)
  const setting = dialog.locator('[data-action="settings-collapse-long-user-messages"]')
  await expect(setting.locator('[data-slot="switch-input"]')).toBeChecked()
  await setting.locator('[data-slot="switch-control"]').click()
  await expect(setting.locator('[data-slot="switch-input"]')).not.toBeChecked()
  await closeDialog(page, dialog)
  await expect(toggle).toHaveCount(0)
  await expect.poll(async () => (await placement(page)).position).toBe("static")
  expect(await body.textContent()).toBe(text)
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}").general?.collapseLongUserMessages,
        settingsKey,
      ),
    )
    .toBe(false)

  await page.reload()
  await expect(body).toHaveText(text)
  await expect(toggle).toHaveCount(0)
  await expect.poll(async () => (await placement(page)).position).toBe("static")
  const restored = await openSettings(page)
  const control = restored.locator('[data-action="settings-collapse-long-user-messages"]')
  await expect(control.locator('[data-slot="switch-input"]')).not.toBeChecked()
  await control.locator('[data-slot="switch-control"]').click()
  await closeDialog(page, restored)
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect.poll(async () => (await placement(page)).position).toBe("sticky")
  expect(await llm.calls()).toBe(0)
  expect(await llm.misses()).toEqual([])
})
