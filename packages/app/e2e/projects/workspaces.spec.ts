import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { base64Decode } from "@opencode-ai/util/encode"
import type { Page } from "@playwright/test"

import { test, expect } from "../fixtures"

test.describe.configure({ mode: "serial" })
import {
  cleanupTestProject,
  clickMenuItem,
  confirmDialog,
  openSidebar,
  resolveSlug,
  setWorkspacesEnabled,
  slugFromUrl,
  waitDir,
  waitSlug,
} from "../actions"
import {
  dropdownMenuContentSelector,
  inlineInputSelector,
  workspaceItemSelector,
  workspaceMenuTriggerSelector,
} from "../selectors"
import { createSdk, dirSlug } from "../utils"

type Space = { directory: string; slug: string; raw?: string }

function slugs(space: string | Space) {
  if (typeof space === "string") return [space]
  if (process.platform !== "win32") return [space.slug]
  return [...new Set([space.slug, space.raw].filter((item): item is string => !!item))]
}

function itemSelector(space: string | Space) {
  return slugs(space).map(workspaceItemSelector).join(", ")
}

function menuSelector(space: string | Space) {
  return slugs(space).map(workspaceMenuTriggerSelector).join(", ")
}

async function openMenu(page: Page, space: string | Space) {
  const item = page.locator(itemSelector(space)).first()
  await expect(item).toBeVisible()
  await item.hover()

  const trigger = page.locator(menuSelector(space)).first()
  await expect(trigger).toBeVisible()
  await trigger.click({ force: true })

  const menu = page.locator(dropdownMenuContentSelector).first()
  await expect(menu).toBeVisible()
  return menu
}

function key(dir: string) {
  const next = dir.replace(/\\/g, "/")
  return next.toLowerCase().replace(/\/+$/, "")
}

async function same(dir: string) {
  return fs.realpath(dir).then(key).catch(() => key(dir))
}

async function listed(list: string[], dir: string) {
  if (process.platform !== "win32") return list.includes(dir)
  const target = await same(dir)
  return (await Promise.all(list.map(same))).includes(target)
}

async function setupWorkspaceTest(page: Page, project: { slug: string }) {
  const rootSlug = project.slug
  await openSidebar(page)

  await setWorkspacesEnabled(page, rootSlug, true)

  await page.getByRole("button", { name: "New workspace" }).first().click()
  const next = await resolveSlug(await waitSlug(page, [rootSlug]))
  await waitDir(page, next.directory)

  await openSidebar(page)

  await expect
    .poll(
      async () => {
        const item = page.locator(itemSelector(next)).first()
        try {
          await item.hover({ timeout: 500 })
          return true
        } catch {
          return false
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true)

  return { rootSlug, ...next }
}

test("can enable and disable workspaces from project menu", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withProject(async ({ slug }) => {
    await openSidebar(page)

    await expect(page.getByRole("button", { name: "New session" }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "New workspace" })).toHaveCount(0)

    await setWorkspacesEnabled(page, slug, true)
    await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible()
    await expect(page.locator(workspaceItemSelector(slug)).first()).toBeVisible()

    await setWorkspacesEnabled(page, slug, false)
    await expect(page.getByRole("button", { name: "New session" }).first()).toBeVisible()
    await expect(page.locator(workspaceItemSelector(slug))).toHaveCount(0)
  })
})

test("can create a workspace", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withProject(async ({ slug }) => {
    await openSidebar(page)
    await setWorkspacesEnabled(page, slug, true)

    await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible()

    await page.getByRole("button", { name: "New workspace" }).first().click()
    const next = await resolveSlug(await waitSlug(page, [slug]))
    await waitDir(page, next.directory)

    await openSidebar(page)

    await expect
      .poll(
        async () => {
          const item = page.locator(itemSelector(next)).first()
          try {
            await item.hover({ timeout: 500 })
            return true
          } catch {
            return false
          }
        },
        { timeout: 60_000 },
      )
      .toBe(true)

    await expect(page.locator(itemSelector(next)).first()).toBeVisible()

    await cleanupTestProject(next.directory)
  })
})

test("non-git projects keep workspace mode disabled", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-e2e-project-nongit-"))
  const nonGitSlug = dirSlug(nonGit)

  await fs.writeFile(path.join(nonGit, "README.md"), "# e2e nongit\n")

  try {
    await withProject(async () => {
      await page.goto(`/${nonGitSlug}/session`)

      await expect.poll(() => slugFromUrl(page.url()), { timeout: 30_000 }).not.toBe("")

      const activeDir = await resolveSlug(slugFromUrl(page.url())).then((item) => item.directory)
      expect(path.basename(activeDir)).toContain("opencode-e2e-project-nongit-")

      await openSidebar(page)
      await expect(page.getByRole("button", { name: "New workspace" })).toHaveCount(0)

      const trigger = page.locator('[data-action="project-menu"]').first()
      const hasMenu = await trigger
        .isVisible()
        .then((x) => x)
        .catch(() => false)
      if (!hasMenu) return

      await trigger.click({ force: true })

      const menu = page.locator(dropdownMenuContentSelector).first()
      await expect(menu).toBeVisible()

      const toggle = menu.locator('[data-action="project-workspaces-toggle"]').first()

      await expect(toggle).toBeVisible()
      await expect(toggle).toBeDisabled()
      await expect(menu.getByRole("menuitem", { name: "New workspace" })).toHaveCount(0)
    })
  } finally {
    await cleanupTestProject(nonGit)
  }
})

test("can rename a workspace", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withProject(async (project) => {
    const space = await setupWorkspaceTest(page, project)

    const rename = `e2e workspace ${Date.now()}`
    const menu = await openMenu(page, space)
    await clickMenuItem(menu, /Rename Workspace/i, { force: true })

    await expect(menu).toHaveCount(0)

    const item = page.locator(itemSelector(space)).first()
    await expect(item).toBeVisible()
    const input = item.locator(inlineInputSelector).first()
    await expect(input).toBeVisible()
    await input.fill(rename)
    await input.press("Enter")
    await expect(item).toContainText(rename)
  })
})

test("can reset a workspace", async ({ page, sdk, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withProject(async (project) => {
    const space = await setupWorkspaceTest(page, project)
    const createdDir = space.directory

    const readme = path.join(createdDir, "README.md")
    const extra = path.join(createdDir, `e2e_reset_${Date.now()}.txt`)
    const original = await fs.readFile(readme, "utf8")
    const dirty = `${original.trimEnd()}\n\nchange_${Date.now()}\n`
    await fs.writeFile(readme, dirty, "utf8")
    await fs.writeFile(extra, `created_${Date.now()}\n`, "utf8")

    await expect
      .poll(async () => {
        return await fs
          .stat(extra)
          .then(() => true)
          .catch(() => false)
      })
      .toBe(true)

    await expect
      .poll(async () => {
        const files = await sdk.file
          .status({ directory: createdDir })
          .then((r) => r.data ?? [])
          .catch(() => [])
        return files.length
      })
      .toBeGreaterThan(0)

    const menu = await openMenu(page, space)
    await clickMenuItem(menu, /^Reset$/i, { force: true })
    await confirmDialog(page, /^Reset workspace$/i)

    await expect
      .poll(
        async () => {
          const files = await sdk.file
            .status({ directory: createdDir })
            .then((r) => r.data ?? [])
            .catch(() => [])
          return files.length
        },
        { timeout: 60_000 },
      )
      .toBe(0)

    await expect.poll(() => fs.readFile(readme, "utf8"), { timeout: 60_000 }).toBe(original)

    await expect
      .poll(async () => {
        return await fs
          .stat(extra)
          .then(() => true)
          .catch(() => false)
      })
      .toBe(false)
  })
})

test("can delete a workspace", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withProject(async (project) => {
    const sdk = createSdk(project.directory)
    const space = await setupWorkspaceTest(page, project)
    const rootSlug = space.rootSlug
    const directory = space.directory

    await expect
      .poll(
        async () => {
          const worktrees = await sdk.worktree
            .list()
            .then((r) => r.data ?? [])
            .catch(() => [] as string[])
          return listed(worktrees, directory)
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    const menu = await openMenu(page, space)
    await clickMenuItem(menu, /^Delete$/i, { force: true })
    await confirmDialog(page, /^Delete workspace$/i)

    await expect.poll(() => base64Decode(slugFromUrl(page.url()))).toBe(project.directory)

    await expect
      .poll(
        async () => {
          const worktrees = await sdk.worktree
            .list()
            .then((r) => r.data ?? [])
            .catch(() => [] as string[])
          return listed(worktrees, directory)
        },
        { timeout: 60_000 },
      )
      .toBe(false)

    await project.gotoSession()

    await openSidebar(page)
    await expect(page.locator(itemSelector(space))).toHaveCount(0, { timeout: 60_000 })
    await expect(page.locator(workspaceItemSelector(rootSlug)).first()).toBeVisible()
  })
})

test("can reorder workspaces by drag and drop", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  await withProject(async ({ slug: rootSlug }) => {
    const workspaces = [] as Space[]

    const listSlugs = async () => {
      const nodes = page.locator('[data-component="sidebar-nav-desktop"] [data-component="workspace-item"]')
      const slugs = await nodes.evaluateAll((els) => {
        return els.map((el) => el.getAttribute("data-workspace") ?? "").filter((x) => x.length > 0)
      })
      return slugs
    }

    const waitReady = async (space: Space) => {
      await expect
        .poll(
          async () => {
            const item = page.locator(itemSelector(space)).first()
            try {
              await item.hover({ timeout: 500 })
              return true
            } catch {
              return false
            }
          },
          { timeout: 60_000 },
        )
        .toBe(true)
    }

    const current = async (space: Space) => {
      await waitReady(space)
      const slug = await page.locator(itemSelector(space)).first().getAttribute("data-workspace")
      if (!slug) throw new Error(`Failed to resolve workspace slug for ${space.directory}`)
      return slug
    }

    const drag = async (from: string, to: string) => {
      const src = page.locator(workspaceItemSelector(from)).first()
      const dst = page.locator(workspaceItemSelector(to)).first()

      const a = await src.boundingBox()
      const b = await dst.boundingBox()
      if (!a || !b) throw new Error("Failed to resolve workspace drag bounds")

      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
      await page.mouse.up()
    }

    try {
      await openSidebar(page)

      await setWorkspacesEnabled(page, rootSlug, true)

      for (const _ of [0, 1]) {
        const prev = slugFromUrl(page.url())
        await page.getByRole("button", { name: "New workspace" }).first().click()
        const next = await resolveSlug(await waitSlug(page, [rootSlug, prev]))
        await waitDir(page, next.directory)
        workspaces.push(next)

        await openSidebar(page)
      }

      if (workspaces.length !== 2) throw new Error("Expected two created workspaces")

      const a = await current(workspaces[0])
      const b = await current(workspaces[1])

      const list = async () => {
        const slugs = await listSlugs()
        return slugs.filter((s) => s !== rootSlug && (s === a || s === b)).slice(0, 2)
      }

      await expect
        .poll(async () => {
          const slugs = await list()
          return slugs.length === 2
        })
        .toBe(true)

      const before = await list()
      const from = before[1]
      const to = before[0]
      if (!from || !to) throw new Error("Failed to resolve initial workspace order")

      await drag(from, to)

      await expect.poll(async () => await list()).toEqual([from, to])
    } finally {
      await Promise.all(workspaces.map((w) => cleanupTestProject(w.directory)))
    }
  })
})
