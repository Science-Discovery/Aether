# Session Busy and Revert Guard Plan

## Goal

Restore the final behavior intended by `2921e43e0`, `1552b1d27`, and `8db25ce08` without replaying their intermediate implementation states. The desired result is a single, consistent busy model used by Web UI state indicators, message submission, revert/restore guards, backend safety checks, and TUI revert flows.

The user-facing rule is:

- If the current session or any descendant session is still working, do not let users accidentally send another prompt or mutate session history through revert/restore.
- Give users a clear explanation and safe alternatives: stop the task first, cancel the operation, or fork from the selected point.

The system-facing rule is:

- Busy state must not be duplicated with slightly different logic across components.
- Dangerous history mutation must have both UI-level prevention and backend-level enforcement.

## Why Not Cherry-Pick

The three historical commits form an evolution chain rather than independent patches:

- `2921e43e0` introduced recursive Web busy checks and blocked send while busy.
- `8db25ce08` added busy revert protection on top of that behavior.
- `1552b1d27` corrected the `visual` versus `interactive` busy semantics afterward.

Cherry-picking them one by one would reintroduce intermediate states, merge-commit noise, and behavior that has since been partially absorbed or changed. A fresh implementation should restore the final intended behavior and close known gaps such as descendant pending messages, restore feedback, API `unrevert` consistency, and undo/redo bypasses.

## Implementation Plan

### 1. Unified Web Busy State

Extend `packages/app/src/utils/working-state.ts` so one helper can answer both display and interaction questions.

Busy sources:

- Current session status is `busy` or `retry`.
- Current session has an assistant message without `time.completed`.
- Any descendant session is busy by the same rules.

Safety:

- Descendant traversal must use a `seen` set so corrupt or cyclic session data cannot recurse forever.
- `visual` remains appropriate for display and grace animation.
- `interactive` is strict and is used to block sending, revert, restore, and command actions.

User effect:

- Parent sessions show and behave as busy while child work is still running.
- The UI does not prematurely become interactive when an assistant message is still unfinished.

System necessity:

- This removes duplicated partial busy checks from individual components.
- It establishes one consistent source of truth for later guards.

### 2. Prompt Input and Submit Guard

Wire the unified busy state into:

- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/components/prompt-input/submit.ts`

Behavior:

- Pressing Enter while busy does not send a new prompt.
- The submit handler performs the same busy check before it builds and sends a request.
- The stop action remains available when the session is working.

User effect:

- Users cannot accidentally start a second prompt while current or descendant work is still in progress.
- Keyboard and button behavior match the session state.

System necessity:

- The prompt input is the visible entry point.
- The submit handler is the final safety gate before creating a new user message.

### 3. Sidebar, Timeline, and Composer State

Wire the unified busy state into:

- `packages/app/src/pages/layout/sidebar-items.tsx`
- `packages/app/src/pages/session/message-timeline.tsx`
- `packages/app/src/pages/session/composer/session-composer-state.ts`

Behavior:

- Sidebar session items reflect descendant work.
- Timeline working indicators follow strict interactive busy state.
- Composer stays live while current or descendant work is active.

User effect:

- Users see why actions are blocked.
- Session list, message timeline, and input area do not disagree about whether the session is working.

System necessity:

- Blocking actions without matching state indicators creates confusing behavior.
- These components are the state surface for the guard behavior.

### 4. Web Revert and Restore Guard

Wire the same busy state into:

- `packages/app/src/pages/session.tsx`
- `packages/app/src/components/dialog-revert-confirm.tsx`
- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`

Behavior:

- Revert is blocked while current or descendant work is busy.
- Restore/unrevert is also blocked while busy.
- Busy revert/restore shows a clear dialog instead of silently doing nothing.
- The dialog offers cancel and, where applicable, fork.

User effect:

- Users cannot roll back session history or files while work is in progress.
- Users understand the reason and have a safe branch-based alternative.

System necessity:

- Revert and restore mutate message history and file snapshots.
- This is the highest-risk user action while a task is running.

### 5. Backend Revert Safeguards

Update:

- `packages/opencode/src/session/revert.ts`
- `packages/opencode/src/server/routes/session.ts`

Behavior:

- `SessionRevert.revert` asserts the session is not busy.
- `SessionRevert.unrevert` keeps the existing busy assertion.
- API routes for both revert and unrevert return HTTP 409 for `Session.BusyError`.

User/API effect:

- Direct API calls and races cannot bypass the same-session busy guard.
- Clients receive a clear busy response instead of a generic failure.

System necessity:

- UI checks are not security or consistency boundaries.
- Backend enforcement is required for TUI, SDK, scripts, and request races.

### 6. TUI Revert Guard

Update:

- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-message.tsx`

Behavior:

- Revert from the TUI message dialog is blocked while the current session is busy or has an unfinished assistant message.
- The dialog offers Cancel/Fork.

User effect:

- Terminal users get the same safe revert behavior as Web users.

System necessity:

- TUI is a real client, not a test path.
- Backend 409 protects data, but TUI should still present a useful user-facing choice.

### 7. Undo and Redo Consistency

Update:

- `packages/app/src/pages/session/use-session-commands.tsx`
- TUI command paths only if needed for consistency with existing behavior.

Behavior:

- Undo/redo must not automatically abort and continue with history mutation.
- Busy undo/redo is blocked and reported to the user.

User effect:

- Command palette actions cannot bypass the message menu protection.
- Users must explicitly stop work before history mutation.

System necessity:

- Undo/redo are revert/unrevert paths.
- Allowing them to auto-abort and proceed would break the system-wide guard model.

## Validation

Required focused checks:

- Current session status busy blocks Enter and Web revert.
- Current session pending assistant with idle status is still treated as busy.
- Descendant busy and descendant pending assistant make the parent busy.
- Busy Web revert shows the busy dialog and does not call revert.
- Busy restore shows feedback and does not call unrevert.
- Busy API revert/unrevert returns 409.
- Idle revert still allows existing inherited-prefix and descendant-branch protection.
- TUI busy message revert shows Cancel/Fork.
- Busy undo/redo does not mutate history.

## Scope Control

This change must not modify unrelated UI, formatting, SDK generation, provider behavior, memory, skill evolution, or general session processor behavior. Any change outside the files named above needs separate approval.
