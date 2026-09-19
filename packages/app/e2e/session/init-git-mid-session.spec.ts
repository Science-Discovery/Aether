import { sessionIDFromUrl } from "../actions"
import { test, expect } from "../fixtures"

test.setTimeout(300_000)

test("creating a git repository mid-session keeps the running turn alive", async ({ page, llm, project }) => {
  // Observe the app's SSE stream from inside the page: byte liveness plus a
  // log of event types, so the test can prove no instance disposal happened.
  await page.addInitScript(() => {
    const state = ((window as any).__opencode_e2e ??= {})
    const orig = window.fetch
    ;(window as any).fetch = async (...args: any[]) => {
      const res = await orig(...args)
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "")
        if (url.includes("/global/event") && res.body) {
          ;(window as any).__sse = { bytes: 0, log: "" }
          const clone = res.clone()
          const reader = clone.body!.getReader()
          const pump = async () => {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) return
              const win = (window as any).__sse
              win.bytes += value.length
              win.log += new TextDecoder().decode(value)
            }
          }
          void pump()
        }
      } catch {
        /* ignore */
      }
      return res
    }
  })

  // A VCS-less project: the review panel shows the create-git empty state.
  await project.open({ git: false })

  // Keep the turn busy for the whole test: a pending tool whose LLM stream hangs.
  await llm.toolHang("read", { filePath: "e2e-never.txt" })
  await project.prompt("start a long task")
  const sessionID = sessionIDFromUrl(page.url())
  expect(sessionID).toBeTruthy()

  const status = async () => {
    const data = await project.sdk.session
      .status()
      .then((x) => x.data ?? {})
      .catch(() => undefined)
    return data?.[sessionID!]
  }
  await expect.poll(status, { timeout: 30_000 }).toMatchObject({ type: "busy" })

  // Open the review panel; a VCS-less project shows the create-git empty state.
  const reviewToggle = page.getByRole("button", { name: "Toggle review" }).first()
  await expect(reviewToggle).toBeVisible()
  if ((await reviewToggle.getAttribute("aria-expanded")) !== "true") await reviewToggle.click()
  const create = page.getByRole("button", { name: "Create Git repository" })
  await expect(create).toBeVisible({ timeout: 15_000 })

  // The actual regression: click it while the turn is in flight.
  await create.click()

  // The turn must survive: still busy seconds later (a reload would have
  // aborted the prompt and flipped the session idle).
  await page.waitForTimeout(5_000)
  expect(await status()).toMatchObject({ type: "busy" })

  // No instance disposal was broadcast to the app.
  const sseLog = await page.evaluate(() => (window as any).__sse?.log ?? "")
  expect(sseLog).not.toContain("server.instance.disposed")

  // The review panel flipped from the create-git empty state to vcs mode.
  await expect(create).toHaveCount(0, { timeout: 15_000 })
  const current = await project.sdk.project.current().then((x) => x.data)
  expect(current?.vcs).toBe("git")

  // The stream is still delivering events.
  await expect
    .poll(() => page.evaluate(() => (window as any).__sse?.bytes ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0)
})
