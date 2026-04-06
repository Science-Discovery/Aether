# Response Templates (LaTeX Format)

Adapt these templates to the specific context of each response. Never use them verbatim without tailoring.

---

## Acceptance

### Minor Change

```latex
\textbf{N. The referee wrote:}

[Reviewer's comment]

\textbf{Our reply:}

We thank the referee for identifying this [error/oversight/unclear passage].

\textbf{Changes:}

In the revised version, we have corrected this in [Section X / page Y]. The revised text now reads: "[new text]".
```

### Major Change

```latex
\textbf{N. The referee wrote:}

[Reviewer's comment]

\textbf{Our reply:}

We appreciate this valuable suggestion. We agree that [reason for accepting].

\textbf{Changes:}

In the revised version, we have [describe change] in [location]. Specifically:
\begin{enumerate}
\item [Modification 1]
\item [Modification 2]
\end{enumerate}
These changes are reflected in [Section X / Equation Y / Figure Z].
```

### Additional Analysis Requested

```latex
\textbf{N. The referee wrote:}

[Reviewer requests additional analysis]

\textbf{Our reply:}

We agree that this analysis would strengthen the paper.

\textbf{Changes:}

In the revised version, we have conducted [describe analysis] and added the results in [location]. Key findings:
\begin{itemize}
\item [Finding 1]
\item [Finding 2]
\end{itemize}
These results [support/qualify/extend] our original conclusions.
```

---

## Partial Acceptance

### Valid Concern, Alternative Solution

```latex
\textbf{N. The referee wrote:}

[Reviewer suggests specific approach]

\textbf{Our reply:}

We agree that [underlying concern] is important. However, instead of [reviewer's suggestion], we have adopted an alternative approach because [reason].

\textbf{Changes:}

In the revised version, we have [alternative solution] in [location]. This addresses the referee's concern while [advantage of chosen approach].
```

### Multi-Part Comment

```latex
\textbf{N. The referee wrote:}

[Multi-part comment]

\textbf{Our reply:}

We address each part of the referee's comment below.

\textbf{Changes:}

(a) Regarding [first part]: In the revised version, we have [action] in [location].

(b) Regarding [second part]: No change was made in the revised version because [reason]. However, we have addressed the underlying concern by [alternative] in [location].
```

---

## Respectful Decline

### Based on Misunderstanding

```latex
\textbf{N. The referee wrote:}

[Reviewer's comment]

\textbf{Our reply:}

We thank the referee for this comment, but respectfully note that there may have been a misunderstanding. In [Section X], we state: "[relevant quote]." This addresses the concern raised.

\textbf{Changes:}

In the revised version, we have clarified this passage to make our meaning more explicit.
```

### Change Would Not Improve the Paper

```latex
\textbf{N. The referee wrote:}

[Reviewer's suggestion]

\textbf{Our reply:}

We appreciate the suggestion but have decided not to implement this change because:
\begin{enumerate}
\item [Reason 1]
\item [Reason 2]
\end{enumerate}
We believe the current approach is appropriate because [justification].

\textbf{Changes:}

No change was made in the revised version. However, we have added a brief justification in [Section X] to clarify our choice.
```

### Outside Scope

```latex
\textbf{N. The referee wrote:}

[Reviewer requests extensive addition]

\textbf{Our reply:}

We thank the referee for this interesting suggestion. While [topic] is important, it falls outside the scope of this paper, which focuses on [stated scope].

\textbf{Changes:}

In the revised version, we have noted this as a promising direction for future work in the Discussion section.
```

### Technical Disagreement

```latex
\textbf{N. The referee wrote:}

[Reviewer suggests methodological change]

\textbf{Our reply:}

We appreciate the suggestion to [alternative method]. However, we retain our current approach for the following reasons:
\begin{enumerate}
\item [Technical reason 1]
\item [Technical reason 2]
\end{enumerate}
This approach is consistent with [prior work / established practice].

\textbf{Changes:}

In the revised version, we have added additional justification in [Section X] to clarify our methodological choice.
```

---

## Pointing to Existing Content

```latex
\textbf{N. The referee wrote:}

[Reviewer asks about something already in the paper]

\textbf{Our reply:}

This point is addressed in [Section X, paragraph Y], where we state: "[exact quote from paper]".

\textbf{Changes:}

In the revised version, we have [added signposting / restructured the section / added a cross-reference] to make this more prominent.
```

---

## Location Reference Format

When describing locations of changes:

| Element | Format |
|---------|--------|
| Section | "Section 3.2" or "Section 3.2, paragraph 2" |
| Equation | "Equation (7)" |
| Figure | "Figure 4" |
| Table | "Table 2" |
| Page/line | "page 8, lines 15--20" |
| LaTeX label | "Section~\ref{sec:methods}" or "Eq.~\eqref{eq:main}" |