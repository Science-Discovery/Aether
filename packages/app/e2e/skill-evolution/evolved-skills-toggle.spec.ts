import fs from "node:fs/promises"
import path from "node:path"
import { test, expect } from "../fixtures"

// End-to-end check of the evolved-skills dialog toggles. The core fact under test:
// flipping a skill's switch off in the dialog writes its SKILL.md path into the
// PROJECT's aether.json disabled_files (the file the loader actually reads), and the
// dialog's displayed state is computed back from that config — not from frontmatter.

async function writeEvolvedSkill(directory: string, name: string, description: string): Promise<string> {
  const dir = path.join(directory, ".aether", "skills", name)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, "SKILL.md")
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, "utf8")
  return file
}

async function readProjectConfig(directory: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(directory, "aether.json"), "utf8").catch(() => "{}"))
}

async function openEvolvedSkillsDialog(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Skills Evolution" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  // Groups (by container dir) render collapsed; expand the .aether/skills group so
  // its skill rows (and switches) become visible.
  const group = dialog.getByRole("button", { name: /\.aether[\\/]skills/ })
  await expect(group).toBeVisible()
  if ((await group.getAttribute("aria-expanded")) !== "true") await group.click()
  return dialog
}

test("disabling a skill in the dialog writes disabled_files and the switch reflects it", async ({
  page,
  withProject,
}) => {
  await withProject(async ({ directory }) => {
    const skillFile = await writeEvolvedSkill(directory, "demo-skill", "a demo skill")

    // Open the dialog and expand the group so the skill row (and its switch) shows.
    let dialog = await openEvolvedSkillsDialog(page)
    await expect(dialog.getByText("demo-skill", { exact: true })).toBeVisible()

    // The switch starts checked (enabled) — nothing is in disabled_files yet.
    const toggle = dialog.getByRole("switch").first()
    await expect(toggle).toBeChecked()

    // Flip it off. Click the visible control (the role=switch input is overlaid by
    // the styled control div, which intercepts pointer events).
    await dialog.locator('[data-slot="switch-control"]').first().click()

    // Hard proof the backend wrote the project config (not SKILL.md frontmatter).
    await expect
      .poll(async () => (await readProjectConfig(directory)).skills?.disabled_files ?? [])
      .toContain(skillFile)

    // The SKILL.md frontmatter must remain untouched (we stopped writing it).
    const md = await fs.readFile(skillFile, "utf8")
    expect(md).not.toContain("enabled:")

    // Re-open the dialog: display state is computed from config, so the switch is now off.
    await page.keyboard.press("Escape")
    dialog = await openEvolvedSkillsDialog(page)
    await expect(dialog.getByText("demo-skill", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("switch").first()).not.toBeChecked()
  })
})
