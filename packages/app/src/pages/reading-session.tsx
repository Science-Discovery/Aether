import { type Component, createSignal, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import { ReadingModeProvider } from "@/context/reading-mode"
import { ReadingModePanel } from "@/components/reading-mode/reading-mode-panel"
import { TerminalProvider } from "@/context/terminal"
import { FileProvider } from "@/context/file"
import { PromptProvider } from "@/context/prompt"
import { CommentsProvider } from "@/context/comments"
import SessionPage from "./session"

/**
 * /session/:id/reading
 *
 * Split layout: PDF viewer on the left, full chat session on the right.
 * The chat session re-uses the existing Session page component entirely.
 */
const ReadingSession: Component = () => {
  const params = useParams<{ id: string }>()

  return (
    <ReadingModeProvider>
      <TerminalProvider>
        <FileProvider>
          <PromptProvider>
            <CommentsProvider>
              <ReadingModePanel sessionID={params.id}>
                {/* Right side: existing session UI */}
                <SessionPage />
              </ReadingModePanel>
            </CommentsProvider>
          </PromptProvider>
        </FileProvider>
      </TerminalProvider>
    </ReadingModeProvider>
  )
}

export default ReadingSession
