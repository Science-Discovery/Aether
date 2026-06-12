---
name: arxiv-search
description: Searches arXiv for preprints and academic papers, retrieves abstracts, and filters by topic. Use when the user asks to find research papers, search arXiv, look up preprints, find academic articles in physics, math, CS, biology, statistics, or related fields.
---

# arXiv Search Skill

## Usage

Run the bundled Python script using the absolute skills directory path from your system prompt:

```bash
.venv/bin/python [YOUR_SKILLS_DIR]/arxiv-search/arxiv_search.py "your search query" [--max-papers N] [--download]
```

- `query` (required): Search query string
- `--max-papers` (optional): Maximum results to retrieve (default: 10)
- `--download` (optional): Download source tarballs to `refs/` in the current directory

### Examples

```bash
.venv/bin/python ~/.deepagents/agent/skills/arxiv-search/arxiv_search.py "deep learning drug discovery" --max-papers 5
```

```bash
.venv/bin/python ~/.deepagents/agent/skills/arxiv-search/arxiv_search.py "QCD sum rules" --max-papers 3 --download
```

## Behavioral Guidelines

- **Always use `--download` by default** when searching for papers. The user's intent when searching is to obtain the papers, not just view abstracts. Only skip `--download` if the user explicitly says they only want abstracts/meta information.
- After downloading, report the file paths of the downloaded source tarballs so the user knows where to find them.

Without `--download`, returns title and abstract for each matching paper.
With `--download`, downloads each paper's source tarball (from `arxiv.org/e-print/`), automatically extracts it to `./refs/<arxiv_id>/`, and deletes the `.tar.gz` file. If the e-print source is unavailable (404), falls back to downloading the PDF into `./refs/`.

## Dependencies

Requires the `arxiv` Python package. If missing, install with:

```bash
.venv/bin/python -m pip install arxiv
```
