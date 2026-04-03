# Browse Picker Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a clear toast when `Browse` cannot open a native folder picker and returns no path.

**Architecture:** Extend the server route to distinguish "no picker backend exists" from "user canceled". Add a small shared frontend helper so the same fallback message is used in both directory-selection dialogs and can be unit-tested without rendering the full UI.

**Tech Stack:** Bun, Solid, TypeScript, bun:test

---

### Task 1: Add Picker Availability Helpers

**Files:**
- Create: `packages/opencode/src/server/pick-folder.ts`
- Test: `packages/opencode/src/server/pick-folder.test.ts`
- Create: `packages/app/src/components/pick-folder.ts`
- Test: `packages/app/src/components/pick-folder.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests for helpers that:
- detect when Linux has no supported picker backend
- returns the picked path when present
- stays silent on a normal cancel
- shows a toast and returns `undefined` when the backend marks the picker as unavailable

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/app/src/components/pick-folder.test.ts`

- [ ] **Step 3: Write minimal implementation**

Create:
- a server helper that resolves Linux picker commands or reports unavailability
- a frontend helper that consumes the API result and toast callback

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/app/src/components/pick-folder.test.ts`

- [ ] **Step 5: Commit**

Commit message: `fix: show feedback when folder picker is unavailable`

### Task 2: Use Helper in Browse Entrypoints and SDK

**Files:**
- Modify: `packages/opencode/src/server/routes/file.ts`
- Modify: `packages/app/src/components/dialog-select-directory.tsx`
- Modify: `packages/app/src/components/dialog-new-project.tsx`
- Modify: `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- Modify: `packages/sdk/js/src/v2/gen/types.gen.ts`

- [ ] **Step 1: Replace inline `pickFolder()` handling**

Use the shared helper in both browse buttons and return the explicit unavailable state from the backend.

- [ ] **Step 2: Keep existing success behavior unchanged**

Only update the path/filter when a path exists.

- [ ] **Step 3: Regenerate the JS SDK**

Run: `./packages/sdk/js/script/build.ts`

- [ ] **Step 4: Run targeted tests**

Run:
- `bun test src/server/pick-folder.test.ts` from `packages/opencode`
- `bun test src/components/pick-folder.test.ts` from `packages/app`

- [ ] **Step 5: Run package typecheck**

Run:
- from `packages/opencode`: `bun typecheck`
- from `packages/app`: `bun typecheck`

- [ ] **Step 6: Commit**

Commit message: `fix: surface browse picker failures in project dialogs`

### Task 3: Reproduce and Verify Manually

**Files:**
- No file changes required

- [ ] **Step 1: Start isolated backend/frontend**

Use the temporary-data setup so the old local DB does not interfere.

- [ ] **Step 2: Verify the toast in a no-picker environment**

Click `Browse` from the open-project dialog and confirm the new toast appears.

- [ ] **Step 3: Capture evidence**

Save a Playwright screenshot if needed.
