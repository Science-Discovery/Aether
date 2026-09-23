import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { dirSlug, sessionPath } from "../utils"

const notificationsKey = "opencode.global.dat:notification"
const DEAD = "ses_z0mbie00000000000000000000000"

const errorNotification = (directory: string, session: string, message: string, time: number) => ({
  type: "error",
  directory,
  session,
  time,
  viewed: false,
  error: { name: "UnknownError", data: { message } },
})

const storedList = (page: import("@playwright/test").Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    return (JSON.parse(raw).list ?? []) as { session?: string; viewed: boolean }[]
  }, notificationsKey)

const seed = async (page: import("@playwright/test").Page, args: { directory: string; list: unknown[] }) => {
  await page.addInitScript(
    ([key, layoutKey, list, directory]: [string, string, unknown, string]) => {
      localStorage.setItem(key, JSON.stringify({ list }))
      const raw = localStorage.getItem(layoutKey)
      const parsed = raw ? (JSON.parse(raw) as Record<string, any>) : {}
      const sidebar = (parsed.sidebar ?? {}) as Record<string, any>
      sidebar.workspaces = { ...(sidebar.workspaces ?? {}), [directory]: true }
      localStorage.setItem(layoutKey, JSON.stringify({ ...parsed, sidebar }))
    },
    [notificationsKey, "opencode.global.dat:layout", args.list, args.directory],
  )
}

const workspaceDot = (page: import("@playwright/test").Page, directory: string) =>
  page
    .locator(`[data-component="workspace-item"][data-workspace="${dirSlug(directory)}"] [data-slot="status-dot"]`)
    .first()

const dotAnchored = (page: import("@playwright/test").Page, directory: string) =>
  workspaceDot(page, directory).evaluate((el) => {
    const root = el.closest('[data-component="workspace-item"]')
    let node: HTMLElement | null = el.parentElement
    while (node && node !== root?.parentElement) {
      if (getComputedStyle(node).position === "absolute") return true
      node = node.parentElement
    }
    return false
  })

test("zombie error notification for a deleted session is purged on hydration", async ({
  page,
  sdk,
  gotoSession,
  directory,
}) => {
  const live = await sdk.session.create({ directory, title: "zombie purge live" }).then((r) => r.data?.id)
  expect(live).toBeDefined()
  await seed(page, {
    directory,
    list: [
      errorNotification(directory, DEAD, "no such table: session_retry", Date.now() - 1000),
      errorNotification(directory, live!, "stale live error", Date.now()),
    ],
  })

  await gotoSession()

  await expect
    .poll(() => storedList(page).then((list) => list.filter((n) => !n.viewed).map((n) => n.session)))
    .toEqual([live])

  await openSidebar(page)
  await expect(workspaceDot(page, directory)).toBeVisible()
})

test("workspace error dot tooltip shows count and latest summary", async ({ page, sdk, gotoSession, directory }) => {
  const live = await sdk.session.create({ directory, title: "tooltip live" }).then((r) => r.data?.id)
  expect(live).toBeDefined()
  await seed(page, {
    directory,
    list: [
      errorNotification(directory, live!, "boom alpha", Date.now() - 5000),
      errorNotification(directory, live!, "boom beta", Date.now()),
    ],
  })

  await gotoSession()
  await openSidebar(page)

  await workspaceDot(page, directory).hover()
  await expect(page.locator("[data-component='tooltip']")).toContainText("2 unseen errors")
  await expect(page.locator("[data-component='tooltip']")).toContainText("boom beta")
  expect(await dotAnchored(page, directory)).toBe(true)
})

test("notification dot without errors keeps corner anchor and shows no tooltip", async ({
  page,
  sdk,
  gotoSession,
  directory,
}) => {
  const live = await sdk.session.create({ directory, title: "turn done" }).then((r) => r.data?.id)
  expect(live).toBeDefined()
  await seed(page, {
    directory,
    list: [{ type: "turn-complete", directory, session: live, time: Date.now(), viewed: false }],
  })

  await gotoSession()
  await openSidebar(page)

  await expect(workspaceDot(page, directory)).toBeVisible()
  expect(await dotAnchored(page, directory)).toBe(true)

  await workspaceDot(page, directory).hover()
  await expect(page.locator("[data-component='tooltip']")).toHaveCount(0)
})

test("error sessions submenu lists entries and jumps to the session", async ({ page, sdk, gotoSession, directory }) => {
  const first = await sdk.session.create({ directory, title: "menu first" }).then((r) => r.data?.id)
  const second = await sdk.session.create({ directory, title: "menu second" }).then((r) => r.data?.id)
  expect(first).toBeDefined()
  expect(second).toBeDefined()
  await seed(page, {
    directory,
    list: [
      errorNotification(directory, first!, "first error", Date.now()),
      errorNotification(directory, second!, "second error", Date.now() + 1),
    ],
  })

  await gotoSession()
  await openSidebar(page)

  const avatar = page.locator(`[data-action="project-switch"][data-project="${dirSlug(directory)}"]`).first()
  await avatar.click({ button: "right" })

  const trigger = page.locator("[data-action='project-error-sessions']")
  await expect(trigger).toBeVisible()
  await trigger.hover()

  const items = page.locator("[data-action='project-error-session-item']")
  await expect(items).toHaveCount(2)
  await expect(items.filter({ hasText: "menu first" })).toHaveCount(1)
  await expect(items.filter({ hasText: "second error" })).toHaveCount(1)

  await items.filter({ hasText: "menu first" }).click()
  await expect(page).toHaveURL(new RegExp(`/session/${first}$`))

  await expect.poll(() => storedList(page).then((list) => list.find((n) => n.session === first)?.viewed)).toBe(true)
})

test("single error session shows a direct menu item that navigates", async ({ page, sdk, gotoSession, directory }) => {
  const only = await sdk.session.create({ directory, title: "menu single" }).then((r) => r.data?.id)
  expect(only).toBeDefined()
  await seed(page, { directory, list: [errorNotification(directory, only!, "only error", Date.now())] })

  await gotoSession()
  await openSidebar(page)

  const avatar = page.locator(`[data-action="project-switch"][data-project="${dirSlug(directory)}"]`).first()
  await avatar.click({ button: "right" })

  const item = page.locator("[data-action='project-error-session']")
  await expect(item).toBeVisible()
  await expect(item).toContainText("menu single")
  await item.click()

  await expect(page).toHaveURL(sessionPath(directory, only!))
  await expect.poll(() => storedList(page).then((list) => list.find((n) => n.session === only)?.viewed)).toBe(true)

  await expect(workspaceDot(page, directory)).toHaveCount(0)
})

test("session deleted after the error shows as deleted and clicking clears the notification", async ({
  page,
  sdk,
  gotoSession,
  directory,
}) => {
  const doomed = await sdk.session.create({ directory, title: "menu doomed" }).then((r) => r.data?.id)
  expect(doomed).toBeDefined()
  await seed(page, { directory, list: [errorNotification(directory, doomed!, "doomed error", Date.now())] })

  await gotoSession()
  await sdk.session.delete({ sessionID: doomed! })

  await openSidebar(page)
  const avatar = page.locator(`[data-action="project-switch"][data-project="${dirSlug(directory)}"]`).first()
  await avatar.click({ button: "right" })

  const item = page.locator("[data-action='project-error-session']")
  await expect(item).toBeVisible()
  await expect(item).toContainText("Session deleted", { timeout: 15_000 })
  await item.click()

  await expect.poll(() => storedList(page)).toEqual([])
})
