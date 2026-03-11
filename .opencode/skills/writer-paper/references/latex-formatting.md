# LaTeX Formatting Rules

## Table of Contents
1. Text Formatting
2. Math Formatting
3. Figures
4. Citations and References
5. Lists and Enumerations
6. Special Characters
7. Forbidden Markdown Syntax
8. Formula Writing Standards
9. Formula Validation Checklist
10. Common Errors and Corrections
11. Post-Processing Rules

## 1. Text Formatting
- Bold: `\textbf{text}`, NOT `**text**` or `__text__`
- Italic: `\textit{text}`, NOT `*text*` or `_text_`
- Sections: Content placed in `\section{}`, `\subsection{}`, `\subsubsection{}` automatically
- Do NOT use Markdown headers (`#`, `##`, `###`) in content

## 2. Math Formatting
- Inline math: `$equation$`
- Display math: `$$equation$$` or `\begin{equation}...\end{equation}`
- Multi-line equations: `\begin{align} ... \end{align}`
- Math syntax is LaTeX-native; use standard LaTeX math commands

## 3. Figures
- Do NOT use Markdown image syntax `![caption](path)`
- Figures handled automatically by the system
- Reference figures as `Figure~\ref{fig:label}` or `as shown in Figure X`
- Standard figure block:
```latex
\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.8\textwidth]{figures/filename.png}
  \caption{Descriptive caption.}
  \label{fig:unique_label}
\end{figure}
```

## 4. Citations and References
- Use numbered references: `[1]`, `[2]` in text
- Cite as `Smith et al. [1]` or `as shown in [2]` or `previous work [3, 4]`
- References compiled into BibTeX format automatically
- Full reference list generated as separate `.bib` file

## 5. Lists and Enumerations
- Use regular text for lists; LaTeX formatting applied if needed
- For inline lists, use commas or semicolons
- For multi-item lists, use numbered format: `(1) item, (2) item, etc.`

## 6. Special Characters
- Most special characters escaped automatically
- In math mode, use standard LaTeX: `\alpha`, `\beta`, `\sum`, `\int`, etc.
- For text, write naturally; special character escaping is handled automatically

## 7. Forbidden Markdown Syntax

DO NOT USE:
- Markdown headers: `##`, `###`
- Markdown bold/italic: `**`, `*`, `__`, `_`
- Markdown images: `![caption](path)`
- Markdown links: `[text](url)` (write "see URL" instead)
- Markdown code blocks with triple backticks

INSTEAD USE:
- Write plain text for sections (headers added automatically)
- `\textbf{}` and `\textit{}` for emphasis
- Reference figures by number
- Write URLs directly or use descriptive text
- Math in `$...$` or `$$...$$`

## 8. Formula Writing Standards

### Basic Syntax Rules
- All commands start with backslash: `\frac`, `\sum`, `\int`, `\partial`
- Superscripts/subscripts: `^` and `_`, multi-character MUST use braces: `x^{2n}`, `a_{ij}`, `e^{-i\omega t}`
- Fractions: `\frac{numerator}{denominator}`, not `numerator/denominator`
- Roots: `\sqrt{}`, nth root `\sqrt[n]{}`
- Matched brackets: `\left( ... \right)`, `\left[ ... \right]`, `\left\{ ... \right\}`

### Greek Letters

| Lowercase | Command | Uppercase | Command |
|-----------|---------|-----------|---------|
| α | `\alpha` | — | A |
| β | `\beta` | — | B |
| γ | `\gamma` | Γ | `\Gamma` |
| δ | `\delta` | Δ | `\Delta` |
| ε | `\epsilon`, `\varepsilon` | — | E |
| ζ | `\zeta` | — | Z |
| η | `\eta` | — | H |
| θ | `\theta`, `\vartheta` | Θ | `\Theta` |
| λ | `\lambda` | Λ | `\Lambda` |
| μ | `\mu` | — | M |
| ν | `\nu` | — | N |
| ξ | `\xi` | Ξ | `\Xi` |
| π | `\pi` | Π | `\Pi` |
| ρ | `\rho` | — | P |
| σ | `\sigma` | Σ | `\Sigma` |
| τ | `\tau` | — | T |
| φ | `\phi`, `\varphi` | Φ | `\Phi` |
| χ | `\chi` | — | X |
| ψ | `\psi` | Ψ | `\Psi` |
| ω | `\omega` | Ω | `\Omega` |

### Math Operators (use commands, not plain text)
- Trigonometric: `\sin`, `\cos`, `\tan`, `\cot`, `\sec`, `\csc`
- Logarithmic: `\log`, `\ln`, `\lg`
- Exponential: `\exp`
- Limits: `\lim_{x \to a}`
- Summation: `\sum_{i=1}^{n}`
- Integration: `\int_{a}^{b}`, `\oint`, `\iint`, `\iiint`
- Products: `\prod_{i=1}^{n}`

### Physics Symbols

| Symbol | LaTeX | Description |
|--------|-------|-------------|
| ℏ | `\hbar` | Reduced Planck constant |
| ∂ | `\partial` | Partial derivative |
| ∇ | `\nabla` | Gradient/divergence/curl |
| ⟨⟩ | `\langle \rangle` | Dirac bracket / expectation |
| † | `\dagger` | Hermitian conjugate |
| ⊗ | `\otimes` | Tensor product |
| · | `\cdot` | Dot product |
| × | `\times` | Cross product |
| ≈ | `\approx` | Approximately equal |
| ≡ | `\equiv` | Identically equal |
| ∝ | `\propto` | Proportional to |
| ∞ | `\infty` | Infinity |

### Formula Environments
- Inline: `$E = mc^2$`
- Display (unnumbered): `\[ H = \frac{p^2}{2m} + V(x) \]`
- Display (numbered):
```latex
\begin{equation}
  i\hbar \frac{\partial}{\partial t} \Psi = \hat{H} \Psi
\end{equation}
```
- Multi-line aligned:
```latex
\begin{align}
  F &= ma \\
  &= m \frac{dv}{dt}
\end{align}
```

## 9. Formula Validation Checklist

Before generating each formula, confirm:
- [ ] Braces `{}` are matched and paired
- [ ] Command spelling is correct (`\frac` not `\frc`, `\lambda` not `\lamda`)
- [ ] Multi-character superscripts/subscripts use braces (`x^{10}` not `x^10`)
- [ ] Math operators use commands (`\sin` not `sin`)
- [ ] Greek letter spelling is correct
- [ ] Physical dimensions are correct

## 10. Common Errors and Corrections

| Error | Correction |
|-------|-----------|
| `$\frc{1}{2}$` | `$\frac{1}{2}$` |
| `$e^-iwt$` | `$e^{-i\omega t}$` |
| `$sin(x)$` | `$\sin(x)$` |
| `$\lamda$` | `$\lambda$` |
| `$<\psi\|$` | `$\langle\psi\|$` |
| `$\partial/\partial x$` | `$\frac{\partial}{\partial x}$` |

## 11. Post-Processing Rules

Apply these cleanup transformations to generated content:

1. Remove duplicate `\section{}` at beginning of section content (AI often re-outputs the section header)
2. Remove duplicate `\begin{abstract}` / `\end{abstract}` wrappers (for Abstract section)
3. Remove AI-generated `\begin{thebibliography}...\end{thebibliography}` (bibliography added separately)
4. Remove `\subsection*{References}` or `**References**` headers AI might append
5. Strip Markdown heading markers (`#`, `##`, `###`) — remove `#` symbols only
6. Convert `**text**` → `\textbf{text}`
7. Convert `*text*` → `\textit{text}` (except inside math mode)
8. Escape standalone `#` characters (LaTeX special char) — after Markdown heading removal
9. Collapse multiple blank lines (3+) into double newlines
