import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"

// Half-block pixel font: each letter is 4 pixel-rows tall mapped to 2 terminal rows
// ▀ = top pixel filled, ▄ = bottom pixel filled, █ = both filled, space = empty
const LEFT = ["▄▀▀▄ █▀▀▀", "█▀▀█ ███▄"]
const RIGHT = ["▀██▀ █  █ █▀▀▀ █▀▀▄", " ██  █▀▀█ ███▄ █▀█ "]

export function Logo() {
  const { theme } = useTheme()
  return (
    <box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted} selectable={false}>{LEFT[0]}</text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>{RIGHT[0]}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted} selectable={false}>{LEFT[1]}</text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>{RIGHT[1]}</text>
      </box>
    </box>
  )
}
