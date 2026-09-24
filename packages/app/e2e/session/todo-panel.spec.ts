import { skipSafeZoneOnboarding, withSession } from "../actions"
import { test, expect } from "../fixtures"

test.setTimeout(300_000)

const todo = (content: string, status: string) => ({ content, status, priority: "high" })

test("todo panel tracks scripted todowrite updates in real time", async ({ page, llm, project }) => {
  // Expose the composer probe and observe the app's SSE stream from inside
  // the page so the test can wait until the event stream is live.
  await page.addInitScript(() => {
    const state = ((window as any).__opencode_e2e ??= {})
    state.composer = { enabled: true, sessions: {} }
    const orig = window.fetch
    ;(window as any).fetch = async (...args: any[]) => {
      const res = await orig(...args)
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "")
        if (url.includes("/global/event") && res.body) {
          ;(window as any).__sse = { bytes: 0 }
          const clone = res.clone()
          const reader = clone.body!.getReader()
          const pump = async () => {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) return
              ;(window as any).__sse.bytes += value.length
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

  await project.open()
  await withSession(project.sdk, `e2e todo panel ${Date.now()}`, async (session) => {
    await project.gotoSession(session.id)

    // Wait for the app's own SSE stream to deliver its first bytes before
    // acting: permission-mode changes only reach the UI through the live
    // stream (there is no bootstrap replay), so clicking earlier can lose
    // the update, and todowrite events must not race the connection either.
    await page.waitForFunction(() => (window as any).__sse && (window as any).__sse.bytes > 0, null, {
      timeout: 30_000,
    })

    // Two clicks cycle the permission mode off -> safe -> full; the safe
    // transition may open the one-time safe-zone onboarding dialog. Assert the
    // safe label before the second click so the cycle reads the updated mode.
    const permissions = page.locator('[data-action="prompt-permissions"]').first()
    await permissions.click()
    await skipSafeZoneOnboarding(page)
    await expect(permissions).toHaveAttribute("aria-label", "Permissions: safe zone")
    await permissions.click()
    await expect(permissions).toHaveAttribute("aria-label", "Permissions: auto-accept all")

    const probe = () =>
      page.evaluate((sid) => (window as any).__opencode_e2e?.composer?.sessions?.[sid]?.probe ?? null, session.id)

    await llm.tool("todowrite", {
      todos: [todo("task one", "pending"), todo("task two", "pending"), todo("task three", "pending")],
    })
    await llm.tool("todowrite", {
      todos: [todo("task one", "completed"), todo("task two", "in_progress"), todo("task three", "pending")],
    })
    // Stop at a stable in-progress state: an all-completed list auto-collapses
    // the dock after 400ms, which is too transient to assert on.
    await llm.tool("todowrite", {
      todos: [todo("task one", "completed"), todo("task two", "completed"), todo("task three", "in_progress")],
    })
    // Keep the turn alive so the panel stays mounted for assertions.
    await llm.toolHang("read", { filePath: "e2e-never.txt" })

    try {
      await project.prompt("work through the task list")

      // The dock publishes its own rendered props through the composer probe:
      // mounted with the final todo states is the semantic proof that the
      // panel rendered the streamed data.
      await expect.poll(probe, { timeout: 60_000, intervals: [100, 250, 500, 1000] }).toEqual({
        mounted: true,
        collapsed: false,
        hidden: false,
        count: 3,
        states: ["completed", "completed", "in_progress"],
      })

      const server = await project.sdk.session.todo({ sessionID: session.id })
      expect(server.data).toEqual([
        todo("task one", "completed"),
        todo("task two", "completed"),
        todo("task three", "in_progress"),
      ])
    } catch (err) {
      const failure = await project.sdk.session.todo({ sessionID: session.id }).catch((e) => String(e))
      console.log("DIAG server todo:", JSON.stringify(failure))
      console.log("DIAG probe:", JSON.stringify(await probe()))
      console.log("DIAG llm calls:", await llm.calls())
      throw err
    }
  })
})
