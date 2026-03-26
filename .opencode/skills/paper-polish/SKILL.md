---
name: paper-polish
description: >
  Polish and revise academic papers in LaTeX format. Creates timestamped backups,
  generates visual diff PDF (red=deleted, blue=added), and compiles final PDF.
  Use when: revising, polishing, improving, or editing an existing LaTeX paper;
  modifying specific sections; updating figures or references; language polishing;
  tracking changes between versions.
  Triggers: "polish paper", "revise paper", "improve writing", "润色", "润色论文",
  "修改论文", "改论文", "polish introduction", "revise abstract", "改进摘要",
  "修改 introduction", "润色 methods".
---

# Paper Polish

Polish and revise LaTeX academic papers with automated backup, visual diff generation, and PDF compilation.

## Project Structure

```
project/
├── main.tex                    # Main LaTeX source
├── *.bib, *.bst                # Bibliography files
├── figures/                    # Figures
├── .temp/                      # Build directory (excluded from AI)
├── .backup/                    # Timestamped backups (excluded from AI)
└── skills/paper-polish/
    ├── scripts/compile_latex.py      # LaTeX compiler
    ├── scripts/setup_latexdiff.py    # Diff tool setup + runner
    └── references/polishing-guide.md # Writing standards
```

## Workflow

Execute stages 1-6 in order. Skip Stage 0 after first successful run.

### Stage 0: Check Dependencies (first run only)

```bash
python skills/paper-polish/scripts/setup_latexdiff.py --check
```

If Algorithm::Diff is missing, install it:
```bash
python skills/paper-polish/scripts/setup_latexdiff.py --install-deps
```

### Stage 1: Backup

Copy `main.tex` to `.backup/main_YYYYMMDD_HHMMSS.tex`:

```python
# Or use the built-in backup function:
python skills/paper-polish/scripts/compile_latex.py main.tex --backup
```

### Stage 2: Polish

Read [references/polishing-guide.md](references/polishing-guide.md) for detailed standards.

Key rules:
- Coherent paragraphs (4-8 sentences), no bullet-point content
- Pure LaTeX syntax (`\textbf{}`, `\cite{}`, `\eqref{}`), no markdown
- Smooth transitions, academic tone
- Preserve all technical content, equations, and author intent

### Stage 3: Save

Save polished content to `main.tex`.

### Stage 4: Generate Diff

```bash
python skills/paper-polish/scripts/setup_latexdiff.py .backup/main_YYYYMMDD_HHMMSS.tex main.tex
```

This generates `.temp/diff.tex` (red = deleted, blue = added).

### Stage 5: Compile diff.pdf

```bash
python skills/paper-polish/scripts/compile_latex.py .temp/diff.tex --diff
```

### Stage 6: Compile main.pdf

```bash
python skills/paper-polish/scripts/compile_latex.py main.tex
```

## Output Files

| File | Description |
|------|-------------|
| `.backup/main_*.tex` | Timestamped backup of original |
| `diff.pdf` | Visual diff (red=deleted, blue=added) |
| `main.pdf` | Final polished version |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Missing Algorithm::Diff | `python scripts/setup_latexdiff.py --install-deps` |
| Missing figures | Compare `\includegraphics` paths with `figures/` contents |
| Undefined citations `[?]` | Check `.bib` entries and `\bibliography{}` path |
| LaTeX errors | Check `.temp/main.log` for `^!` lines |
| No LaTeX engine | Install MiKTeX (Windows) or TeX Live (Linux/macOS) |

## Notes

- Scripts auto-detect LaTeX engine (xelatex > pdflatex > lualatex)
- `.temp/` uses incremental sync (not full clean) for faster recompilation
- Both scripts are cross-platform (Windows/Linux/macOS)
- All `.xxx` hidden dirs, `AGENTS.md`, `skills/`, output PDFs are excluded from `.temp/`
