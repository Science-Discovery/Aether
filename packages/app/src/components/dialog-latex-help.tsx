import { Tabs } from "@kobalte/core/tabs"
import { For } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import "./dialog-latex-help.css"

export function DialogLatexHelp() {
  const language = useLanguage()
  const groups = [
    {
      id: "controls",
      title: "latex.help.controls",
      items: [
        ["latex.toolbar", "latex.help.toolbar"],
        ["latex.fileSave", "latex.help.fileSave"],
        ["latex.fileDiscard", "latex.help.fileDiscard"],
        ["latex.project", "latex.help.project"],
        ["latex.refresh", "latex.help.refresh"],
        ["latex.settings", "latex.help.settings"],
        ["latex.appearance", "latex.help.appearance"],
        ["latex.help.folding", "latex.help.folding.description"],
        ["latex.preview", "latex.help.preview"],
        ["latex.sync.locate", "latex.help.sync"],
      ],
    },
    {
      id: "setup",
      title: "latex.help.setup",
      items: [
        ["latex.root", "latex.help.root"],
        ["latex.open", "latex.help.open"],
        ["latex.main", "latex.help.main"],
        ["latex.driver", "latex.help.driver"],
        ["latex.program", "latex.help.program"],
        ["latex.bind", "latex.help.bind"],
      ],
    },
    {
      id: "reading",
      title: "latex.help.reading",
      items: [
        ["latex.preview.versions", "latex.help.versions"],
        ["latex.sync.source", "latex.help.sync.source"],
        ["latex.sync.versions", "latex.help.sync.versions"],
        ["latex.preview.export", "latex.help.export"],
        ["latex.help.diagnostics", "latex.help.errors"],
        ["latex.downloads", "latex.help.downloads"],
        ["latex.compare", "latex.help.conflict"],
      ],
    },
  ] as const
  return (
    <Dialog title={language.t("latex.help.title")} size="large" class="latex-help-dialog">
      <p class="latex-help-intro">{language.t("latex.help.subtitle")}</p>
      <Tabs defaultValue="quick" class="latex-help" data-component="latex-help">
        <Tabs.List class="latex-help-nav" aria-label={language.t("latex.help.title")}>
          <Tabs.Trigger class="latex-help-tab" value="quick">
            {language.t("latex.help.quick")}
          </Tabs.Trigger>
          <For each={groups}>
            {(group) => (
              <Tabs.Trigger class="latex-help-tab" value={group.id}>
                {language.t(group.title)}
              </Tabs.Trigger>
            )}
          </For>
        </Tabs.List>
        <Tabs.Content value="quick" class="latex-help-pane">
          <ol class="latex-help-steps">
            <For
              each={
                [
                  ["latex.help.flow.open", "latex.help.start"],
                  ["latex.help.flow.write", "latex.help.flow.write.description"],
                  ["latex.help.flow.read", "latex.help.flow.read.description"],
                ] as const
              }
            >
              {(step, index) => (
                <li>
                  <span class="latex-help-number" aria-hidden="true">
                    {String(index() + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3>{language.t(step[0])}</h3>
                    <p>{language.t(step[1])}</p>
                  </div>
                </li>
              )}
            </For>
          </ol>
          <section class="latex-help-modes">
            <h3>{language.t("latex.help.modes")}</h3>
            <div class="latex-help-options">
              <div>
                <div class="latex-help-mode">
                  <h4>{language.t("latex.help.mode.automatic")}</h4>
                  <span class="latex-help-badge">{language.t("latex.help.default")}</span>
                </div>
                <p>{language.t("latex.help.automatic")}</p>
              </div>
              <div>
                <h4>{language.t("latex.help.mode.manual")}</h4>
                <p>{language.t("latex.help.manual")}</p>
              </div>
            </div>
          </section>
          <div class="latex-help-shortcut">
            <span>{language.t("latex.help.shortcut")}</span>
            <span class="latex-help-keys">
              <kbd>Ctrl</kbd>
              <span>+</span>
              <kbd>S</kbd>
              <span class="latex-help-separator">/</span>
              <kbd>⌘</kbd>
              <span>+</span>
              <kbd>S</kbd>
            </span>
          </div>
          <p class="latex-help-reminder">{language.t("latex.help.reminder")}</p>
        </Tabs.Content>
        <For each={groups}>
          {(group) => (
            <Tabs.Content value={group.id} class="latex-help-pane">
              <dl class="latex-help-reference">
                <For each={group.items}>
                  {(item) => (
                    <div>
                      <dt>{language.t(item[0])}</dt>
                      <dd>{language.t(item[1])}</dd>
                    </div>
                  )}
                </For>
              </dl>
            </Tabs.Content>
          )}
        </For>
      </Tabs>
    </Dialog>
  )
}
