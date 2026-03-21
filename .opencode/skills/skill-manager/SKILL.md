---
name: skill-manager
description: Scan, classify, analyze, and manage AgentSkills in a directory. Use when the user asks to scan skills, list skills, classify skills by function, analyze skill dependencies, generate skill reports, find duplicate skills, get skill recommendations, or manage a collection of skills. Triggers on phrases like "scan my skills", "analyze skills folder", "list all skills", "generate skill report", "what skills do I have", "skill inventory", "skill catalog".
---

# Skill Manager

Scan, classify, analyze, and manage AgentSkills collections.

## Overview

This skill provides tools to:
- **Scan** directories to discover and validate all skills
- **Classify** skills by functional domain
- **Analyze** dependencies and relationships between skills
- **Generate** comprehensive reports in Markdown format
- **Recommend** appropriate skills for specific tasks

## Quick Start

```bash
# Scan a skills directory and generate a report
python scripts/scan_skills.py /path/to/skills --report skills_report.md

# Classify skills by domain
python scripts/classify.py /path/to/skills

# Analyze skill dependencies
python scripts/analyze_deps.py /path/to/skills

# Generate full report with all analyses
python scripts/generate_report.py /path/to/skills --output report.md
```

## Core Commands

### 1. Scan Skills

Discover and validate all skills in a directory:

```bash
python scripts/scan_skills.py <skills_directory> [options]

Options:
  --report FILE    Output Markdown report
  --json FILE      Output JSON data
  --validate       Check skill structure validity
  --verbose        Show detailed output
```

Output includes:
- List of discovered skills with names and descriptions
- Resource directories present (scripts/, references/, assets/)
- Validation status and any errors
- Statistics summary

### 2. Classify Skills

Categorize skills by functional domain:

```bash
python scripts/classify.py <skills_directory> [options]

Options:
  --output FILE    Save classification to file
  --json           Output as JSON
```

Classification domains:
- **development-tools**: Code generation, debugging, version control
- **document-processing**: PDF, DOCX, PPT, text manipulation
- **data-analysis**: Data processing, visualization, statistics
- **research-assistant**: Literature review, paper writing, citations
- **automation-workflow**: Workflow automation, batch processing
- **content-creation**: Writing, design, media production
- **api-integration**: API clients, web services
- **utilities**: General-purpose tools, helpers

### 3. Analyze Dependencies

Detect relationships and dependencies between skills:

```bash
python scripts/analyze_deps.py <skills_directory> [options]

Options:
  --output FILE    Save dependency graph to file
  --format FORMAT  Output format: text, json, dot (for Graphviz)
```

Analyzes:
- Cross-references in SKILL.md files
- Shared resource patterns
- Complementary functionality

### 4. Generate Report

Create a comprehensive Markdown report:

```bash
python scripts/generate_report.py <skills_directory> --output report.md

Options:
  --output FILE    Output file path (required)
  --include-deps   Include dependency analysis
  --include-stats  Include statistics dashboard
  --include-recs   Include smart recommendations
```

Report sections:
1. **Summary**: Total skills, validation status, resource counts
2. **Classification**: Skills grouped by functional domain
3. **Statistics**: Distribution charts, resource usage
4. **Dependencies**: Relationship graph, complementary skills
5. **Recommendations**: Suggested improvements, duplicate detection

## Workflow

```
1. Scan skills directory
   └─> Discover all SKILL.md files
   └─> Extract frontmatter metadata
   └─> Check directory structure

2. Classify each skill
   └─> Parse description content
   └─> Match keywords to domains
   └─> Assign primary category

3. Analyze relationships
   └─> Scan for cross-references
   └─> Detect shared patterns
   └─> Map dependency graph

4. Generate output
   └─> Compile statistics
   └─> Format Markdown report
   └─> Include recommendations
```

## Smart Recommendations

The analyzer provides suggestions:

| Detection | Recommendation |
|-----------|----------------|
| Similar descriptions | Consider merging or differentiating |
| Missing resources | Add scripts/ for automation |
| No triggers in description | Add "Use when..." phrases |
| Orphaned skills | Link to related skills |
| Large skill files | Split into focused modules |

## Output Format

Generated reports follow this structure:

```markdown
# Skills Inventory Report

## Summary
- Total Skills: 12
- Valid: 11
- Warnings: 1

## By Domain

### Development Tools (3)
- skill-name: Description...

### Document Processing (4)
...

## Statistics
| Domain | Count | Percentage |
|--------|-------|------------|
| development-tools | 3 | 25% |
...

## Dependencies
- skill-a references skill-b
...

## Recommendations
1. Consider splitting large-skill into smaller modules
...
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scan_skills.py` | Core discovery and validation |
| `classify.py` | Domain classification logic |
| `analyze_deps.py` | Dependency graph analysis |
| `generate_report.py` | Markdown report generation |