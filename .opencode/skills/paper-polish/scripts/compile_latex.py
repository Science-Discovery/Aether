#!/usr/bin/env python3
"""
LaTeX Compilation Helper for Paper Polish

Cross-platform (Windows/Linux/macOS) LaTeX compiler with:
- Smart file sync to .temp/ (avoids full clean on every run)
- Separate handling for main vs diff compilation
- BibTeX integration with 3-pass compilation
- Log analysis for missing figures, undefined refs/citations
- PDF output copied to project root

Usage:
    python compile_latex.py <tex_file> [--diff] [--engine ENGINE]

Examples:
    python compile_latex.py main.tex
    python compile_latex.py .temp/diff.tex --diff
    python compile_latex.py main.tex --engine pdflatex
"""

import os
import sys
import shutil
import subprocess
import argparse
import re
from pathlib import Path
from datetime import datetime


# Directories and files to never copy into .temp/
EXCLUDE_NAMES = {
    ".git",
    ".temp",
    ".backup",
    ".vscode",
    ".idea",
    ".ruff_cache",
    "skills",
    "AGENTS.md",
    "main.pdf",
    "diff.pdf",
}


def is_excluded(name: str) -> bool:
    """Check if a file/directory should be excluded from .temp copy."""
    return name in EXCLUDE_NAMES or name.startswith(".")


def find_engine(preferred: str = "xelatex") -> str:
    """Find a working LaTeX engine, prefer the given one."""
    for engine in [preferred, "xelatex", "pdflatex", "lualatex"]:
        if shutil.which(engine):
            return engine
    print("ERROR: No LaTeX engine found. Install TeX Live or MiKTeX.")
    sys.exit(1)


class LaTeXCompiler:
    """Handles LaTeX compilation with file copying and error checking."""

    def __init__(
        self,
        tex_file: str,
        temp_dir: str = ".temp",
        project_dir: str = None,
        is_diff: bool = False,
        engine: str = "xelatex",
    ):
        self.tex_file = Path(tex_file).name  # just the filename
        self.temp_dir = Path(temp_dir)
        self.is_diff = is_diff
        self.project_dir = Path(project_dir) if project_dir else Path.cwd()
        self.base_name = Path(tex_file).stem
        self.engine = find_engine(engine)

    @property
    def temp_path(self) -> Path:
        return self.project_dir / self.temp_dir

    def sync_project_files(self):
        """Sync project files to .temp/ (incremental, skip unchanged)."""
        print("=" * 60)
        print("Syncing project files to .temp/")
        print("=" * 60)

        self.temp_path.mkdir(exist_ok=True)

        files_synced = 0
        dirs_synced = 0

        for item in self.project_dir.iterdir():
            if is_excluded(item.name):
                continue

            dest = self.temp_path / item.name
            try:
                if item.is_file():
                    # Only copy if source is newer or dest doesn't exist
                    if not dest.exists() or item.stat().st_mtime > dest.stat().st_mtime:
                        shutil.copy2(item, dest)
                        files_synced += 1
                elif item.is_dir():
                    shutil.copytree(item, dest, dirs_exist_ok=True)
                    dirs_synced += 1
            except Exception as e:
                print(f"  Warning: Could not copy {item.name}: {e}")

        print(
            f"  Synced {files_synced} file(s), {dirs_synced} dir(s) to {self.temp_path}"
        )

        # For diff compilation, the diff.tex should already be in .temp/
        tex_in_temp = self.temp_path / self.tex_file
        if not tex_in_temp.exists():
            # Try copying from project root
            src = self.project_dir / self.tex_file
            if src.exists():
                shutil.copy2(src, tex_in_temp)
            else:
                raise FileNotFoundError(
                    f"Cannot find {self.tex_file} in {self.temp_path} or {self.project_dir}"
                )

    def run_command(self, command: list, cwd=None) -> tuple:
        """Run a command and return (success, stdout, stderr)."""
        try:
            result = subprocess.run(
                command,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=180,
            )
            return result.returncode == 0, result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            return False, "", "Command timed out after 180 seconds"
        except FileNotFoundError as e:
            return False, "", f"Command not found: {e}"
        except Exception as e:
            return False, "", str(e)

    def check_log_for_issues(self, log_file: Path) -> dict:
        """Analyze LaTeX log file for issues."""
        issues = {
            "missing_figures": [],
            "undefined_refs": [],
            "undefined_citations": [],
            "errors": [],
        }

        if not log_file.exists():
            return issues

        try:
            log_content = log_file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            return issues

        # Missing figures
        for m in re.finditer(
            r"File [`']?(.+?)[`']?\s+not found", log_content, re.IGNORECASE
        ):
            issues["missing_figures"].append(m.group(1))

        # Undefined references
        for m in re.finditer(
            r"Reference\s+[`'](.+?)[`']\s+.*undefined", log_content, re.IGNORECASE
        ):
            issues["undefined_refs"].append(m.group(1))

        # Undefined citations
        for m in re.finditer(
            r"Citation\s+[`'](.+?)[`']\s+.*undefined", log_content, re.IGNORECASE
        ):
            issues["undefined_citations"].append(m.group(1))

        # LaTeX errors (first 10)
        issues["errors"] = re.findall(r"^! .+", log_content, re.MULTILINE)[:10]

        return issues

    def _report_issues(self, issues: dict, phase: str = ""):
        """Print issue report."""
        if issues["missing_figures"]:
            unique = sorted(set(issues["missing_figures"]))
            print(
                f"  WARNING: {len(unique)} missing figure(s): {', '.join(unique[:5])}"
            )
        if issues["undefined_refs"]:
            unique = sorted(set(issues["undefined_refs"]))
            print(f"  WARNING: {len(unique)} undefined ref(s): {', '.join(unique[:5])}")
        if issues["undefined_citations"]:
            unique = sorted(set(issues["undefined_citations"]))
            print(
                f"  WARNING: {len(unique)} undefined citation(s): {', '.join(unique[:5])}"
            )
        if issues["errors"]:
            print(f"  WARNING: {len(issues['errors'])} LaTeX error(s)")
            for err in issues["errors"][:3]:
                print(f"    {err}")

    def compile(self) -> bool:
        """Compile the LaTeX file with BibTeX (3-pass)."""
        self.sync_project_files()

        cwd = self.temp_path
        log_file = cwd / f"{self.base_name}.log"

        print(f"\nCompiling {self.tex_file} with {self.engine}")
        print("=" * 60)

        latex_cmd = [self.engine, "-interaction=nonstopmode", self.tex_file]

        # Pass 1
        print("\n>>> Pass 1/3")
        success, _, stderr = self.run_command(latex_cmd, cwd=cwd)
        if not success:
            print("  Note: First pass warnings are often normal")

        # BibTeX
        print("\n>>> BibTeX")
        aux_file = cwd / f"{self.base_name}.aux"
        if aux_file.exists():
            success, stdout, stderr = self.run_command(
                ["bibtex", self.base_name], cwd=cwd
            )
            if not success:
                print(f"  BibTeX warnings (usually non-critical)")
        else:
            print("  No .aux file, skipping BibTeX")

        # Pass 2
        print("\n>>> Pass 2/3")
        self.run_command(latex_cmd, cwd=cwd)

        # Check after pass 2
        issues = self.check_log_for_issues(log_file)
        self._report_issues(issues, "after pass 2")

        # Pass 3
        print("\n>>> Pass 3/3 (final)")
        self.run_command(latex_cmd, cwd=cwd)

        # Final verification
        print(f"\n{'=' * 60}")
        print("Final Verification")
        print(f"{'=' * 60}")

        issues = self.check_log_for_issues(log_file)
        pdf_file = cwd / f"{self.base_name}.pdf"

        if not pdf_file.exists():
            print(f"  FAILED: PDF was not generated")
            self._report_issues(issues)
            print(f"\n  Check log: {log_file}")
            return False

        # Copy PDF to project root
        dest_pdf = self.project_dir / f"{self.base_name}.pdf"
        shutil.copy2(pdf_file, dest_pdf)
        print(f"  OK: {dest_pdf}")

        self._report_issues(issues)
        if any(issues[k] for k in issues):
            print(f"\n  See log for details: {log_file}")

        return True


def create_backup(tex_file: str, backup_dir: str = ".backup") -> Path:
    """Create a timestamped backup of the tex file."""
    tex_path = Path(tex_file)
    if not tex_path.exists():
        raise FileNotFoundError(f"File not found: {tex_file}")

    backup_path = Path(backup_dir)
    backup_path.mkdir(exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"{tex_path.stem}_{timestamp}{tex_path.suffix}"
    backup_file = backup_path / backup_name

    shutil.copy2(tex_path, backup_file)
    print(f"  Backup created: {backup_file}")
    return backup_file


def main():
    parser = argparse.ArgumentParser(
        description="Compile LaTeX documents with auto file sync and error checking"
    )
    parser.add_argument(
        "tex_file", help="LaTeX file to compile (e.g. main.tex or .temp/diff.tex)"
    )
    parser.add_argument("--diff", action="store_true", help="Mark as diff compilation")
    parser.add_argument(
        "--engine", default="xelatex", help="LaTeX engine (default: xelatex)"
    )
    parser.add_argument(
        "--temp-dir", default=".temp", help="Temp directory (default: .temp)"
    )
    parser.add_argument(
        "--backup", action="store_true", help="Create backup before compiling"
    )
    parser.add_argument(
        "--backup-dir", default=".backup", help="Backup directory (default: .backup)"
    )

    args = parser.parse_args()

    if args.backup:
        try:
            create_backup(args.tex_file, args.backup_dir)
        except Exception as e:
            print(f"  Warning: Could not create backup: {e}")

    compiler = LaTeXCompiler(
        tex_file=args.tex_file,
        temp_dir=args.temp_dir,
        is_diff=args.diff,
        engine=args.engine,
    )

    success = compiler.compile()

    print(f"\n{'=' * 60}")
    print("Compilation " + ("succeeded" if success else "FAILED"))
    print(f"{'=' * 60}")
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
