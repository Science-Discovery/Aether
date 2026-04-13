import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import {
  openSidebar,
  resolveSlug,
  sessionIDFromUrl,
  setWorkspacesEnabled,
  waitDir,
  waitSessionSaved,
  waitSlug,
} from "../actions"
import { promptSelector, workspaceItemSelector, workspaceNewSessionSelector } from "../selectors"
import { createSdk } from "../utils"

function item(space: { slug: string; raw: string }) {
  return `${workspaceItemSelector(space.slug)}, ${workspaceItemSelector(space.raw)}`
}

function button(space: { slug: string; raw: string }) {
  return `${workspaceNewSessionSelector(space.slug)}, ${workspaceNewSessionSelector(space.raw)}`
}

async function waitStableSession(page: Page, timeout = 15_000) {
  let prev = ""
  let next = ""
  await expect
    .poll(
      () => {
        const current = sessionIDFromUrl(page.url()) ?? ""
        if (!current) {
          prev = ""
          next = ""
          return ""
        }
        if (current !== prev) {
          prev = current
          next = ""
          return ""
        }
        next = current
        return current
      },
      { timeout },
    )
    .not.toBe("")
  if (!next) throw new Error(`Failed to observe a stable session id from url: ${page.url()}`)
  return next
}

async function waitWorkspaceReady(page: Page, space: { slug: string; raw: string }) {
  await openSidebar(page)
  await expect(page.locator(item(space)).first()).toBeVisible({ timeout: 60_000 })
}

async function createWorkspace(page: Page, root: string, seen: string[]) {
  await openSidebar(page)
  await page.getByRole("button", { name: "New workspace" }).first().click()

  const next = await resolveSlug(await waitSlug(page, [root, ...seen]))
  await waitDir(page, next.directory)
  return next
}

async function openWorkspaceNewSession(page: Page, space: { slug: string; raw: string; directory: string }) {
  await waitWorkspaceReady(page, space)

  const row = page.locator(item(space)).first()
  await row.hover()

  const next = page.locator(button(space)).first()
  await expect(next).toBeVisible()
  await next.click({ force: true })

  await waitDir(page, space.directory)
  await expect(page.locator(promptSelector).first()).toBeVisible({ timeout: 45_000 })
  return waitStableSession(page)
}

async function createSessionFromWorkspace(
  page: Page,
  space: { slug: string; raw: string; directory: string },
  text: string,
) {
  await openWorkspaceNewSession(page, space)

  const prompt = page.locator(promptSelector)
  await expect(prompt).toBeVisible()
  await prompt.fill(text)
  await page.keyboard.press("Enter")

  const sessionID = await waitStableSession(page)
  await waitSessionSaved(space.directory, sessionID)
  await createSdk(space.directory)
    .session.abort({ sessionID })
    .catch(() => undefined)
  return sessionID
}

test("new sessions from sidebar workspace actions stay in selected workspace", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withProject(async ({ slug: root, trackDirectory, trackSession }) => {
    await openSidebar(page)
    await setWorkspacesEnabled(page, root, true)

    const first = await createWorkspace(page, root, [])
    trackDirectory(first.directory)
    await waitWorkspaceReady(page, first)

    const second = await createWorkspace(page, root, [first.slug])
    trackDirectory(second.directory)
    await waitWorkspaceReady(page, second)

    trackSession(await createSessionFromWorkspace(page, first, `workspace one ${Date.now()}`), first.directory)
    trackSession(await createSessionFromWorkspace(page, second, `workspace two ${Date.now()}`), second.directory)
    trackSession(await createSessionFromWorkspace(page, first, `workspace one again ${Date.now()}`), first.directory)
  })
})
