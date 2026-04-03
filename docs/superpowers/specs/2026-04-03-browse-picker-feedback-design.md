# Browse Picker Feedback Design

**Scope:** Fix the `Browse` button UX when the backend cannot open a native folder picker and returns `null`.

**Problem:** In WSL/Linux environments without `zenity` or `kdialog`, `file.pickFolder` returns `{ path: null }`. Current callers treat that as a no-op, so the user clicks `Browse` and sees no visible feedback.

**Approach:** Add an explicit unavailable state to `file.pickFolder` when Linux/WSL has no supported native picker backend. Update the frontend callers of `pickFolder()` to surface an error toast only for that unavailable state, while keeping a normal user cancel silent. Reuse the same message in both project-opening entry points so behavior stays consistent.

**User-visible result:** Clicking `Browse` in affected environments will show a toast telling the user to enter the path manually or install a supported picker, instead of appearing broken.

**Out of scope:** Database migration failures, backend picker implementation changes, adding new Linux picker backends, or changing path parsing behavior.
