import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"

import { test, expect } from "../fixtures"
import { cleanupTestProject, openSidebar, resolveSlug, waitSlug } from "../actions"
import { createSdk, resolveDirectory, serverUrl } from "../utils"

async function gitlessProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-e2e-initgit-"))
  await fs.writeFile(path.join(root, "README.md"), "# e2e initgit\n")
  return resolveDirectory(root, serverUrl)
}

async function hasGit(directory: string) {
  return fs
    .stat(path.join(directory, ".git"))
    .then(() => true)
    .catch(() => false)
}

async function openProjectViaDialog(page: Page, directory: string) {
  await page.goto("/")
  const open = page.getByRole("button", { name: "Open project" }).first()
  await expect(open).toBeVisible()
  await open.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("textbox").first().fill(directory)
  await dialog.getByRole("button", { name: "Confirm" }).click()

  await waitSlug(page)
  return resolveSlug(await waitSlug(page))
}

test("new project defaults to a git repository and enabled workspaces", async ({ page }) => {
  test.setTimeout(120_000)
  const directory = await gitlessProject()
  try {
    expect(await hasGit(directory)).toBe(false)

    await openProjectViaDialog(page, directory)

    const sdk = createSdk(directory, serverUrl)
    await expect
      .poll(
        () =>
          sdk.project
            .current()
            .then((x) => x.data?.vcs)
            .catch(() => undefined),
        { timeout: 30_000 },
      )
      .toBe("git")
    await expect.poll(() => hasGit(directory), { timeout: 30_000 }).toBe(true)

    await openSidebar(page)
    await expect(page.getByRole("button", { name: "New workspace" }).first()).toBeVisible()
  } finally {
    await cleanupTestProject(directory)
  }
})

test("disabling auto git init keeps new projects git-less", async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { autoGitInit: false } }))
  })

  const directory = await gitlessProject()
  try {
    const project = await openProjectViaDialog(page, directory)
    expect(project.directory).toBe(directory)

    const sdk = createSdk(directory, serverUrl)
    await expect
      .poll(
        () =>
          sdk.project
            .current()
            .then((x) => x.data?.worktree)
            .catch(() => undefined),
        { timeout: 30_000 },
      )
      .toBe(directory)

    // Auto git init is issued while the project opens, so once the instance is
    // registered and this settle window passes, a broken gate would have
    // already created .git. Absence after the window proves the gate held.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(await hasGit(directory)).toBe(false)
    const vcs = await sdk.project
      .current()
      .then((x) => x.data?.vcs)
      .catch(() => "error")
    expect(vcs).toBeUndefined()

    await openSidebar(page)
    await expect(page.getByRole("button", { name: "New workspace" })).toHaveCount(0)
  } finally {
    await cleanupTestProject(directory)
  }
})
