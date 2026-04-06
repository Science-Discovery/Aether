#!/usr/bin/env python3
"""
Skill Classifier - Categorize skills by functional domain

Usage:
    python classify.py <skills_directory> [options]

Options:
    --output FILE    Save classification to file
    --json           Output as JSON
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

DOMAINS = {
    "development-tools": {
        "keywords": [
            "code",
            "debug",
            "git",
            "version control",
            "refactor",
            "test",
            "lint",
            "build",
            "compile",
            "deploy",
            "ci/cd",
            "programming",
            "development",
            "api",
            "framework",
            "library",
            "module",
        ],
        "description": "Code generation, debugging, version control, and development workflows",
    },
    "document-processing": {
        "keywords": [
            "pdf",
            "docx",
            "document",
            "word",
            "powerpoint",
            "ppt",
            "text",
            "markdown",
            "latex",
            "format",
            "convert",
            "extract",
            "merge",
            "split",
            "edit",
            "template",
            "report",
        ],
        "description": "PDF, DOCX, PPT, and text document manipulation",
    },
    "data-analysis": {
        "keywords": [
            "data",
            "analysis",
            "visualization",
            "chart",
            "graph",
            "statistics",
            "csv",
            "excel",
            "database",
            "query",
            "sql",
            "bigquery",
            "pandas",
            "numpy",
            "analytics",
            "metrics",
            "dashboard",
        ],
        "description": "Data processing, visualization, and statistical analysis",
    },
    "research-assistant": {
        "keywords": [
            "research",
            "paper",
            "academic",
            "literature",
            "citation",
            "arxiv",
            "scholar",
            "thesis",
            "publication",
            "review",
            "bibliography",
            "scientific",
            "study",
            "analysis",
            "hypothesis",
        ],
        "description": "Literature review, paper writing, and academic research",
    },
    "automation-workflow": {
        "keywords": [
            "automate",
            "workflow",
            "batch",
            "pipeline",
            "schedule",
            "cron",
            "script",
            "task",
            "process",
            "integration",
            "trigger",
            "action",
            "event",
            "chain",
            "orchestrate",
        ],
        "description": "Workflow automation, batch processing, and task orchestration",
    },
    "content-creation": {
        "keywords": [
            "write",
            "content",
            "article",
            "blog",
            "copy",
            "creative",
            "design",
            "media",
            "image",
            "video",
            "audio",
            "presentation",
            "slides",
            "storytelling",
            "narrative",
            "draft",
        ],
        "description": "Writing, design, media production, and creative content",
    },
    "api-integration": {
        "keywords": [
            "api",
            "rest",
            "graphql",
            "endpoint",
            "client",
            "http",
            "request",
            "response",
            "webhook",
            "service",
            "integration",
            "oauth",
            "auth",
            "connect",
            "fetch",
            "post",
            "get",
        ],
        "description": "API clients, web services, and external integrations",
    },
    "utilities": {
        "keywords": [
            "utility",
            "helper",
            "tool",
            "general",
            "common",
            "shared",
            "base",
            "core",
            "standard",
            "simple",
            "basic",
        ],
        "description": "General-purpose tools and helper functions",
    },
}


@dataclass
class ClassifiedSkill:
    name: str
    path: Path
    description: str
    primary_domain: str
    domain_scores: dict = field(default_factory=dict)


@dataclass
class ClassificationResult:
    directory: Path
    skills: list = field(default_factory=list)
    by_domain: dict = field(default_factory=lambda: defaultdict(list))


def _extract_frontmatter(content: str) -> Optional[str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i])
    return None


def _parse_simple_frontmatter(frontmatter_text: str) -> Optional[dict]:
    parsed = {}
    current_key = None
    for raw_line in frontmatter_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        is_indented = raw_line[:1].isspace()
        if is_indented:
            if current_key is None:
                return None
            current_value = parsed[current_key]
            parsed[current_key] = (
                f"{current_value}\n{stripped}" if current_value else stripped
            )
            continue
        if ":" not in stripped:
            return None
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            return None
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        parsed[key] = value
        current_key = key
    return parsed


def classify_skill(skill_path: Path) -> Optional[ClassifiedSkill]:
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return None
    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError:
        return None
    name = skill_path.name
    description = ""
    frontmatter_text = _extract_frontmatter(content)
    if frontmatter_text:
        if yaml is not None:
            try:
                frontmatter = yaml.safe_load(frontmatter_text)
                if isinstance(frontmatter, dict):
                    name = frontmatter.get("name", name) or name
                    description = frontmatter.get("description", "") or ""
            except yaml.YAMLError:
                pass
        else:
            frontmatter = _parse_simple_frontmatter(frontmatter_text)
            if frontmatter:
                name = frontmatter.get("name", name) or name
                description = frontmatter.get("description", "") or ""
    text_to_analyze = f"{name} {description}".lower()
    domain_scores = {}
    for domain, config in DOMAINS.items():
        score = 0
        for keyword in config["keywords"]:
            if keyword.lower() in text_to_analyze:
                score += 1
        domain_scores[domain] = score
    max_score = max(domain_scores.values()) if domain_scores else 0
    if max_score > 0:
        primary_domain = max(domain_scores, key=domain_scores.get)
    else:
        primary_domain = "utilities"
    return ClassifiedSkill(
        name=name,
        path=skill_path,
        description=description,
        primary_domain=primary_domain,
        domain_scores=domain_scores,
    )


def classify_skills(directory: Path) -> ClassificationResult:
    result = ClassificationResult(directory=directory)
    for item in sorted(directory.iterdir()):
        if item.is_dir() and (item / "SKILL.md").exists():
            classified = classify_skill(item)
            if classified:
                result.skills.append(classified)
                result.by_domain[classified.primary_domain].append(classified)
    return result


def generate_markdown_output(result: ClassificationResult) -> str:
    lines = [
        f"# Skill Classification Report",
        f"",
        f"**Directory:** `{result.directory}`",
        f"",
        f"## Summary",
        f"",
        f"| Domain | Count |",
        f"|--------|-------|",
    ]
    for domain in sorted(
        result.by_domain.keys(), key=lambda d: len(result.by_domain[d]), reverse=True
    ):
        count = len(result.by_domain[domain])
        lines.append(f"| {domain} | {count} |")
    lines.append(f"")
    lines.append(f"## Skills by Domain")
    lines.append(f"")
    for domain in sorted(
        result.by_domain.keys(), key=lambda d: len(result.by_domain[d]), reverse=True
    ):
        skills = result.by_domain[domain]
        config = DOMAINS.get(domain, {})
        lines.append(f"### {domain}")
        lines.append(f"")
        if config.get("description"):
            lines.append(f"*{config['description']}*")
            lines.append(f"")
        for skill in skills:
            lines.append(
                f"- **{skill.name}**: {skill.description[:100]}{'...' if len(skill.description) > 100 else ''}"
            )
        lines.append(f"")
    return "\n".join(lines)


def generate_json_output(result: ClassificationResult) -> dict:
    return {
        "directory": str(result.directory),
        "summary": {domain: len(skills) for domain, skills in result.by_domain.items()},
        "domains": {
            domain: {
                "description": DOMAINS.get(domain, {}).get("description", ""),
                "skills": [
                    {
                        "name": s.name,
                        "path": str(s.path),
                        "description": s.description,
                        "domain_scores": s.domain_scores,
                    }
                    for s in skills
                ],
            }
            for domain, skills in result.by_domain.items()
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Classify skills by functional domain")
    parser.add_argument("directory", help="Directory containing skills")
    parser.add_argument("--output", "-o", help="Output file path")
    parser.add_argument(
        "--json", action="store_true", help="Output as JSON instead of Markdown"
    )
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if not directory.is_dir():
        print(f"[ERROR] Directory not found: {directory}")
        sys.exit(1)
    print(f"Classifying skills in: {directory}")
    print()
    result = classify_skills(directory)
    print(
        f"Classified {len(result.skills)} skills into {len(result.by_domain)} domains:"
    )
    print()
    for domain in sorted(
        result.by_domain.keys(), key=lambda d: len(result.by_domain[d]), reverse=True
    ):
        print(f"  {domain}: {len(result.by_domain[domain])} skills")
    print()
    if args.output:
        if args.json:
            output = generate_json_output(result)
            content = json.dumps(output, indent=2)
        else:
            content = generate_markdown_output(result)
        Path(args.output).write_text(content, encoding="utf-8")
        print(f"Output saved to: {args.output}")


if __name__ == "__main__":
    main()
