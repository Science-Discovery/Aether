import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"
import { modKey } from "../utils"

const executable = process.env.AETHER_E2E_TECTONIC
const main =
  "\\documentclass{article}\n\\begin{document}\n\\section{Aether paper}\n\\input{section}\nA reference: \\cite{sample}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n"
const bibliography =
  "@article{sample, author={Researcher, A.}, title={Original title}, journal={Research}, year={2026}}\n"

type Page = Parameters<typeof import("../actions").openPalette>[0]

async function open(page: Page, filename: string) {
  await page.locator(promptSelector).first().click()
  await page.keyboard.type("/open")
  await expect(page.locator('[data-slash-id="file.open"]').first()).toBeVisible()
  await page.keyboard.press("Enter")
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByPlaceholder(/search files/i) })
    .first()
  await dialog.getByRole("textbox").first().fill(filename)
  const item = dialog.locator('[data-slot="list-item"][data-key^="file:"]').filter({ hasText: filename }).first()
  await expect(item).toBeVisible()
  await item.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-component="latex-workspace"]:visible')).toBeVisible()
}

async function edit(page: Page, content: string) {
  const editor = page.locator('[data-component="latex-workspace"]:visible [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press(`${modKey}+a`)
  await page.keyboard.insertText(content)
  await expect(editor).toContainText(content.trim().split("\n")[0])
}

async function preview(page: Page) {
  const toolbar = page.locator('[data-component="latex-reading-toolbar"]:visible')
  await expect(toolbar).toBeVisible()
  await expect(page.locator('[data-component="latex-workspace"]:visible iframe')).toHaveCount(0)
  await expect(toolbar.locator("..").frameLocator('iframe[title="PDF Viewer"]').locator(".page").first()).toBeVisible()
}

async function setup(directory: string) {
  await Promise.all([
    writeFile(path.join(directory, "main.tex"), main),
    writeFile(path.join(directory, "section.tex"), "A saved section.\n"),
    writeFile(path.join(directory, "refs.bib"), bibliography),
  ])
}

test.describe("LaTeX workspace with a real compiler", () => {
  test.skip(!executable, "Set AETHER_E2E_TECTONIC to run against an installed Tectonic compiler")
  test.setTimeout(120_000)

  test("automatically saves a closed bibliography draft and previews it in the independent reading pane", async ({
    page,
    project,
  }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await project.open({
      setup,
      beforeGoto: async ({ sdk }) => {
        await sdk.global.config.update({ config: { latex: { tectonic: { path: executable } } } })
      },
    })
    await open(page, "main.tex")
    const tree = page.getByRole("button", { name: "Close file tree", exact: true })
    if (await tree.isVisible()) await tree.click()
    await page.locator('[data-action="latex-bind"]:visible').click()
    await expect(page.getByRole("checkbox", { name: "Auto compile", exact: true })).toBeChecked()
    await expect(page.locator('[data-component="latex-build-status"]:visible')).toHaveText("Succeeded", {
      timeout: 60_000,
    })
    const previous = (await project.sdk.latex.project({ path: "main.tex" })).data?.lastSuccessful?.id
    await preview(page)
    await open(page, "refs.bib")
    await edit(page, bibliography.replace("Original title", "Edited bibliography title"))
    const tab = page.getByRole("tab").filter({ hasText: "refs" }).first()
    const wrapper = page.locator('[data-slot="tabs-trigger-wrapper"]').filter({ has: tab })
    await wrapper.hover()
    await wrapper.getByRole("button", { name: /close tab/i }).click()
    await page.getByRole("tab").filter({ hasText: "main" }).first().click()
    await expect
      .poll(() => readFile(path.join(project.directory, "refs.bib"), "utf8"))
      .toContain("Edited bibliography title")
    await expect
      .poll(async () => (await project.sdk.latex.project({ path: "main.tex" })).data?.lastSuccessful?.id, {
        timeout: 60_000,
      })
      .not.toBe(previous)
    await expect(page.locator('[data-component="latex-build-status"]:visible')).toHaveText("Succeeded")
    await expect(page.locator('[data-component="latex-save-status"]:visible')).toHaveText("Changes saved")
    await expect(page.locator('[data-component="latex-preview-status"]:visible')).toHaveAttribute(
      "data-current",
      "true",
    )
    await preview(page)
    await page.screenshot({ path: info.outputPath("latex-compiled-bibliography.png"), fullPage: true })
    await info.attach("Compiled multi-file paper", {
      path: info.outputPath("latex-compiled-bibliography.png"),
      contentType: "image/png",
    })
    await open(page, "refs.bib")
    await expect(page.getByRole("button", { name: "Restore old draft" })).toHaveCount(0)
    await expect(page.locator('[data-component="latex-workspace"]:visible [contenteditable="true"]')).toContainText(
      "Edited bibliography title",
    )
  })

  test("a failed build keeps the old PDF and diagnostics navigate to the source line", async ({
    page,
    project,
  }, info) => {
    await project.open({
      setup,
      beforeGoto: async ({ sdk }) => {
        await sdk.global.config.update({ config: { latex: { tectonic: { path: executable } } } })
      },
    })
    await open(page, "main.tex")
    await page.locator('[data-action="latex-bind"]:visible').click()
    await expect(page.locator('[data-component="latex-build-status"]:visible')).toHaveText("Succeeded", {
      timeout: 60_000,
    })
    const previous = (await project.sdk.latex.project({ path: "main.tex" })).data?.lastSuccessful?.id
    expect(previous).toBeTruthy()
    await preview(page)
    await open(page, "section.tex")
    await edit(page, "First line.\n\\undefinedaethercommand\n")
    await expect(page.locator('[data-component="latex-build-status"]:visible')).toHaveText("Failed", {
      timeout: 60_000,
    })
    await expect(page.locator('[data-component="latex-preview-status"]:visible')).toHaveAttribute(
      "data-current",
      "false",
    )
    expect((await project.sdk.latex.project({ path: "section.tex" })).data?.lastSuccessful?.id).toBe(previous)
    await preview(page)
    const diagnostic = page
      .locator('[data-component="latex-diagnostics"]:visible button')
      .filter({ hasText: "section.tex:2" })
      .first()
    await expect(diagnostic).toBeVisible()
    await diagnostic.click()
    await expect(page.locator('[data-component="latex-workspace"]:visible [contenteditable="true"]')).toBeFocused()
    await expect(page.locator('[data-component="latex-workspace"]:visible .cm-activeLine')).toContainText(
      "\\undefinedaethercommand",
    )
    await page.screenshot({ path: info.outputPath("latex-failed-diagnostic.png"), fullPage: true })
    await info.attach("Retained PDF and source diagnostic", {
      path: info.outputPath("latex-failed-diagnostic.png"),
      contentType: "image/png",
    })
  })

  test("external conflicts preserve closed drafts and do not start a build", async ({ page, project }, info) => {
    await project.open({
      setup,
      beforeGoto: async ({ sdk }) => {
        await sdk.global.config.update({ config: { latex: { tectonic: { path: executable } } } })
      },
    })
    await open(page, "main.tex")
    await page.getByRole("checkbox", { name: "Auto compile", exact: true }).uncheck()
    await page.locator('[data-action="latex-bind"]:visible').click()
    let injected = false
    await page.route("**/file/content*", async (route) => {
      if (injected || route.request().method() !== "PUT") return route.continue()
      const body = route.request().postDataJSON() as { path?: string }
      if (body.path !== "refs.bib") return route.continue()
      injected = true
      // Write between the editor's base capture and the real server's CAS check.
      await writeFile(
        path.join(project.directory, "refs.bib"),
        bibliography.replace("Original title", "External title"),
      )
      await route.continue()
    })
    await open(page, "refs.bib")
    await edit(page, bibliography.replace("Original title", "My unsaved title"))
    const tab = page.getByRole("tab").filter({ hasText: "refs" }).first()
    const wrapper = page.locator('[data-slot="tabs-trigger-wrapper"]').filter({ has: tab })
    await wrapper.hover()
    await wrapper.getByRole("button", { name: /close tab/i }).click()
    await page.getByRole("tab").filter({ hasText: "main" }).first().click()
    await expect(page.locator('[data-component="latex-workspace"]:visible [role="alert"]')).toContainText("refs.bib")
    await expect(page.locator('[data-action="latex-compile"]:visible')).toBeDisabled()
    await expect(page.locator('[data-component="latex-save-status"]:visible')).toHaveText("Automatic saving paused")
    expect((await project.sdk.latex.project({ path: "main.tex" })).data?.latest).toBeUndefined()
    expect(await readFile(path.join(project.directory, "refs.bib"), "utf8")).toContain("External title")
    await open(page, "refs.bib")
    const restore = page.getByRole("button", { name: "Restore old draft" })
    if (await restore.isVisible()) await restore.click()
    await expect(page.locator('[data-component="latex-workspace"]:visible [contenteditable="true"]')).toContainText(
      "My unsaved title",
    )
    await page.screenshot({ path: info.outputPath("latex-conflict-preserved.png"), fullPage: true })
    await info.attach("Preserved conflicting draft", {
      path: info.outputPath("latex-conflict-preserved.png"),
      contentType: "image/png",
    })
  })

  test("ambiguous main documents require a choice and project folders remain independent", async ({
    page,
    project,
  }, info) => {
    await project.open({
      setup: async (directory) => {
        await setup(directory)
        await mkdir(path.join(directory, "paper"))
        await writeFile(path.join(directory, "other.tex"), main)
        await writeFile(
          path.join(directory, "paper", "main.tex"),
          "\\documentclass{article}\n\\begin{document}Another paper\\end{document}",
        )
      },
      beforeGoto: async ({ sdk }) => {
        await sdk.global.config.update({ config: { latex: { tectonic: { path: executable } } } })
      },
    })
    await open(page, "main.tex")
    await page.getByRole("checkbox", { name: "Auto compile", exact: true }).uncheck()
    await expect(page.locator('[data-action="latex-compile"]:visible')).toBeDisabled()
    await page.getByLabel("Main document", { exact: true }).fill("other.tex")
    await page.locator('[data-action="latex-bind"]:visible').click()
    await expect(page.locator('[data-action="latex-compile"]:visible')).toBeEnabled()
    await page
      .locator('[data-component="latex-workspace"]:visible')
      .getByRole("button", { name: "other.tex", exact: true })
      .click()
    await page.getByLabel("Project folder", { exact: true }).fill("paper")
    await page
      .locator('[data-component="latex-workspace"]:visible')
      .getByRole("button", { name: "Open project", exact: true })
      .click()
    await expect(page.getByLabel("Main document", { exact: true })).toHaveValue("main.tex")
    await expect(page.locator('[data-action="latex-compile"]:visible')).toBeDisabled()
    await page.locator('[data-action="latex-bind"]:visible').click()
    await expect(page.locator('[data-action="latex-compile"]:visible')).toBeEnabled()
    expect((await project.sdk.latex.project({ root: "." })).data?.binding?.main).toBe("other.tex")
    expect((await project.sdk.latex.project({ root: "paper" })).data?.binding?.main).toBe("main.tex")
    await page.screenshot({ path: info.outputPath("latex-project-bindings.png"), fullPage: true })
    await info.attach("Independent main document bindings", {
      path: info.outputPath("latex-project-bindings.png"),
      contentType: "image/png",
    })
  })
})
