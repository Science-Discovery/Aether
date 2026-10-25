import { execFileSync } from "node:child_process"
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"
import { test, expect, confirmSubmit, promptSend } from "../fixtures"
import { closeDialog, openSettings, sessionIDFromUrl, waitSessionIdle } from "../actions"
import { promptSelector, questionDockSelector } from "../selectors"
import { createSdk } from "../utils"

const executable = (directory: string) => path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex")

async function fixture(directory: string, mode = "normal") {
  const bun = execFileSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" }).trim()
  const source = fileURLToPath(new URL("../../../opencode/test/native/session-fixture.ts", import.meta.url))
  await writeFile(
    executable(directory),
    process.platform === "win32"
      ? `@echo off\r\ncd /d "%~dp0"\r\n"${bun}" "${source}" %*\r\n`
      : `#!/bin/sh\ncd '${directory.replaceAll("'", "'\\''")}' || exit 1\nexec '${bun.replaceAll("'", "'\\''")}' '${source.replaceAll("'", "'\\''")}' "$@"\n`,
  )
  if (process.platform !== "win32") await chmod(executable(directory), 0o755)
  await writeFile(path.join(directory, "scenario.json"), JSON.stringify({ mode }))
  await appendFile(path.join(directory, ".git", "info", "exclude"), "\ncodex\ncodex.cmd\nscenario.json\ncalls.jsonl\n")
}

async function configure(input: { directory: string; sdk: ReturnType<typeof createSdk> }) {
  await input.sdk.global.config.update({ config: { native: { codex: { path: executable(input.directory) } } } })
}

async function choose(page: Page, action: string, label: string) {
  await page.locator(`[data-action="${action}"]`).click()
  await page.getByRole("option", { name: label, exact: true }).click()
}

async function send(page: Page, value: string) {
  const previous = await promptSend(page)
  await page.locator(promptSelector).fill(value)
  await confirmSubmit(page, previous)
  await expect.poll(async () => (await promptSend(page)).count).toBeGreaterThan(previous.count)
}

test("native Codex streams and resumes its saved engine without Aether permissions", async ({
  page,
  project,
}, info) => {
  await project.open({ setup: fixture, beforeGoto: configure })
  await choose(page, "prompt-engine", "Codex")
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
  await expect(page.locator('[data-action="prompt-permissions"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  await choose(page, "prompt-model-variant", "high")
  await send(page, "Read the paper using the native Codex agent.")
  const id = sessionIDFromUrl(page.url())
  if (!id) throw new Error("Native session was not created")
  project.trackSession(id)
  await expect(page.getByText("Native response", { exact: true })).toBeVisible()
  await waitSessionIdle(project.sdk, id)
  const saved = (await project.sdk.session.get({ sessionID: id })).data
  expect(saved?.engine).toMatchObject({ type: "codex", model: "native-model", effort: "high" })
  expect(saved?.engine?.thread).toBeTruthy()
  await page.reload()
  await expect(page.locator('[data-action="prompt-engine"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-engine"]')).toHaveText("Codex")
  await expect(page.locator('[data-action="prompt-model-variant"]')).toHaveText("high")
  await send(page, "Continue with the same Codex thread.")
  await waitSessionIdle(project.sdk, id)
  await expect(page.getByText("Native response", { exact: true }).last()).toBeVisible()
  const messages = (await project.sdk.session.messages({ sessionID: id })).data ?? []
  expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(2)
  expect(
    messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text" && part.text === "Native response"),
  ).toHaveLength(2)
  const calls = (await readFile(path.join(project.directory, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; params?: { threadId?: string } })
  expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1)
  expect(calls.find((call) => call.method === "thread/resume")?.params?.threadId).toBe(saved?.engine?.thread)
  await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("native-conversation.png"), fullPage: true })
})

test("native settings repair an unavailable executable and show separate connection and account state", async ({
  page,
  project,
}, info) => {
  await project.open({
    setup: fixture,
    beforeGoto: async ({ directory, sdk }) => {
      await sdk.global.config.update({ config: { native: { codex: { path: path.join(directory, "missing-codex") } } } })
    },
  })
  await choose(page, "prompt-engine", "Codex")
  await expect(page.locator('[data-action="prompt-native-refresh"]')).toBeVisible()
  const dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Agent backends" }).click()
  const panel = dialog.locator('[data-component="settings-native"]')
  await expect(panel.locator("dd").filter({ hasText: /^Not found$/ })).toBeVisible()
  await panel.getByLabel("Codex executable path", { exact: true }).fill(executable(project.directory))
  await panel.locator('[data-action="native-save"]').click()
  await expect(panel.locator("dd").filter({ hasText: /^Connected$/ })).toBeVisible()
  await expect(panel.locator("dd").filter({ hasText: /^ChatGPT account$/ })).toBeVisible()
  await expect(panel.locator("dd").filter({ hasText: /^Native model, Text model$/ })).toBeVisible()
  expect((await project.sdk.global.config.get()).data?.native?.codex?.path).toBe(executable(project.directory))
  await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("native-settings.png"), fullPage: true })
  await closeDialog(page, dialog)
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
  const session = (await project.sdk.session.create({ title: "Existing Aether conversation" })).data
  if (!session) throw new Error("Legacy session was not created")
  project.trackSession(session.id)
  await project.gotoSession(session.id)
  await expect(page.locator('[data-action="prompt-engine"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-engine"]')).toHaveText("Aether")
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveCount(0)
})

test("native file approval shows the proposed diff and clears after declining", async ({ page, project }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await project.open({ setup: (directory) => fixture(directory, "file-approval"), beforeGoto: configure })
  await choose(page, "prompt-engine", "Codex")
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
  await send(page, "Propose a revision to the paper and ask before changing it.")
  const id = sessionIDFromUrl(page.url())
  if (!id) throw new Error("Native session was not created")
  project.trackSession(id)
  const dock = page.locator(questionDockSelector)
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-custom="true"]')).toHaveCount(0)
  const preview = page.locator('[data-component="codex-file-change"]')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText("paper.tex")
  await expect(preview.locator('[data-slot="codex-change-diff"]')).toHaveText("-Old result\n+Verified result")
  await expect(dock).toContainText("paper.tex")
  await expect(dock).toContainText("-Old result")
  await expect(dock).toContainText("+Verified result")
  expect(await dock.locator('[data-slot="question-text"]').textContent()).toContain("-Old result\n+Verified result")
  const messages = (await project.sdk.session.messages({ sessionID: id })).data ?? []
  expect(
    messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "codex.fileChange"),
  ).toMatchObject({ state: { status: "running" } })
  await page.screenshot({ path: info.outputPath("native-file-approval.png"), fullPage: true })
  await dock.locator('[data-slot="question-option"]').filter({ hasText: "Decline" }).click()
  await dock.getByRole("button", { name: /submit/i }).click()
  await expect(dock).toHaveCount(0)
  await waitSessionIdle(project.sdk, id)
  expect((await project.sdk.question.list()).data?.filter((question) => question.sessionID === id)).toEqual([])
  const calls = (await readFile(path.join(project.directory, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { result?: { decision?: string } })
  expect(calls.some((call) => call.result?.decision === "decline")).toBe(true)
})
