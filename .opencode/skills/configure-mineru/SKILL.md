---
name: configure-mineru
description: Configure, resume, verify, adopt, or troubleshoot a local MinerU service for Aether on Windows x64. Use when the user starts the MinerU setup conversation, asks to configure local PDF or image extraction, wants to reuse an existing MinerU environment, or needs help repairing a failed MinerU setup.
hidden: true
---

# Configure MinerU

Use Aether's constrained `mineru_setup` tool for the installation lifecycle. Do not assemble core installation, deletion, or service commands with the shell.

## Workflow

1. Call `mineru_setup` with `action: "inspect"` before proposing changes.
2. Summarize:
   - platform and architecture;
   - the current Aether executable and working directory, explicitly distinguishing them from the managed data directory;
   - free disk and total memory;
   - NVIDIA GPU detection as informational only;
   - the fixed Aether data directory;
   - validated versions and ModelScope source;
   - detected existing MinerU candidates.
     Explain that development and installed Aether builds may intentionally share the same global data directory even though their executable locations differ.
3. Explain that v1 uses the CPU pipeline even when an NVIDIA GPU is present.
4. Present the exact choice and wait for explicit confirmation:
   - recommend an isolated Aether installation with `channel: "validated"`;
   - offer an inspected candidate for reuse when available;
   - offer `channel: "latest"` only when the user explicitly requests current compatible versions.
5. After confirmation:
   - call `install` for a fresh or repaired isolated environment;
   - call `resume` after an interrupted installation;
   - call `adopt` only with a candidate ID returned by the latest inspection.
6. Report progress from the tool result. Do not claim a percentage when the tool does not provide byte progress.
7. On success, call `verify` if the completed result does not already include a successful verification, then explain that Aether starts MinerU only when an unsupported attachment needs it.
   Also explain that tool-capable models can call `mineru_status`, `mineru_start`, and `mineru_convert` after setup. `mineru_convert` accepts only PDF or image files inside the current workspace, writes a new Markdown file without overwriting, and never sends files to a custom service address.
8. On failure, call `status`, summarize the short error and recent sanitized logs, and propose one repair at a time. Ask again before administrator actions, changes outside Aether's data directory, GPU/CUDA work, or edits to an adopted environment.

## Safety

- Support managed installation only on Windows x64 Aether desktop.
- Never request administrator access for the validated CPU path.
- Never delete or modify an adopted environment.
- Never pass arbitrary paths or commands to `mineru_setup`.
- Do not paste full local logs into the model context unless the user explicitly requests detailed diagnosis.
- Treat paths, usernames, environment values, and logs as potentially sensitive.
- If the tool is unavailable, explain the platform or client limitation and retain the custom MinerU service option.

## Resources

- Read [references/versions.md](references/versions.md) only for version-source or compatibility questions.
- Run [scripts/inspect.ps1](scripts/inspect.ps1) only for supplementary read-only Windows diagnostics when the managed inspection result is insufficient.
