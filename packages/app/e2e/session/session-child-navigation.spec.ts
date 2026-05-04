import { seedSessionTask, withSession } from "../actions"
import { test, expect } from "../fixtures"

test("task tool child-session link does not trigger stale show errors", async ({ page, llm, project }) => {
  test.setTimeout(120_000)

  const errs: string[] = []
  const onError = (err: Error) => {
    errs.push(err.message)
  }
  page.on("pageerror", onError)

  await project.open()

  await withSession(project.sdk, `e2e child nav ${Date.now()}`, async (session) => {
    const task = {
      description: "Open child session",
      prompt: "Search the repository for AssistantParts and then reply with exactly CHILD_OK.",
      subagent_type: "general",
    }

    await llm.tool("task", task)
    await llm.text("CHILD_OK")

    const child = await seedSessionTask(project.sdk, {
      sessionID: session.id,
      description: task.description,
      prompt: task.prompt,
      subagentType: task.subagent_type,
    })
    project.trackSession(child.sessionID)
    await llm.wait(2)

    try {
      await project.gotoSession(session.id)

      const link = page
        .locator("a.subagent-link")
        .filter({ hasText: /open child session/i })
        .first()
      await expect(link).toBeVisible({ timeout: 30_000 })
      await link.click()

      await expect(page).toHaveURL(new RegExp(`/session/${child.sessionID}(?:[/?#]|$)`), { timeout: 30_000 })
      await page.waitForTimeout(1000)
      expect(errs).toEqual([])
    } finally {
      page.off("pageerror", onError)
    }
  })
})
