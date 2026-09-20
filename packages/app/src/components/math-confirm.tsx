import { Show, createSignal, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"

/**
 * Simple addition the user must answer before an irreversible action proceeds.
 * Renders the math prompt and input; the action buttons are provided via the
 * children render prop, which receives whether the answer is solved and the
 * Enter-key attempt handler.
 */
export function MathConfirm(props: {
  action?: string
  /** Called when the answer is entered correctly and Enter is pressed. */
  onCorrect?: () => void
  children: (controls: { solved: Accessor<boolean>; attempt: () => void }) => JSX.Element
}) {
  const language = useLanguage()
  const a = 2 + Math.floor(Math.random() * 8)
  const b = 2 + Math.floor(Math.random() * 8)
  const [answer, setAnswer] = createSignal("")
  const [wrong, setWrong] = createSignal(false)
  const parsed = () =>
    Number.parseInt(
      answer()
        .trim()
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)),
      10,
    )
  const solved = () => parsed() === a + b
  const attempt = () => {
    if (solved()) {
      props.onCorrect?.()
      return
    }
    setWrong(true)
  }
  return (
    <>
      <div class="flex flex-col gap-1.5">
        <span class="text-14-regular text-text-weak">{language.t("session.delete.math", { a, b })}</span>
        <input
          autofocus
          value={answer()}
          inputmode="numeric"
          autocomplete="off"
          class="text-14-regular text-text-strong w-24 rounded-md border border-border-weak-base bg-surface-raised-base px-2 py-1 outline-none"
          data-action={props.action ?? "math-confirm"}
          onInput={(e) => {
            setAnswer(e.currentTarget.value)
            setWrong(false)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") attempt()
          }}
        />
        <Show when={wrong()}>
          <span class="text-12-regular text-text-error">{language.t("session.delete.math.wrong")}</span>
        </Show>
      </div>
      {props.children({ solved, attempt })}
    </>
  )
}
