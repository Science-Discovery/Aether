# Offline updates

Short manual checks for desktop update recovery.

## Scope

Cover offline web update behavior across Windows and Linux.

Focus on these regressions:
- No flashing terminal windows during Windows download, install, and relaunch
- Partial downloads never enable install
- In-progress manual download state survives while the same app/server process stays alive
- Failed update or install offers a restart-from-scratch recovery path
- Linux downloaded zip plus script installs and relaunches into the new version

## Environment/setup

Prepare:
- A build with the offline web update flow enabled
- Test machines for Windows and Linux
- An update target that is newer than the installed app
- A way to interrupt downloads and simulate install failure
- Access to app logs if the UI result is unclear

Before each run:
- Start from a known app version
- Clear any old downloaded update artifacts unless the scenario says otherwise
- Confirm the update UI detects the newer version

## Scenario checklist

### 1. Verify silent Windows execution

- [ ] On Windows, start the update download and complete the install flow
- [ ] Watch for any terminal or console windows during download, install, and relaunch

Expected:
- No terminal window flashes at any step
- Update completes through the normal UI flow
- App relaunches into the new version

### 2. Verify partial download recovery

- [ ] Start downloading an update
- [ ] Interrupt the download before completion
- [ ] Return to the update screen without manually repairing files
- [ ] Restart the update flow as prompted

Expected:
- Install never becomes available for the partial download
- UI does not treat the partial artifact as a valid ready-to-install update
- Recovery path offers restart/update again
- Restarted download can complete normally and then enable install

### 3. Verify in-memory manual download persistence

- [ ] Start a manual download but do not finish it
- [ ] Close and reopen the update surface while keeping the same app/server process alive
- [ ] Revisit the update flow

Expected:
- State is remembered within the same live process
- Reopen shows recovery or resume guidance, not install
- UI does not present the interrupted download as complete

### 4. Verify failed update/install recovery

- [ ] Force an update or install failure
- [ ] Observe the post-failure UI
- [ ] Use the offered recovery action

Expected:
- Failure state is visible and understandable
- A restart-from-scratch path is available
- Recovery clears the broken state enough to retry cleanly
- Retried flow can proceed to a successful install

### 5. Verify Linux install from downloaded artifacts

- [ ] On Linux, complete the offline download so the zip and install script are present
- [ ] Trigger install using the downloaded artifacts
- [ ] Let the app restart

Expected:
- Installer uses the downloaded zip and script successfully
- Install completes without requiring a fresh download
- App restarts into the new version
- Updated app is functional after relaunch

## Notes

These are manual cross-platform regressions.

Do not treat this checklist as automated coverage.
