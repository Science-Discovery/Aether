#!/usr/bin/env python3
"""
Setup and run latexdiff with automatic dependency handling.

Cross-platform (Windows/Linux/macOS) script that:
1. Checks for latexdiff and Perl availability
2. On Windows (MiKTeX): installs Algorithm::Diff if missing via cpan or manual copy
3. Runs latexdiff to generate diff.tex in .temp/

Usage:
    python setup_latexdiff.py <old_tex> <new_tex> [--output .temp/diff.tex]
    python setup_latexdiff.py --check          # only check dependencies

Examples:
    python setup_latexdiff.py .backup/main_20250326_143022.tex main.tex
    python setup_latexdiff.py --check
"""

import os
import sys
import platform
import shutil
import subprocess
import argparse
import re
import tempfile
import urllib.request
import tarfile
from pathlib import Path


def run(cmd, **kwargs):
    """Run command, return (success, stdout, stderr)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, **kwargs)
        return r.returncode == 0, r.stdout.strip(), r.stderr.strip()
    except FileNotFoundError:
        return False, "", f"Command not found: {cmd[0]}"
    except Exception as e:
        return False, "", str(e)


def check_perl():
    ok, out, _ = run(["perl", "-v"])
    if ok:
        print(f"  Perl: OK")
        return True
    print("  Perl: NOT FOUND")
    if platform.system() == "Windows":
        print("    Install Strawberry Perl: https://strawberryperl.com")
        print(
            "    Or use MiKTeX's built-in Perl (usually at MiKTeX/miktex/bin/perl.exe)"
        )
    else:
        print("    Install: sudo apt install perl  (Debian/Ubuntu)")
        print("             brew install perl       (macOS)")
    return False


def check_latexdiff():
    # First check if binary exists on PATH
    if not shutil.which("latexdiff") and not shutil.which("latexdiff.exe"):
        print("  latexdiff: NOT FOUND")
        _print_latexdiff_install_help()
        return False
    # Binary exists; try running it (may fail due to missing Algorithm::Diff)
    ok, out, err = run(["latexdiff", "--version"])
    if ok:
        print(f"  latexdiff: OK")
        return True
    if "Algorithm" in err and "Diff" in err:
        # latexdiff is installed but Algorithm::Diff is missing
        print("  latexdiff: INSTALLED (but Algorithm::Diff missing, will fix below)")
        return True
    print("  latexdiff: INSTALLED but failing")
    _print_latexdiff_install_help()
    return False


def _print_latexdiff_install_help():
    if platform.system() == "Windows":
        print("    MiKTeX: miktex-console -> Packages -> search 'latexdiff' -> install")
        print("    Or: mpm --install latexdiff")
    else:
        print("    Install: sudo apt install latexdiff  (Debian/Ubuntu)")
        print("             brew install latexdiff       (macOS)")
        print("             tlmgr install latexdiff      (TeX Live)")


def check_algorithm_diff():
    """Check if Perl Algorithm::Diff module is available (for latexdiff)."""
    # Direct Perl test
    ok, _, _ = run(["perl", "-MAlgorithm::Diff", "-e", "1"])
    if ok:
        print("  Algorithm::Diff: OK")
        return True
    # Fallback: latexdiff itself may have Algorithm::Diff in its own @INC
    # (common on MiKTeX where system Perl differs from latexdiff's Perl)
    ok2, out2, err2 = run(["latexdiff", "--version"])
    if ok2 and "Algorithm::Diff" in (out2 + err2):
        print("  Algorithm::Diff: OK (via latexdiff)")
        return True
    print("  Algorithm::Diff: MISSING")
    return False


def install_algorithm_diff_cpan():
    """Try installing Algorithm::Diff via cpan (skip on Windows/Git-Perl)."""
    # On Windows with Git's Perl, cpan often hangs or fails
    if platform.system() == "Windows":
        ok, perl_path, _ = run(["where", "perl"])
        if ok and "git" in perl_path.lower():
            print("  Skipping cpan (Git-bundled Perl, cpan unreliable)")
            return False

    print("  Trying cpan install...")
    ok, _, _ = run(["cpan", "Algorithm::Diff"])
    if ok and check_algorithm_diff_silent():
        print("  Installed via cpan: OK")
        return True
    return False


def check_algorithm_diff_silent():
    ok, _, _ = run(["perl", "-MAlgorithm::Diff", "-e", "1"])
    if ok:
        return True
    # Fallback: check via latexdiff (version info may go to stderr)
    ok2, out2, err2 = run(["latexdiff", "--version"])
    return ok2 and "Algorithm::Diff" in (out2 + err2)


def _find_latexdiff_inc_dir():
    """Find the @INC directory used by latexdiff (often MiKTeX scripts dir)."""
    # Parse latexdiff's error message to discover its @INC
    ok, _, err = run(["latexdiff", "--version"])
    if not ok and "@INC" in err:
        m = re.search(r"@INC entries checked:\s*(.+?)\)", err)
        if m:
            raw = m.group(1).strip()
            # Smart split: paths start with / or X:/ pattern
            # Can't use simple split() because paths may contain spaces
            paths = re.split(r"\s+(?=[A-Za-z]:/|/)", raw)
            for p in paths:
                p = p.strip().rstrip("/")
                pp = Path(p)
                if pp.exists() and "latexdiff" in p.lower():
                    return pp
            # Fallback: any existing directory
            for p in paths:
                p = p.strip().rstrip("/")
                pp = Path(p)
                if pp.exists():
                    return pp
    return None


def install_algorithm_diff_manual():
    """Download Algorithm::Diff and install to a location latexdiff can find."""
    print("  Trying manual install from CPAN archive...")

    url = "https://cpan.metacpan.org/authors/id/R/RJ/RJBS/Algorithm-Diff-1.201.tar.gz"

    # Determine best install location
    install_dir = None

    # Strategy 1: Install into latexdiff's own @INC directory (most reliable on MiKTeX)
    ld_dir = _find_latexdiff_inc_dir()
    if ld_dir:
        try:
            test_file = ld_dir / "_write_test"
            test_file.write_text("test")
            test_file.unlink()
            install_dir = ld_dir
            print(f"    Target: {install_dir} (latexdiff @INC)")
        except (PermissionError, OSError):
            print(f"    {ld_dir} is not writable, trying alternatives...")

    # Strategy 2: Perl site lib
    if not install_dir:
        ok, out, _ = run(["perl", "-e", "print join(qq{\\n}, @INC)"])
        if ok:
            for d in out.splitlines():
                d = d.strip()
                dp = Path(d)
                if dp.exists():
                    try:
                        test_file = dp / "_write_test"
                        test_file.write_text("test")
                        test_file.unlink()
                        install_dir = dp
                        print(f"    Target: {install_dir} (Perl @INC)")
                        break
                    except (PermissionError, OSError):
                        continue

    # Strategy 3: Home directory with PERL5LIB
    if not install_dir:
        install_dir = Path.home() / "perl5" / "lib" / "perl5"
        print(f"    Target: {install_dir} (home dir, needs PERL5LIB)")

    algo_dir = install_dir / "Algorithm"
    algo_dir.mkdir(parents=True, exist_ok=True)

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / "Algorithm-Diff.tar.gz"
            print(f"    Downloading...")
            urllib.request.urlretrieve(url, archive)

            print(f"    Extracting...")
            with tarfile.open(archive, "r:gz") as tar:
                try:
                    tar.extractall(tmpdir, filter="data")
                except TypeError:
                    # Python < 3.12 doesn't support filter
                    tar.extractall(tmpdir)

            # Find Diff.pm
            diff_pm = None
            for f in Path(tmpdir).rglob("Diff.pm"):
                if "Algorithm" in str(f):
                    diff_pm = f
                    break

            if not diff_pm:
                print("    ERROR: Diff.pm not found in archive")
                return False

            dest = algo_dir / "Diff.pm"
            shutil.copy2(diff_pm, dest)
            print(f"    Installed: {dest}")

            # If installed to home dir, set PERL5LIB
            if str(Path.home()) in str(install_dir):
                perl5lib = os.environ.get("PERL5LIB", "")
                new_path = str(install_dir)
                if new_path not in perl5lib:
                    os.environ["PERL5LIB"] = (
                        f"{new_path}{os.pathsep}{perl5lib}" if perl5lib else new_path
                    )
                    print(f"    Set PERL5LIB={os.environ['PERL5LIB']}")

            # Verify
            if check_algorithm_diff_silent():
                print("  Manual install: OK")
                return True
            # Also try running latexdiff directly to check
            ok2, _, err2 = run(["latexdiff", "--version"])
            if ok2:
                print("  Manual install: OK (latexdiff verified)")
                return True

            print(
                "  Manual install: file copied, but module still not loadable by perl"
            )
            print(f"    (This is OK if latexdiff can find it in its own @INC)")
            # Check if we installed to latexdiff's @INC
            if ld_dir and str(ld_dir) in str(install_dir):
                return True
            return False

    except Exception as e:
        print(f"    ERROR: {e}")
        return False


def ensure_algorithm_diff():
    """Ensure Algorithm::Diff is available, installing if needed."""
    if check_algorithm_diff():
        return True

    print("\n  Attempting to install Algorithm::Diff...")

    # Try cpan first
    if shutil.which("cpan"):
        if install_algorithm_diff_cpan():
            return True

    # Fall back to manual install
    if install_algorithm_diff_manual():
        return True

    print("\n  FAILED to install Algorithm::Diff automatically.")
    print("  Manual fix options:")
    if platform.system() == "Windows":
        print("    1. cpan Algorithm::Diff  (from Strawberry Perl)")
        print("    2. ppm install Algorithm-Diff  (from ActivePerl)")
    else:
        print("    1. cpan Algorithm::Diff")
        print("    2. sudo apt install libalgorithm-diff-perl  (Debian/Ubuntu)")
    return False


def run_latexdiff(old_tex: str, new_tex: str, output: str) -> bool:
    """Run latexdiff to generate diff file."""
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = ["latexdiff", old_tex, new_tex]
    print(f"\n  Running: latexdiff {old_tex} {new_tex}")

    env = os.environ.copy()

    try:
        # Use binary mode to avoid encoding issues on Windows
        # (LaTeX files may contain non-ASCII characters)
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=120,
            env=env,
        )

        if result.returncode == 0 and result.stdout:
            # Write raw bytes; latexdiff output is typically UTF-8 or ASCII
            output_path.write_bytes(result.stdout)
            print(f"  OK: {output_path}")
            return True
        else:
            stderr_text = result.stderr.decode("utf-8", errors="replace")
            if "Algorithm::Diff" in stderr_text:
                print("  ERROR: Algorithm::Diff not found by latexdiff")
                print("  Run: python setup_latexdiff.py --check")
            else:
                print(f"  ERROR: latexdiff failed")
                if stderr_text:
                    for line in stderr_text.splitlines()[:5]:
                        print(f"    {line}")
            return False

    except Exception as e:
        print(f"  ERROR: {e}")
        return False


def check_all():
    """Check all dependencies and report status."""
    print("Checking paper-polish dependencies:")
    print("-" * 40)

    perl_ok = check_perl()
    latexdiff_ok = check_latexdiff() if perl_ok else False

    algo_ok = False
    if perl_ok:
        algo_ok = check_algorithm_diff()

    engine_ok = False
    for engine in ["xelatex", "pdflatex", "lualatex"]:
        if shutil.which(engine):
            print(f"  LaTeX engine: {engine} OK")
            engine_ok = True
            break
    if not engine_ok:
        print("  LaTeX engine: NOT FOUND")

    bibtex_ok = shutil.which("bibtex") is not None
    print(f"  BibTeX: {'OK' if bibtex_ok else 'NOT FOUND'}")

    print("-" * 40)
    all_ok = perl_ok and latexdiff_ok and algo_ok and engine_ok and bibtex_ok
    print(f"Status: {'ALL OK' if all_ok else 'ISSUES FOUND'}")

    if not algo_ok and perl_ok:
        print("\nTo fix Algorithm::Diff, re-run this script without --check")
        print("  or run: python setup_latexdiff.py --install-deps")

    return all_ok


def main():
    parser = argparse.ArgumentParser(
        description="Setup latexdiff dependencies and generate diff.tex"
    )
    parser.add_argument("old_tex", nargs="?", help="Old (backup) tex file")
    parser.add_argument("new_tex", nargs="?", help="New (current) tex file")
    parser.add_argument(
        "--output",
        default=".temp/diff.tex",
        help="Output diff file (default: .temp/diff.tex)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only check dependencies, don't run latexdiff",
    )
    parser.add_argument(
        "--install-deps",
        action="store_true",
        help="Install missing dependencies (Algorithm::Diff)",
    )

    args = parser.parse_args()

    if args.check:
        ok = check_all()
        sys.exit(0 if ok else 1)

    if args.install_deps:
        print("Installing dependencies...")
        check_perl()
        check_latexdiff()
        ensure_algorithm_diff()
        sys.exit(0)

    if not args.old_tex or not args.new_tex:
        parser.error(
            "old_tex and new_tex are required (or use --check / --install-deps)"
        )

    # Verify files exist
    if not Path(args.old_tex).exists():
        print(f"ERROR: {args.old_tex} not found")
        sys.exit(1)
    if not Path(args.new_tex).exists():
        print(f"ERROR: {args.new_tex} not found")
        sys.exit(1)

    # Ensure dependencies
    if not check_latexdiff():
        sys.exit(1)
    ensure_algorithm_diff()

    # Run latexdiff
    ok = run_latexdiff(args.old_tex, args.new_tex, args.output)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
