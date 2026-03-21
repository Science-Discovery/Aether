#!/usr/bin/env python3
"""
Skill Scanner - Discover and validate skills in a directory

Usage:
    python scan_skills.py <skills_directory> [options]

Options:
    --report FILE    Output Markdown report
    --json FILE      Output JSON data
    --validate       Check skill structure validity
    --verbose        Show detailed output
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:
    yaml = None


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


@dataclass
class ScanResult:
    directory: Path
    skills: list = field(default_factory=list)
    total_skills: int = 0
    valid_skills: int = 0
    invalid_skills: int = 0


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


def scan_skill(skill_path: Path, validate: bool = True) -> Optional[SkillInfo]:
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return None
    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError:
        return None
    frontmatter_text = _extract_frontmatter(content)
    name = skill_path.name
    description = ""
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
    scripts_dir = skill_path / "scripts"
    references_dir = skill_path / "references"
    assets_dir = skill_path / "assets"
    has_scripts = scripts_dir.is_dir()
    has_references = references_dir.is_dir()
    has_assets = assets_dir.is_dir()
    script_count = (
        len(list(scripts_dir.glob("*.py"))) + len(list(scripts_dir.glob("*.sh")))
        if has_scripts
        else 0
    )
    reference_count = len(list(references_dir.glob("*.md"))) if has_references else 0
    asset_count = (
        sum(1 for _ in assets_dir.rglob("*") if _.is_file()) if has_assets else 0
    )
    is_valid, validation_errors = validate_skill(skill_path) if validate else (True, [])
    return SkillInfo(
        name=name,
        path=skill_path,
        description=description,
        has_scripts=has_scripts,
        has_references=has_references,
        has_assets=has_assets,
        is_valid=is_valid,
        validation_errors=validation_errors,
        script_count=script_count,
        reference_count=reference_count,
        asset_count=asset_count,
    )


def scan_skills(
    directory: Path, validate: bool = True, verbose: bool = False
) -> ScanResult:
    result = ScanResult(directory=directory)
    for item in sorted(directory.iterdir()):
        if item.is_dir() and (item / "SKILL.md").exists():
            skill_info = scan_skill(item, validate=validate)
            if skill_info:
                result.skills.append(skill_info)
                result.total_skills += 1
                if skill_info.is_valid:
                    result.valid_skills += 1
                else:
                    result.invalid_skills += 1
                if verbose:
                    status = "✓" if skill_info.is_valid else "✗"
                    print(f"  {status} {skill_info.name}")
    return result


def generate_markdown_report(result: ScanResult) -> str:
    lines = [
        f"# Skills Inventory Report",
        f"",
        f"**Directory:** `{result.directory}`",
        f"",
        f"## Summary",
        f"",
        f"| Metric | Count |",
        f"|--------|-------|",
        f"| Total Skills | {result.total_skills} |",
        f"| Valid | {result.valid_skills} |",
        f"| Invalid | {result.invalid_skills} |",
        f"",
        f"## Skills List",
        f"",
    ]
    for skill in result.skills:
        status = "✅" if skill.is_valid else "❌"
        lines.append(f"### {status} {skill.name}")
        lines.append(f"")
        lines.append(f"**Path:** `{skill.path}`")
        lines.append(f"")
        lines.append(
            f"**Description:** {skill.description[:200]}{'...' if len(skill.description) > 200 else ''}"
        )
        lines.append(f"")
        resources = []
        if skill.has_scripts:
            resources.append(f"scripts/ ({skill.script_count} files)")
        if skill.has_references:
            resources.append(f"references/ ({skill.reference_count} files)")
        if skill.has_assets:
            resources.append(f"assets/ ({skill.asset_count} files)")
        if resources:
            lines.append(f"**Resources:** {', '.join(resources)}")
        else:
            lines.append(f"**Resources:** None")
        lines.append(f"")
        if skill.validation_errors:
            lines.append(f"**Errors:**")
            for err in skill.validation_errors:
                lines.append(f"- {err}")
            lines.append(f"")
    return "\n".join(lines)


def generate_json_output(result: ScanResult) -> dict:
    return {
        "directory": str(result.directory),
        "summary": {
            "total_skills": result.total_skills,
            "valid_skills": result.valid_skills,
            "invalid_skills": result.invalid_skills,
        },
        "skills": [
            {
                "name": s.name,
                "path": str(s.path),
                "description": s.description,
                "is_valid": s.is_valid,
                "validation_errors": s.validation_errors,
                "resources": {
                    "scripts": {"exists": s.has_scripts, "count": s.script_count},
                    "references": {
                        "exists": s.has_references,
                        "count": s.reference_count,
                    },
                    "assets": {"exists": s.has_assets, "count": s.asset_count},
                },
            }
            for s in result.skills
        ],
    }


def main():
    parser = argparse.ArgumentParser(
        description="Scan and validate skills in a directory"
    )
    parser.add_argument("directory", help="Directory containing skills")
    parser.add_argument("--report", help="Output Markdown report file")
    parser.add_argument("--json", help="Output JSON data file")
    parser.add_argument(
        "--validate", action="store_true", default=True, help="Validate skill structure"
    )
    parser.add_argument(
        "--no-validate", action="store_false", dest="validate", help="Skip validation"
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Show detailed output"
    )
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if not directory.is_dir():
        print(f"[ERROR] Directory not found: {directory}")
        sys.exit(1)
    print(f"Scanning: {directory}")
    print()
    result = scan_skills(directory, validate=args.validate, verbose=args.verbose)
    print()
    print(
        f"Found {result.total_skills} skills ({result.valid_skills} valid, {result.invalid_skills} invalid)"
    )
    if args.report:
        report_content = generate_markdown_report(result)
        Path(args.report).write_text(report_content, encoding="utf-8")
        print(f"Report saved to: {args.report}")
    if args.json:
        json_output = generate_json_output(result)
        Path(args.json).write_text(json.dumps(json_output, indent=2), encoding="utf-8")
        print(f"JSON saved to: {args.json}")


if __name__ == "__main__":
    main()
