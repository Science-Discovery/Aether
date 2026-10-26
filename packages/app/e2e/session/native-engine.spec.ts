import { execFileSync } from "node:child_process"
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Page, Route } from "@playwright/test"
import { test, expect, confirmSubmit, promptSend } from "../fixtures"
import { closeDialog, openSettings, openSidebar, sessionIDFromUrl, waitSessionIdle } from "../actions"
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

async function calls(directory: string) {
  return (await readFile(path.join(directory, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as {
        method?: string
        pid?: number
        params?: { threadId?: string }
        result?: { decision?: string }
      },
    )
}

test("native Codex streams and reuses its warm thread without Aether permissions", async ({
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
  const log = await calls(project.directory)
  const turns = log.filter((call) => call.method === "turn/start")
  expect(log.filter((call) => call.method === "thread/start")).toHaveLength(1)
  expect(log.filter((call) => call.method === "thread/resume")).toHaveLength(0)
  expect(log.some((call) => call.method === "thread/read" && call.params?.threadId === saved?.engine?.thread)).toBe(true)
  expect(turns).toHaveLength(2)
  expect(turns[0].pid).toBeGreaterThan(0)
  expect(turns.map((call) => call.pid)).toEqual([turns[0].pid, turns[0].pid])
  expect(turns.map((call) => call.params?.threadId)).toEqual([saved?.engine?.thread, saved?.engine?.thread])
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
  await expect(panel.locator('[data-action="native-enabled"] [data-slot="switch-input"]')).toBeChecked()
  await expect(panel.getByLabel("Idle Codex processes to keep", { exact: true })).toHaveValue("4")
  await expect(panel.locator("dd").filter({ hasText: /^Not found$/ })).toBeVisible()
  await panel.getByLabel("Codex executable path", { exact: true }).fill(executable(project.directory))
  await panel.locator('[data-action="native-save"]').click()
  await expect(panel.locator("dd").filter({ hasText: /^Connected$/ })).toBeVisible()
  await expect(panel.locator("dd").filter({ hasText: /^ChatGPT account$/ })).toBeVisible()
  await expect(panel.locator("dd").filter({ hasText: /^Native model, Text model$/ })).toBeVisible()
  expect((await project.sdk.global.config.get()).data?.native?.codex?.path).toBe(executable(project.directory))
  await panel.getByLabel("Idle Codex processes to keep", { exact: true }).fill("2")
  await panel.locator('[data-action="native-save"]').click()
  await expect.poll(async () => (await project.sdk.global.config.get()).data?.native?.codex?.limit).toBe(2)
  await expect(panel.locator('[data-action="native-save"]')).toBeEnabled()
  await expect(page.locator('[data-component="toast"]')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("native-settings.png"), fullPage: true })
  await closeDialog(page, dialog)
  const reopened = await openSettings(page)
  await reopened.getByRole("tab", { name: "Agent backends" }).click()
  await expect(reopened.getByLabel("Idle Codex processes to keep", { exact: true })).toHaveValue("2")
  await expect(reopened.getByLabel("Codex executable path", { exact: true })).toHaveValue(executable(project.directory))
  await closeDialog(page, reopened)
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
  const session = (await project.sdk.session.create({ title: "Existing Aether conversation" })).data
  if (!session) throw new Error("Legacy session was not created")
  project.trackSession(session.id)
  await project.gotoSession(session.id)
  await expect(page.locator('[data-action="prompt-engine"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-engine"]')).toHaveText("Aether")
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveCount(0)
  await project.sdk.global.config.update({ config: { native: { codex: { limit: 4 } } } })
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
  expect((await calls(project.directory)).some((call) => call.result?.decision === "decline")).toBe(true)
})

test("project conversations are grouped by backend and keep their saved identity when switching", async ({ page, project }) => {
  await project.open({ setup: fixture, beforeGoto: configure })
  const aether = (await project.sdk.session.create({ title: "Aether research notes" })).data
  const codex = (
    await project.sdk.session.create({
      title: "Codex paper revision",
      engine: { type: "codex", model: "native-model" },
    })
  ).data
  if (!aether || !codex) throw new Error("Backend conversations were not created")
  project.trackSession(aether.id)
  project.trackSession(codex.id)
  await project.gotoSession(codex.id)
  await openSidebar(page)
  const legacy = page.locator('[data-component="session-backend-group"][data-backend="aether"]:visible')
  const native = page.locator('[data-component="session-backend-group"][data-backend="codex"]:visible')
  await expect(legacy.getByRole("heading", { name: "Aether", exact: true })).toBeVisible()
  await expect(native.getByRole("heading", { name: "Codex", exact: true })).toBeVisible()
  await expect(legacy.locator(`[data-session-id="${aether.id}"] [data-component="session-backend"]`)).toHaveText("Aether")
  await expect(native.locator(`[data-session-id="${codex.id}"] [data-component="session-backend"]`)).toHaveText("Codex")
  await expect(legacy.locator(`[data-session-id="${codex.id}"]`)).toHaveCount(0)
  await legacy.locator(`[data-session-id="${aether.id}"] a`).click()
  await expect(page.locator('[data-action="prompt-engine"]')).toHaveText("Aether")
  await expect(page.locator('[data-action="prompt-engine"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveCount(0)
  await native.locator(`[data-session-id="${codex.id}"] a`).click()
  await expect(page.locator('[data-action="prompt-engine"]')).toHaveText("Codex")
  await expect(page.locator('[data-action="prompt-engine"]')).toBeDisabled()
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
})

test("turning Codex off blocks new requests and enabling it resumes the saved thread", async ({ page, project }) => {
  await project.open({ setup: fixture, beforeGoto: configure })
  await choose(page, "prompt-engine", "Codex")
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
  await send(page, "Start a persistent Codex conversation.")
  const id = sessionIDFromUrl(page.url())
  if (!id) throw new Error("Native session was not created")
  project.trackSession(id)
  await expect(page.getByText("Native response", { exact: true })).toBeVisible()
  await waitSessionIdle(project.sdk, id)
  const saved = (await project.sdk.session.get({ sessionID: id })).data
  const dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Agent backends" }).click()
  const toggle = dialog.locator('[data-action="native-enabled"]')
  await expect(toggle.locator('[data-slot="switch-input"]')).toBeChecked()
  await toggle.locator('[data-slot="switch-control"]').click()
  try {
    await expect(toggle.locator('[data-slot="switch-input"]')).not.toBeChecked()
    await expect.poll(async () => (await project.sdk.global.config.get()).data?.native?.codex?.enabled).toBe(false)
    await closeDialog(page, dialog)
    await expect(page.getByText("Native response", { exact: true })).toBeVisible()
    await expect(page.getByText("Codex is turned off in Settings", { exact: true })).toBeVisible()
    await page.locator(promptSelector).fill("This must stay an unsent draft.")
    await expect(page.locator('[data-action="prompt-submit"]')).toBeDisabled()
    await page.locator(promptSelector).press("Enter")
    expect((await calls(project.directory)).filter((call) => call.method === "turn/start")).toHaveLength(1)
    expect(
      (await project.sdk.session.messages({ sessionID: id })).data?.filter((message) => message.info.role === "user"),
    ).toHaveLength(1)
    const settings = await openSettings(page)
    await settings.getByRole("tab", { name: "Agent backends" }).click()
    await settings.locator('[data-action="native-enabled"] [data-slot="switch-control"]').click()
    await expect(settings.locator('[data-action="native-enabled"] [data-slot="switch-input"]')).toBeChecked()
    await expect.poll(async () => (await project.sdk.global.config.get()).data?.native?.codex?.enabled).toBe(true)
    await closeDialog(page, settings)
    await expect(page.getByText("Codex is turned off in Settings", { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
    await expect(page.locator('[data-action="prompt-native-model"]')).toBeEnabled()
    expect((await calls(project.directory)).filter((call) => call.method === "turn/start")).toHaveLength(1)
    await send(page, "Continue the saved Codex thread after enabling it.")
    await waitSessionIdle(project.sdk, id)
    await expect(page.getByText("Native response", { exact: true })).toHaveCount(2)
    const log = await calls(project.directory)
    expect(log.filter((call) => call.method === "thread/start")).toHaveLength(1)
    expect(log.find((call) => call.method === "thread/resume")?.params?.threadId).toBe(saved?.engine?.thread)
    expect((await project.sdk.session.get({ sessionID: id })).data?.engine?.thread).toBe(saved?.engine?.thread)
  } finally {
    await project.sdk.global.config.update({ config: { native: { codex: { enabled: true, limit: 4 } } } })
  }
})

test("backend selection and typing remain available while Codex connection detection is pending", async ({ page, project }) => {
  await project.open({ setup: fixture, beforeGoto: configure })
  await choose(page, "prompt-engine", "Codex")
  await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
  const dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Agent backends" }).click()
  const panel = dialog.locator('[data-component="settings-native"]')
  await expect(panel.locator("dd").filter({ hasText: /^Connected$/ })).toBeVisible()
  const pending: Route[] = []
  await page.route(/\/native\/codex(?:\?|$)/, (route) => {
    pending.push(route)
  })
  try {
    await panel.locator('[data-action="native-refresh"]').click()
    await expect.poll(() => pending.length).toBeGreaterThan(0)
    await expect(panel.locator('[data-action="native-refresh"]')).toBeDisabled()
    await closeDialog(page, dialog)
    await expect(page.locator(promptSelector)).toBeVisible()
    await choose(page, "prompt-engine", "Aether")
    await expect(page.locator('[data-action="prompt-engine"]')).toHaveText("Aether")
    await page.locator(promptSelector).fill("Keep this draft while checking the connection.")
    await expect(page.locator(promptSelector)).toHaveText("Keep this draft while checking the connection.")
    await choose(page, "prompt-engine", "Codex")
    await expect(page.locator('[data-action="prompt-engine"]')).toHaveText("Codex")
    await expect(page.locator(promptSelector)).toHaveText("Keep this draft while checking the connection.")
    await Promise.all(pending.splice(0).map((route) => route.continue()))
    await expect(page.locator('[data-action="prompt-native-model"]')).toHaveText("Native model")
    await expect(page.locator('[data-action="prompt-native-model"]')).toBeEnabled()
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" })
    await Promise.all(pending.map((route) => route.abort().catch(() => undefined)))
  }
})
