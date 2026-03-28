# Academic Paper Polishing Guide

Detailed standards for polishing academic papers in physics and related fields.
Load this reference when performing the actual text revision.

## General Writing Standards

- Write coherent paragraphs of 4-8 sentences; avoid single-sentence paragraphs
- Use academic prose throughout; never convert narrative into bullet points or lists
- Ensure smooth logical transitions between paragraphs (use connective phrases)
- Use pure LaTeX formatting: `\textbf{}`, `\textit{}`, `\emph{}`; never markdown syntax
- All numbered references use `\cite{}`; never hardcode numbers like `[1]`
- Maintain consistent tense: present tense for established facts, past tense for describing what was done
- Prefer active voice when clarity permits; use passive voice for established conventions
- Eliminate redundancy and filler words ("it is well known that", "it should be noted that")

## Section-Specific Guidelines

### Abstract (150-250 words)
- No citations, no equation references, no figure references
- Structure: context (1-2 sentences) -> problem/gap -> approach -> key results -> significance
- Include quantitative results where possible
- Self-contained: readable without the paper

### Introduction
- Funnel structure: broad context -> specific problem -> what this paper does
- Cite relevant prior work comprehensively but concisely
- Clearly state the research gap or motivation
- End with a paragraph outlining the paper structure ("This paper is organized as follows...")
- Avoid excessive review; save detailed comparison for Discussion

### Methodology / Formalism
- Define all symbols at first use
- Number all important equations
- Explain approximations and their validity range
- Use consistent notation throughout
- Cross-reference equations: `Eq.~\eqref{eq:label}`, not `Eq.~(\ref{eq:label})`

### Results
- Present results in logical order, not chronological order
- Reference all figures and tables in the text
- Compare quantitative results with prior work where applicable
- State uncertainties and error estimates
- Use `Fig.~\ref{fig:label}` and `Table~\ref{tab:label}` consistently

### Discussion
- Interpret results in the context of prior work
- Address limitations honestly
- Suggest future directions
- Do not repeat results verbatim; synthesize and interpret

### Conclusion
- Summarize key findings (not copy-paste from abstract)
- State broader implications
- Keep concise: typically 1-2 paragraphs

## LaTeX Best Practices

- Use `~` (non-breaking space) before `\cite`, `\ref`, `\eqref`: e.g., `shown in Ref.~\cite{key}`
- Use `\eqref` for equation references (auto-adds parentheses)
- Prefer `\begin{align}` over `\begin{eqnarray}` (better spacing)
- Use `\left(` and `\right)` for auto-sized delimiters in display math
- Consistent punctuation in display equations (comma or period at end if part of sentence)

## Common Issues to Fix

- `[?]` in PDF: missing `\cite{}` key or missing `.bib` entry
- Dangling references: `\ref` to non-existent label
- Inconsistent capitalization in section titles
- Mixed British/American spelling (pick one and be consistent)
- Orphan/widow lines (add `~` or rephrase to fix pagination)
- Incorrect use of `\it` (deprecated) vs `\textit{}` or `\emph{}`

## Preserving Author Intent

When polishing, preserve:
- Technical content and claims (do not change physics/math)
- Author's preferred terminology and notation conventions
- Paper structure unless restructuring is explicitly requested
- All equations, figures, and tables (content unchanged)
- Citation keys and bibliography entries

Only modify: language clarity, grammar, flow, formatting consistency, and style.
