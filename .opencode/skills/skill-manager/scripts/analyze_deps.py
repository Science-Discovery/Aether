#!/usr/bin/env python3
"""
Dependency Analyzer - Detect relationships between skills

Usage:
    python analyze_deps.py <skills_directory> [options]

Options:
    --output FILE    Save analysis to file
    --format FORMAT  Output format: text, json, dot
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


@dataclass
class Dependency:
    from_skill: str
    to_skill: str
    dep_type: str
    evidence: str = ""


@dataclass
class DependencyResult:
    directory: Path
    dependencies: list = field(default_factory=list)
    by_skill: dict = field(default_factory=lambda: defaultdict(list))
    skill_names: set = field(default_factory=set)


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


def find_skill_references(content: str, skill_names: set) -> list[tuple[str, str]]:
    references = []
    content_lower = content.lower()
    for skill_name in skill_names:
        patterns = [
            rf"\b{re.escape(skill_name)}\b",
            rf"\[.*{re.escape(skill_name)}.*\]",
            rf"`{re.escape(skill_name)}`",
            rf"{re.escape(skill_name)}\.md",
        ]
        for pattern in patterns:
            if re.search(pattern, content_lower):
                references.append((skill_name, f"Found reference pattern: {pattern}"))
                break
    return references


def analyze_dependencies(directory: Path) -> DependencyResult:
    result = DependencyResult(directory=directory)
    skill_data = {}
    for item in sorted(directory.iterdir()):
        if item.is_dir() and (item / "SKILL.md").exists():
            skill_md = item / "SKILL.md"
            try:
                content = skill_md.read_text(encoding="utf-8")
                name = item.name
                frontmatter_text = _extract_frontmatter(content)
                if frontmatter_text:
                    if yaml is not None:
                        try:
                            frontmatter = yaml.safe_load(frontmatter_text)
                            if isinstance(frontmatter, dict):
                                name = frontmatter.get("name", name) or name
                        except yaml.YAMLError:
                            pass
                    else:
                        frontmatter = _parse_simple_frontmatter(frontmatter_text)
                        if frontmatter:
                            name = frontmatter.get("name", name) or name
                skill_data[name] = {"path": item, "content": content}
                result.skill_names.add(name)
            except OSError:
                continue
    for skill_name, data in skill_data.items():
        references = find_skill_references(data["content"], result.skill_names - {skill_name})
        for ref_name, evidence in references:
            dep = Dependency(
                from_skill=skill_name,
                to_skill=ref_name,
                dep_type="reference",
                evidence=evidence,
            )
            result.dependencies.append(dep)
            result.by_skill[skill_name].append(dep)
    return result


def generate_text_output(result: DependencyResult) -> str:
    lines = [
        f"# Skill Dependency Analysis",
        f"",
        f"**Directory:** `{result.directory}`",
        f"",
        f"## Summary",
        f"",
        f"- Total skills: {len(result.skill_names)}",
        f"- Total dependencies found: {len(result.dependencies)}",
        f"- Skills with dependencies: {len(result.by_skill)}",
        f"",
        f"## Dependency Graph",
        f"",
    ]
    if not result.dependencies:
        lines.append("No dependencies detected between skills.")
    else:
        for skill_name in sorted(result.by_skill.keys()):
            deps = result.by_skill[skill_name]
            lines.append(f"### {skill_name}")
            lines.append(f"")
            for dep in deps:
                lines.append(f"- → **{dep.to_skill}** ({dep.dep_type})")
                if dep.evidence:
                    lines.append(f"  - {dep.evidence}")
            lines.append(f"")
    return "\n".join(lines)


def generate_json_output(result: DependencyResult) -> dict:
    return {
        "directory": str(result.directory),
        "summary": {
            "total_skills": len(result.skill_names),
            "total_dependencies": len(result.dependencies),
            "skills_with_dependencies": len(result.by_skill),
        },
        "dependencies": [
            {
                "from": d.from_skill,
                "to": d.to_skill,
                "type": d.dep_type,
                "evidence": d.evidence,
            }
            for d in result.dependencies
        ],
        "by_skill": {
            skill: [
                {
                    "to": d.to_skill,
                    "type": d.dep_type,
                    "evidence": d.evidence,
                }
                for d in deps
            ]
            for skill, deps in result.by_skill.items()
        },
    }


def generate_dot_output(result: DependencyResult) -> str:
    lines = [
        "digraph SkillDependencies {",
        '    rankdir=LR;',
        '    node [shape=box];',
        "",
    ]
    for skill_name in sorted(result.skill_names):
        safe_name = skill_name.replace("-", "_")
        lines.append(f'    {safe_name} [label="{skill_name}"];')
    lines.append("")
    for dep in result.dependencies:
        from_safe = dep.from_skill.replace("-", "_")
        to_safe = dep.to_skill.replace("-", "_")
        lines.append(f'    {from_safe} -> {to_safe};')
    lines.append("}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Analyze dependencies between skills")
    parser.add_argument("directory", help="Directory containing skills")
    parser.add_argument("--output", "-o", help="Output file path")
    parser.add_argument("--format", "-f", choices=["text", "json", "dot"], default="text", help="Output format")
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if not directory.is_dir():
        print(f"[ERROR] Directory not found: {directory}")
        sys.exit(1)
    print(f"Analyzing dependencies in: {directory}")
    print()
    result = analyze_dependencies(directory)
    print(f"Found {len(result.dependencies)} dependencies across {len(result.skill_names)} skills")
    print()
    if args.format == "text":
        output = generate_text_output(result)
    elif args.format == "json":
        output = json.dumps(generate_json_output(result), indent=2)
    elif args.format == "dot":
        output = generate_dot_output(result)
    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"Output saved to: {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()