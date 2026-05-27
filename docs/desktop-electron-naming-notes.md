# Desktop Electron Naming Notes

Temporary notes for Electron desktop naming cleanup.

## Current State

The production Electron package mostly presents the desktop app as `Aether Desktop`:

- `packages/desktop-electron/electron-builder.config.ts`
  - `productName: "Aether Desktop"` for `prod`
  - protocol display name `Aether Desktop`
  - protocol scheme `aether`
- `packages/desktop-electron/src/main/paths.ts`
  - runtime `app.setName()` uses `Aether Desktop` for `prod`
- `packages/desktop-electron/src/main/windows.ts`
  - main window title is `Aether Desktop`
- `packages/desktop-electron/src/renderer/index.html`
  - document title is `Aether Desktop`
- `packages/desktop-electron/src/renderer/loading.html`
  - document title is `Aether Desktop`
- `.github/workflows/publish.yml` and desktop release scripts set `OPENCODE_CHANNEL=prod`, so official release builds take the production naming path.

## Known Residuals and Inconsistencies

- `packages/desktop-electron/src/main/menu.ts`
  - macOS Help menu still shows `OpenCode Documentation`
  - support and issue links still point to opencode URLs

- `packages/desktop-electron/src/renderer/i18n/*.ts`
  - updater strings still mention `OpenCode`
  - CLI install strings still tell users to use the `opencode` command

- `packages/desktop-electron/src/main/index.ts`
  - sidecar failure detail still mentions `opencode-cli.exe`
  - server auth username is still `opencode`

- `packages/desktop-electron/src/main/cli.ts`
  - CLI install dir is still `.opencode/bin`
  - CLI binary name is still `opencode`
  - WSL installer path still uses `$HOME/.opencode/bin/opencode`
  - WSL install command still downloads from `https://opencode.ai/install`
  - **Note:** these are not mere residuals — the CLI binary name `opencode` and its install path are shared across the web and desktop product lines. Renaming them requires a product-level decision and migration strategy for all existing users.

- `nix/desktop.nix`
  - still uses `pname = "opencode-desktop"`
  - **still references `packages/desktop/src-tauri`** — this is not just a naming residual; it points to the old Tauri package which no longer exists, meaning the entire Nix build is broken
  - still installs `opencode-cli-*`
  - still renames `OpenCode` to `opencode-desktop`
  - metadata still says `OpenCode Desktop App`
  - homepage is still `https://opencode.ai`

- `packages/desktop-electron/src/renderer/index.tsx`
  - notification icon still fetches from `https://opencode.ai/favicon-96x96-v3.png`, so users see the opencode favicon in desktop notifications instead of the Aether icon

- App identity is inconsistent:
  - Electron Builder production `appId` is `com.aether.desktop`
  - runtime user data app id in `paths.ts` is `ai.aether.desktop`
  - **User-side impact:** `com.aether.*` determines the OS-level app identity (macOS Bundle ID, Windows AppUserModelID), which governs protocol registration, taskbar grouping, and auto-update target resolution. `ai.aether.*` determines the `app.getPath('userData')` disk path where user data is stored. The mismatch can cause protocol links to fail, auto-update to not find the previous version, or taskbar grouping to break.

- Intentional legacy: `packages/desktop-electron/src/main/persist-names.ts`
  - `LEGACY_APP = "opencode"` and the `opencode.*.dat → aether.*.dat` mapping exist to migrate user data from the era when Aether (Web/CLI) was named `opencode`. The mapping protects existing Web/CLI users who upgrade past the rename; it has no relation to a desktop release (no Electron desktop has ever shipped). This is backward-compatible design, **not** a residual to clean up — removing it would cause data loss for upgrading Web/CLI users.

## Review Conclusion

The production release surface is partially renamed to `Aether Desktop`, but the repository has not completed naming unification. OpenCode/opencode residuals can still appear in menus, update dialogs, CLI install flows, notification icons, and Nix packaging. The app identity should also be normalized before considering the naming work complete. The `persist-names.ts` legacy migration mappings are intentional and must be preserved.

## Cross-references

- App ID unification (`com.aether.*` vs `ai.aether.*`) → `desktop-electron-alignment-plan.md` §1
- Sidecar failure dialog `opencode-cli.exe` mention → `desktop-electron-alignment-plan.md` §9
- Notification icon fetched from `https://opencode.ai/favicon-96x96-v3.png` → `desktop-electron-icons-plan.md` §"主进程联动改造" and `desktop-electron-alignment-plan.md` #11e
- `persist-names.ts` legacy mapping semantics → `desktop-electron-persist-plan.md` §"不做的事"
- Naming residual cleanup checklist (menu.ts copy, i18n CLI install strings) → `desktop-electron-alignment-plan.md` §14
- `nix/desktop.nix` broken Tauri reference → `desktop-electron-alignment-plan.md` §"首次发布后应尽快做"
