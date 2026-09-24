import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test.setTimeout(180_000)

const reply = (n: number) =>
  `Reply ${n}: ` +
  Array.from({ length: 60 }, (_, i) => `conversation content line ${i} keeps the timeline tall and scrollable.`).join(
    " ",
  )

test("prompt dock stays pinned to the bottom while the conversation scrolls", async ({ page, llm, project }) => {
  await project.open()

  for (let i = 1; i <= 3; i++) {
    await llm.text(reply(i))
    await project.prompt(`message ${i}`)
  }

  const dock = page.locator('[data-component="session-prompt-dock"]').first()
  await expect(dock).toBeVisible()

  const prompt = page.locator(promptSelector).first()
  await prompt.click()
  await page.keyboard.type(
    "a long draft line that makes the prompt input wide and tall while the conversation scrolls behind it. ".repeat(2),
  )
  await expect.poll(async () => (await prompt.textContent())?.length ?? 0).toBeGreaterThan(100)

  const read = () =>
    page.evaluate(() => {
      const dock = document.querySelector('[data-component="session-prompt-dock"]')
      const viewport = document.querySelector(".scroll-view__viewport")
      if (!(dock instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return null
      const dockRect = dock.getBoundingClientRect()
      const viewRect = viewport.getBoundingClientRect()
      const overlap = Math.max(0, Math.min(dockRect.bottom, viewRect.bottom) - Math.max(dockRect.top, viewRect.top))
      return {
        top: dockRect.top,
        left: dockRect.left,
        bottom: dockRect.bottom,
        width: dockRect.width,
        overlap,
        transform: getComputedStyle(dock).transform,
        scrollTop: viewport.scrollTop,
      }
    })

  const before = await read()
  expect(before).not.toBeNull()
  expect(before!.transform).toBe("matrix(1, 0, 0, 1, 0, 0)")
  expect(before!.overlap).toBeLessThanOrEqual(1)

  const viewport = page.locator(".scroll-view__viewport").first()
  await viewport.hover()
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(300)

  const after = await read()
  expect(after).not.toBeNull()
  expect(after!.scrollTop).toBeGreaterThan(0)
  expect(after!.top).toBeCloseTo(before!.top, 0)
  expect(after!.left).toBeCloseTo(before!.left, 0)
  expect(after!.bottom).toBeCloseTo(before!.bottom, 0)
  expect(after!.overlap).toBeLessThanOrEqual(1)
})
