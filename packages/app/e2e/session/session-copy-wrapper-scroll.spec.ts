import { test, expect } from "../fixtures"
import { confirmSubmit, promptSend } from "../fixtures"
import { waitSessionIdle } from "../actions"
import { promptSelector } from "../selectors"
import { writeFile } from "node:fs/promises"
import path from "node:path"

test.setTimeout(300_000)

function viewportSelector() {
  return '[data-slot="session-turn-list"]'
}

test("scrolling dismisses the hover-only copy/meta row and reveal resumes after scroll idle", async ({
  page,
  project,
  assistant,
}) => {
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

  const body = Array.from(
    { length: 240 },
    (_, i) => `Paragraph ${i + 1}: filler text that keeps the assistant part tall for scrolling.`,
  ).join("\n\n")
  await assistant.reply(`${body}\n\nEND`)

  const prompt = page.locator(promptSelector)
  const prev = await promptSend(page)
  await prompt.click()
  await page.keyboard.type("write a long reply")
  await confirmSubmit(page, prev)

  const submission = await promptSend(page)
  if (!submission.sessionID || !submission.directory) {
    throw new Error(`Prompt probe did not record the submission: ${JSON.stringify(submission)}`)
  }
  project.trackSession(submission.sessionID, submission.directory)

  await waitSessionIdle(project.sdk, submission.sessionID, 120_000)

  const wrapper = page.locator('[data-slot="text-part-copy-wrapper"]').first()
  await expect(wrapper).toBeAttached({ timeout: 30_000 })

  await expect.poll(() => wrapper.evaluate((el) => getComputedStyle(el).willChange)).toBe("auto")

  await page.evaluate((list) => {
    const view = document.querySelector(list)?.closest(".scroll-view__viewport")
    if (view instanceof HTMLElement) view.scrollTop = 0
  }, viewportSelector())

  const part = page.locator('[data-component="text-part"]').first()
  const box = await part.boundingBox()
  if (!box) throw new Error("assistant text part is not visible after scrolling to top")
  await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + 8)

  await expect.poll(() => wrapper.evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
  await expect.poll(() => wrapper.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto")

  const sample = await page.evaluate(async (list) => {
    const view = document.querySelector(list)?.closest(".scroll-view__viewport")
    const row = document.querySelector('[data-slot="text-part-copy-wrapper"]')
    if (!(view instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      throw new Error("timeline viewport or copy wrapper not found")
    }
    const sleep = (t: number) => new Promise((r) => setTimeout(r, t))
    for (let i = 0; i < 12; i++) {
      view.scrollTop += 30
      await sleep(40)
    }
    return {
      scrolling: view.hasAttribute("data-scrolling"),
      opacity: getComputedStyle(row).opacity,
      pointerEvents: getComputedStyle(row).pointerEvents,
    }
  }, viewportSelector())

  expect(sample.scrolling).toBe(true)
  expect(sample.opacity).toBe("0")
  expect(sample.pointerEvents).toBe("none")

  await expect
    .poll(
      async () =>
        page.evaluate((list) => {
          const view = document.querySelector(list)?.closest(".scroll-view__viewport")
          return view instanceof HTMLElement && view.hasAttribute("data-scrolling")
        }, viewportSelector()),
      { timeout: 5_000 },
    )
    .toBe(false)

  await expect.poll(() => wrapper.evaluate((el) => getComputedStyle(el).opacity), { timeout: 5_000 }).toBe("1")
  await expect.poll(() => wrapper.evaluate((el) => getComputedStyle(el).pointerEvents), { timeout: 5_000 }).toBe("auto")
})
