#!/usr/bin/env python3
"""
Report Generator - Generate comprehensive skill reports

Usage:
    python generate_report.py <skills_directory> --output report.md [options]

Options:
    --output FILE     Output file path (required)
    --include-deps    Include dependency analysis
    --include-stats   Include statistics dashboard
    --include-recs    Include smart recommendations
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

DOMAINS = {
    "development-tools": {
        "keywords": ["code", "debug", "git", "version control", "refactor", "test", "lint", "build", "compile", "deploy", "ci/cd", "programming", "development", "api", "framework", "library", "module"],
        "description": "Code generation, debugging, version control, and development workflows",
    },
    "document-processing": {
        "keywords": ["pdf", "docx", "document", "word", "powerpoint", "ppt", "text", "markdown", "latex", "format", "convert", "extract", "merge", "split", "edit", "template", "report"],
        "description": "PDF, DOCX, PPT, and text document manipulation",
    },
    "data-analysis": {
        "keywords": ["data", "analysis", "visualization", "chart", "graph", "statistics", "csv", "excel", "database", "query", "sql", "bigquery", "pandas", "numpy", "analytics", "metrics", "dashboard"],
        "description": "Data processing, visualization, and statistical analysis",
    },
    "research-assistant": {
        "keywords": ["research", "paper", "academic", "literature", "citation", "arxiv", "scholar", "thesis", "publication", "review", "bibliography", "scientific", "study", "analysis", "hypothesis"],
        "description": "Literature review, paper writing, and academic research",
    },
    "automation-workflow": {
        "keywords": ["automate", "workflow", "batch", "pipeline", "schedule", "cron", "script", "task", "process", "integration", "trigger", "action", "event", "chain", "orchestrate"],
        "description": "Workflow automation, batch processing, and task orchestration",
    },
    "content-creation": {
        "keywords": ["write", "content", "article", "blog", "copy", "creative", "design", "media", "image", "video", "audio", "presentation", "slides", "storytelling", "narrative", "draft"],
        "description": "Writing, design, media production, and creative content",
    },
    "api-integration": {
        "keywords": ["api", "rest", "graphql", "endpoint", "client", "http", "request", "response", "webhook", "service", "integration", "oauth", "auth", "connect", "fetch", "post", "get"],
        "description": "API clients, web services, and external integrations",
    },
    "utilities": {
        "keywords": ["utility", "helper", "tool", "general", "common", "shared", "base", "core", "standard", "simple", "basic"],
        "description": "General-purpose tools and helper functions",
    },
}


@dataclass
class SkillInfo:
    name: str
    path: Path
    description: str = ""
    has_scripts: bool = False
    has_references: bool = False
    has_assets: bool = False
    is_valid: bool = True
    validation_errors: list = field(default_factory=list)
    script_count: int = 0
    reference_count: int = 0
    asset_count: int = 0
    primary_domain: str = "utilities"
    domain_scores: dict = field(default_factory=dict)
    references_other: list = field(default_factory=list)
    referenced_by: list = field(default_factory=list)


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
            parsed[current_key] = f"{current_value}\n{stripped}" if current_value else stripped
            continue
        if ":" not in stripped:
            return None
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            return None
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        parsed[key] = value
        current_key = key
    return parsed


def validate_skill(skill_path: Path) -> tuple[bool, list[str]]:
    errors = []
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, ["SKILL.md not found"]
    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as e:
        return False, [f"Could not read SKILL.md: {e}"]
    frontmatter_text = _extract_frontmatter(content)
    if frontmatter_text is None:
        return False, ["Invalid frontmatter format"]
    if yaml is not None:
        try:
            frontmatter = yaml.safe_load(frontmatter_text)
            if not isinstance(frontmatter, dict):
                return False, ["Frontmatter must be a YAML dictionary"]
        except yaml.YAMLError as e:
            return False, [f"Invalid YAML in frontmatter: {e}"]
    else:
        frontmatter = _parse_simple_frontmatter(frontmatter_text)
        if frontmatter is None:
            return False, ["Invalid YAML in frontmatter"]
    allowed_properties = {"name", "description", "license", "allowed-tools", "metadata"}
    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if unexpected_keys:
        errors.append(f"Unexpected key(s): {', '.join(sorted(unexpected_keys))}")
    if "name" not in frontmatter:
        errors.append("Missing 'name' in frontmatter")
    else:
        name = frontmatter.get("name", "")
        if not isinstance(name, str):
            errors.append(f"Name must be a string")
        else:
            name = name.strip()
            if name:
                if not re.match(r"^[a-z0-9-]+$", name):
                    errors.append(f"Name should be hyphen-case")
                if name.startswith("-") or name.endswith("-") or "--" in name:
                    errors.append("Name has invalid hyphen placement")
    if "description" not in frontmatter:
        errors.append("Missing 'description' in frontmatter")
    return len(errors) == 0, errors


def classify_skill(name: str, description: str) -> tuple[str, dict]:
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
    return primary_domain, domain_scores


def analyze_skills(directory: Path) -> dict[str, SkillInfo]:
    skills = {}
    for item in sorted(directory.iterdir()):
        if item.is_dir() and (item / "SKILL.md").exists():
            skill_md = item / "SKILL.md"
            try:
                content = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            name = item.name
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
            scripts_dir = item / "scripts"
            references_dir = item / "references"
            assets_dir = item / "assets"
            has_scripts = scripts_dir.is_dir()
            has_references = references_dir.is_dir()
            has_assets = assets_dir.is_dir()
            script_count = len(list(scripts_dir.glob("*.py"))) + len(list(scripts_dir.glob("*.sh"))) if has_scripts else 0
            reference_count = len(list(references_dir.glob("*.md"))) if has_references else 0
            asset_count = sum(1 for _ in assets_dir.rglob("*") if _.is_file()) if has_assets else 0
            is_valid, validation_errors = validate_skill(item)
            primary_domain, domain_scores = classify_skill(name, description)
            skills[name] = SkillInfo(
                name=name,
                path=item,
                description=description,
                has_scripts=has_scripts,
                has_references=has_references,
                has_assets=has_assets,
                is_valid=is_valid,
                validation_errors=validation_errors,
                script_count=script_count,
                reference_count=reference_count,
                asset_count=asset_count,
                primary_domain=primary_domain,
                domain_scores=domain_scores,
            )
    return skills


def analyze_dependencies(skills: dict[str, SkillInfo]) -> None:
    skill_names = set(skills.keys())
    for skill_name, skill_info in skills.items():
        try:
            content = (skill_info.path / "SKILL.md").read_text(encoding="utf-8")
            content_lower = content.lower()
            for other_name in skill_names - {skill_name}:
                patterns = [
                    rf"\b{re.escape(other_name)}\b",
                    rf"\[.*{re.escape(other_name)}.*\]",
                    rf"`{re.escape(other_name)}`",
                ]
                for pattern in patterns:
                    if re.search(pattern, content_lower):
                        skill_info.references_other.append(other_name)
                        if other_name in skills:
                            skills[other_name].referenced_by.append(skill_name)
                        break
        except OSError:
            continue


def generate_recommendations(skills: dict[str, SkillInfo]) -> list[str]:
    recommendations = []
    descriptions = {}
    for name, info in skills.items():
        desc_key = info.description[:50].lower()
        if desc_key in descriptions:
            recommendations.append(f"**Duplicate detection**: '{name}' and '{descriptions[desc_key]}' have similar descriptions. Consider differentiating or merging.")
        else:
            descriptions[desc_key] = name
    for name, info in skills.items():
        if not info.has_scripts and not info.has_references and not info.has_assets:
            recommendations.append(f"**Resource suggestion**: '{name}' has no bundled resources. Consider adding scripts/ for automation capabilities.")
        if "use when" not in info.description.lower() and "triggers" not in info.description.lower():
            recommendations.append(f"**Trigger improvement**: '{name}' description lacks 'Use when...' or trigger phrases. Add context for better skill activation.")
        if len(info.description) > 500:
            recommendations.append(f"**Description length**: '{name}' description is very long ({len(info.description)} chars). Consider moving details to references/.")
        if not info.is_valid:
            recommendations.append(f"**Validation error**: '{name}' has validation issues: {', '.join(info.validation_errors)}")
    orphan_skills = [name for name, info in skills.items() if not info.referenced_by and not info.references_other]
    if len(orphan_skills) > 2 and len(skills) > 3:
        recommendations.append(f"**Orphan skills**: {', '.join(orphan_skills[:5])} have no cross-references. Consider linking related skills.")
    return recommendations


def generate_report(directory: Path, include_deps: bool = True, include_stats: bool = True, include_recs: bool = True) -> str:
    skills = analyze_skills(directory)
    if include_deps:
        analyze_dependencies(skills)
    total = len(skills)
    valid = sum(1 for s in skills.values() if s.is_valid)
    invalid = total - valid
    by_domain = defaultdict(list)
    for info in skills.values():
        by_domain[info.primary_domain].append(info)
    lines = [
        f"# Skills Inventory Report",
        f"",
        f"> Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"> Directory: `{directory}`",
        f"",
        f"## Summary",
        f"",
        f"| Metric | Count |",
        f"|--------|-------|",
        f"| Total Skills | {total} |",
        f"| Valid | {valid} |",
        f"| Invalid | {invalid} |",
        f"| With Scripts | {sum(1 for s in skills.values() if s.has_scripts)} |",
        f"| With References | {sum(1 for s in skills.values() if s.has_references)} |",
        f"| With Assets | {sum(1 for s in skills.values() if s.has_assets)} |",
        f"",
    ]
    if include_stats:
        lines.extend([
            f"## Statistics Dashboard",
            f"",
            f"### Distribution by Domain",
            f"",
            f"| Domain | Count | Percentage |",
            f"|--------|-------|------------|",
        ])
        for domain in sorted(by_domain.keys(), key=lambda d: len(by_domain[d]), reverse=True):
            count = len(by_domain[domain])
            pct = (count / total * 100) if total > 0 else 0
            lines.append(f"| {domain} | {count} | {pct:.1f}% |")
        lines.append(f"")
        lines.append(f"### Resource Distribution")
        lines.append(f"")
        lines.append(f"| Resource Type | Skills Using | Total Files |")
        lines.append(f"|---------------|--------------|-------------|")
        lines.append(f"| scripts/ | {sum(1 for s in skills.values() if s.has_scripts)} | {sum(s.script_count for s in skills.values())} |")
        lines.append(f"| references/ | {sum(1 for s in skills.values() if s.has_references)} | {sum(s.reference_count for s in skills.values())} |")
        lines.append(f"| assets/ | {sum(1 for s in skills.values() if s.has_assets)} | {sum(s.asset_count for s in skills.values())} |")
        lines.append(f"")
    lines.append(f"## Skills by Domain")
    lines.append(f"")
    for domain in sorted(by_domain.keys(), key=lambda d: len(by_domain[d]), reverse=True):
        domain_skills = by_domain[domain]
        config = DOMAINS.get(domain, {})
        lines.append(f"### {domain}")
        lines.append(f"")
        if config.get("description"):
            lines.append(f"*{config['description']}*")
            lines.append(f"")
        lines.append(f"| Name | Status | Description |")
        lines.append(f"|------|--------|-------------|")
        for info in sorted(domain_skills, key=lambda s: s.name):
            status = "✅" if info.is_valid else "❌"
            desc_short = info.description[:60] + "..." if len(info.description) > 60 else info.description
            lines.append(f"| {info.name} | {status} | {desc_short} |")
        lines.append(f"")
    if include_deps:
        lines.append(f"## Dependency Analysis")
        lines.append(f"")
        has_deps = any(info.references_other for info in skills.values())
        if not has_deps:
            lines.append(f"No dependencies detected between skills.")
            lines.append(f"")
        else:
            lines.append(f"### Skills with References")
            lines.append(f"")
            for name, info in sorted(skills.items()):
                if info.references_other:
                    lines.append(f"- **{name}** → {', '.join(info.references_other)}")
            lines.append(f"")
            referenced = [(name, len(info.referenced_by)) for name, info in skills.items() if info.referenced_by]
            if referenced:
                lines.append(f"### Most Referenced Skills")
                lines.append(f"")
                for name, count in sorted(referenced, key=lambda x: x[1], reverse=True)[:5]:
                    lines.append(f"- **{name}** (referenced by {count} skill(s))")
                lines.append(f"")
    if include_recs:
        recommendations = generate_recommendations(skills)
        lines.append(f"## Smart Recommendations")
        lines.append(f"")
        if not recommendations:
            lines.append(f"No issues detected. Skills are well-structured!")
            lines.append(f"")
        else:
            for i, rec in enumerate(recommendations[:10], 1):
                lines.append(f"{i}. {rec}")
            lines.append(f"")
    lines.append(f"---")
    lines.append(f"*Generated by skill-manager*")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate comprehensive skill report")
    parser.add_argument("directory", help="Directory containing skills")
    parser.add_argument("--output", "-o", required=True, help="Output file path")
    parser.add_argument("--include-deps", action="store_true", default=True, help="Include dependency analysis")
    parser.add_argument("--include-stats", action="store_true", default=True, help="Include statistics dashboard")
    parser.add_argument("--include-recs", action="store_true", default=True, help="Include smart recommendations")
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if not directory.is_dir():
        print(f"[ERROR] Directory not found: {directory}")
        sys.exit(1)
    print(f"Generating report for: {directory}")
    print()
    report = generate_report(
        directory,
        include_deps=args.include_deps,
        include_stats=args.include_stats,
        include_recs=args.include_recs,
    )
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report, encoding="utf-8")
    print(f"Report saved to: {output_path}")
    print()
    print(f"Report preview:")
    print("-" * 40)
    lines = report.split("\n")
    preview_lines = lines[:50]
    print("\n".join(preview_lines))
    if len(lines) > 50:
        print(f"\n... ({len(lines) - 50} more lines)")


if __name__ == "__main__":
    main()