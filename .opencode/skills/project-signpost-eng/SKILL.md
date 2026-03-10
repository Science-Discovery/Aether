---
name: project-signpost
description: "Generate and maintain hierarchical README navigation files for any project. Use when organizing a project's file structure for AI-assisted development, creating navigation signposts that help LLMs locate files efficiently through trigger-condition annotations. Supports three formats: top-level (subdirectories only), subfolder (files only), and hybrid (both). Includes templates and prompts for AI-generated summaries and trigger conditions."
---

# Project Guideline — Hierarchical README Navigation System

## Overview

This skill provides a **hierarchical README navigation standard** for projects. The core idea: place a `README_<folder-name>.md` at every directory level of the project, serving as a "navigation map" for AI models. This allows LLMs during vibe coding to precisely locate needed files by reading READMEs layer by layer, rather than scanning all files—significantly reducing token consumption.

## Core Principles

### 1. Layer Isolation

Each layer's `README_<folder-name>.md` **only describes its own level** of files and folders, never reaching into deeper levels.

- The root README only lists top-level folders and files
- Subfolder READMEs only list files within that folder
- Parent-level READMEs never expand on the internal contents of subdirectories

### 2. Trigger-Condition Navigation

Every entry is annotated with "When to Dive In" or "When to Read"—telling the AI: **under what circumstances should you enter this directory or read this file**.

This is the key difference from ordinary documentation: READMEs are not detailed human-readable docs, but **decision signposts for AI**.

### 3. Naming Convention

- Root-level file: `README_root.md` (placed in the project root)
- Subfolder file: `README_<folder-name>.md` (placed inside the folder it describes)
  - Example: `docs/` gets `docs/README_docs.md`
  - Example: `docs/design/` gets `docs/design/README_docs-design.md`

### 4. Scope

- **Skip these directories**: `node_modules/`, `.git/`, `dist/`, `build/`, `__pycache__/`, `venv/`, and any other generated/dependency directories. Only document source and hand-authored content.
- **Skip these files**: Binary files, lock files (`package-lock.json`, `yarn.lock`), and auto-generated files unless they require manual configuration.

## Applicable Scenarios

- Software engineering projects (frontend/backend code, configs, tests, docs)
- Documentation-heavy projects (design docs, meeting notes, technical proposals)
- Any large project with complex file structures where AI can easily get lost

## README Formats

There are **three** README formats, chosen based on what a directory contains:

### 1. Top-Level Format (directories containing only subdirectories)

Use when a directory contains **only subdirectories** and no loose files (or only a README). Three-column table: Name, Description, When to Dive In.

```markdown
# [Icon] [Title]

[One-sentence description]

| Name | Description | When to Dive In |
|------|-------------|-----------------|
| `subfolder/` | [Icon] [Category Name] (N files) | [Trigger Condition] |
```

### 2. Subfolder Format (directories containing only files)

Use when a directory contains **only files** and no subdirectories. Four-column table: File, Topic, Summary, When to Read.

```markdown
# [Icon] [Category Name]

| File | Topic | Summary | When to Read |
|------|-------|---------|--------------|
| [filename.ext] | [Topic] | [One-sentence summary] | [Trigger Condition] |
```

### 3. Hybrid Format (directories containing both files and subdirectories)

Use when a directory contains **both subdirectories and files**. Splits into two sections with separate tables.

```markdown
# [Icon] [Title]

[One-sentence description]

## Subdirectories

| Name | Description | When to Dive In |
|------|-------------|-----------------|
| `subfolder/` | [Icon] [Category Name] (N files) | [Trigger Condition] |

## Files

| File | Topic | Summary | When to Read |
|------|-------|---------|--------------|
| [filename.ext] | [Topic] | [One-sentence summary] | [Trigger Condition] |
```

### Character Limits

- **Trigger condition**: "When you need to..." format, max 40 characters total
- **Summary**: One sentence, max 60 characters total
- **Date format**: `YYYY-MM-DD` (e.g., `2026-03-09`)

## Maintenance

### Adding a file
1. Add a row to the README of the directory where the file was placed
2. If the parent directory's README lists a file count for this folder, update it

### Deleting a file
1. Remove the row from the directory's README
2. Update the parent's file count if applicable

### Renaming or moving a file
1. Remove from the old location's README
2. Add to the new location's README
3. Update file counts in both parent READMEs if applicable

### Adding a new subdirectory
1. Create a `README_<folder-name>.md` inside the new directory
2. Add a row to the parent directory's README
3. If the parent was previously a "subfolder format" (files only), convert it to "hybrid format"

### Bulk reorganization
When restructuring many files at once, regenerate affected READMEs from scratch using the AI prompts rather than patching individual rows.

## Usage Guide

### Manual Usage

1. Create a `README_<folder-name>.md` in every directory level (e.g., `README_docs.md` inside `docs/`)
2. Fill in content using the templates in `templates/`
3. Update the corresponding subfolder README and parent README whenever files change

### Using with AI

1. Provide the prompts from `prompts/` to the AI
2. The AI will automatically generate summaries and trigger conditions based on file content
3. The AI reads README navigation first when working, precisely locating target files

## File Description

| File | Description |
|------|-------------|
| `templates/top-level-readme.md` | Top-level directory README template (subdirectories only) |
| `templates/subfolder-readme.md` | Subfolder README template (files only) |
| `templates/hybrid-readme.md` | Hybrid README template (both files and subdirectories) |
| `examples/` | Complete examples showing the final result of READMEs at each level |
| `prompts/generate-trigger-condition.md` | LLM prompt for generating trigger conditions |
| `prompts/generate-file-summary.md` | LLM prompt for generating file summaries |
