---
name: write-paper
description: Write a complete academic paper in LaTeX format (.tex + .bib) from research project files. Use when the user asks to write, draft, or generate an academic paper, research paper, scientific paper, or LaTeX document based on project data, computational results, figures, derivations, or discussion files. Supports theoretical, computational, experimental, and review paper types with auto-detection of project structure and research type.
---

# Write Academic Paper

Generate a publication-ready LaTeX academic paper by analyzing project result files (data, figures, logs), loading background documents (derivations, discussions), searching for references, classifying research type, and generating section-by-section content with proper math typesetting, figure references, and BibTeX bibliography.

## Expected Project Structure

```
project/
├── docs/
│   ├── derivations/
│   │   └── detailed_derivations_*.md
│   ├── discussions/
│   │   └── discussion_*.md
│   └── brainstorms/
├── results/  (or output/, data/, figures/, plots/)
│   ├── *.csv, *.json, *.xlsx    (data files)
│   ├── *.png, *.jpg, *.pdf      (figures)
│   └── *.txt, *.log             (text/logs)
├── code/
└── paper/  (OUTPUT)
    ├── paper_[topic]_[date].tex
    ├── paper_[topic]_[date].bib
    └── figures/
```

## Nine-Stage Workflow

### Stage 1: Project Structure Detection

Scan the project directory for standard subdirectories:
- Result directories: `results/`, `output/`, `data/`, `figures/`, `plots/`
- Documentation: `docs/`, `docs/derivations/`, `docs/discussions/`
- Auto-detect `detailed_derivations_*.md` and `discussion_*.md` in docs directories or project root

If `project_path` is not provided, default to current working directory.

### Stage 2: File Scanning and Analysis

Classify all files in result directories by type and analyze:

| File Type | Extensions | Analysis Method | Size Limit |
|-----------|-----------|----------------|------------|
| Data | CSV, JSON, Excel | Read content, extract headers, row counts, statistics | CSV: 1000 rows, JSON: 50000 chars |
| Image | PNG, JPG, PDF | AI Vision analysis, generate academic figure captions | — |
| Text | TXT, LOG, MD | Read content, extract key information | 8000 chars |

For each file, record: name, type, analysis summary, and path.

### Stage 3: Background Document Loading

- Read derivations file (`detailed_derivations_*.md`) for theoretical foundations, mathematical proofs, derivation steps
- Read discussion file (`discussion_*.md`) for research motivation, key questions, research direction
- Read derivation plan (`derivation_plan_*.md`) for logical structure of theoretical framework
- Extract topic from document headers if not explicitly provided

### Stage 4: Reference Search

If knowledge base is available:
- Search with topic query, retrieve up to 50 relevant references
- Pre-number results as `[1]`, `[2]`, ... for easy citation in section generation
- Format as context block providing reference titles and content summaries

### Stage 5: Research Type Classification

Classify the research into: theoretical, computational, experimental, review, case_study, or mixed. Select appropriate section template based on classification.

See [references/research-types.md](references/research-types.md) for classification criteria and section templates for each research type.

### Stage 6: Section-by-Section Generation

Generate each section individually with full context. For each section, provide:
- Role: distinguished professor and senior researcher
- All analyzed data files and their content
- Background documents (derivations, discussions)
- Knowledge base references (pre-numbered)
- Section-specific writing guidelines
- LaTeX formatting rules

See [references/writing-guidelines.md](references/writing-guidelines.md) for detailed per-section writing standards, information integration guidance, and quality criteria.

### Stage 7: Citation Review

After generating all sections, review for citation completeness:

1. **Claim extraction**: Identify statements needing citations — factual claims, method attributions, theory references, result comparisons, background statements
2. **Source search**: For each uncited claim, search knowledge base and online literature (INSPIRE/arXiv) for relevant sources
3. **Auto-insertion**: Insert `\cite{}` markers or numbered references at appropriate locations
4. **Report**: Generate citation coverage statistics (% of claims with citations, uncited claims by importance)

### Stage 8: Figure Handling

- Create `paper/figures/` directory
- Copy all analyzed image files to `paper/figures/`
- Generate LaTeX figure blocks with `\includegraphics`, captions from vision analysis, and `\label` for cross-referencing:

```latex
\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.8\textwidth]{figures/filename.png}
  \caption{Descriptive caption from vision analysis.}
  \label{fig:unique_label}
\end{figure}
```

### Stage 9: LaTeX Assembly and Output

Assemble the complete document:

1. Generate LaTeX preamble (see template below)
2. Combine all sections with proper `\section{}` / `\begin{abstract}` wrappers
3. Append figure blocks at appropriate locations
4. Generate `\begin{thebibliography}` from collected references
5. Post-process: clean residual Markdown syntax, validate formulas, escape special characters
6. Save as `paper/paper_[topic]_[date].tex`
7. Generate `paper/paper_[topic]_[date].bib` with BibTeX entries

See [references/latex-formatting.md](references/latex-formatting.md) for LaTeX syntax rules, formula standards, and post-processing rules.

## LaTeX Preamble Template

```latex
\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{amsthm}
\usepackage{graphicx}
\usepackage[margin=1in]{geometry}
\usepackage{caption}
\usepackage{booktabs}
\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\title{Paper Title}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle
```

## Key Constraints

- **Academic integrity**: Never fabricate citations or references. Only cite sources that exist in the knowledge base or can be verified.
- **Data fidelity**: Use exact values from provided data files. Never invent numbers, statistics, or results. Quote actual row counts, means, standard deviations from real data.
- **Writing structure**: Write in coherent paragraphs (4-8 sentences each). No bullet-point papers — use academic prose. Smooth transitions between paragraphs.
- **Pure LaTeX**: No Markdown syntax in paper content. Use `\textbf{}` not `**`, `\textit{}` not `*`, proper `\section{}` not `#`.
- **Section titles**: No math expressions in `\section{}` or `\subsection{}` titles.
- **Numbered references**: Use `[1]`, `[2]` format in text, compiled to BibTeX in output.

## Reference Files

- [references/research-types.md](references/research-types.md) — Read when classifying research type or selecting paper structure template (Stage 5)
- [references/writing-guidelines.md](references/writing-guidelines.md) — Read when generating section content for detailed per-section standards (Stage 6)
- [references/latex-formatting.md](references/latex-formatting.md) — Read when assembling LaTeX output for syntax rules, formula standards, and post-processing (Stage 9)
