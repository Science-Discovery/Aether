#!/usr/bin/env python3
"""Skill Market CLI — search, browse, download, and install skills from skill.aiphys.cn, with ClawHub fallback."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

import ssl
import urllib.request
import urllib.error
import urllib.parse

BASE_URL = "https://skill.aiphys.cn/v1"
DEFAULT_INSTALL_DIR = os.path.join(os.path.expanduser("~"), ".aether", "skills")

try:
    import certifi

    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()


def _api_get(path, params=None):
    url = f"{BASE_URL}{path}"
    if params:
        query = urllib.parse.urlencode(
            {k: v for k, v in params.items() if v is not None}
        )
        if query:
            url += f"?{query}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, context=_SSL_CTX) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        err = json.loads(body) if body else {}
        print(f"Error {e.code}: {err.get('error', {}).get('message', body)}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network error: {e.reason}")
        sys.exit(1)


def _download_file(url, dest_path):
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, context=_SSL_CTX) as resp:
            with open(dest_path, "wb") as f:
                f.write(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        err = json.loads(body) if body else {}
        print(f"Download error {e.code}: {err.get('error', {}).get('message', body)}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network error: {e.reason}")
        sys.exit(1)


def cmd_search(args):
    params = {
        "q": args.keyword,
        "tags": args.tags,
        "category": args.category,
        "sort": args.sort,
        "featured": "true" if args.featured else None,
        "page": args.page,
        "page_size": args.page_size,
    }
    result = _api_get("/skills", params)
    data = result.get("data", {})
    items = data.get("items", [])
    total = data.get("total", 0)

    print(f"Found {total} skills (showing {len(items)}):\n")
    for item in items:
        name = item.get("name", "")
        slug = item.get("slug", "")
        sid = item.get("id", "")
        status = item.get("status", "")
        desc = item.get("description", "")[:120]
        tags = item.get("tags", [])
        cat = item.get("category", "")
        downloads = item.get("download_count", 0)

        tag_str = f" [{','.join(tags)}]" if tags else ""
        cat_str = f" ({cat})" if cat else ""
        print(
            f"  {name} | slug: {slug} | id: {sid} | {status} | downloads: {downloads}{cat_str}{tag_str}"
        )
        print(f"    {desc}...")
        print()


def cmd_info(args):
    result = _api_get(f"/skills/{args.skill_id}")
    data = result.get("data", {})
    if not data:
        print("Skill not found.")
        return

    print(f"Name:        {data.get('name', '')}")
    print(f"Slug:        {data.get('slug', '')}")
    print(f"ID:          {data.get('id', '')}")
    print(f"Status:      {data.get('status', '')}")
    print(f"Category:    {data.get('category', 'N/A')}")
    print(f"Tags:        {', '.join(data.get('tags', [])) or 'N/A'}")
    print(f"Downloads:   {data.get('download_count', 0)}")
    print(
        f"Owner:       {data.get('owner_name', 'N/A')} ({data.get('owner_email', 'N/A')})"
    )
    print(f"Created:     {data.get('created_at', 'N/A')}")
    print(f"Updated:     {data.get('updated_at', 'N/A')}")
    print(f"\nDescription:\n{data.get('description', '')}")


def cmd_versions(args):
    result = _api_get(f"/skills/{args.skill_id}/versions")
    versions = result.get("data", [])
    if not versions:
        print("No versions available (skill may be draft or no version uploaded).")
        return

    print(f"Versions for {args.skill_id}:\n")
    for v in versions:
        print(f"  version:      {v.get('version', '')}")
        print(f"  id:           {v.get('id', '')}")
        print(f"  size:         {v.get('file_size', 0)} bytes")
        print(f"  checksum:     {v.get('checksum', '')}")
        print(f"  changelog:    {v.get('changelog', 'N/A')}")
        print(f"  created_at:   {v.get('created_at', '')}")
        print()


def cmd_install(args):
    # Get skill info first to determine slug and available versions
    info_result = _api_get(f"/skills/{args.skill_id}")
    info_data = info_result.get("data", {})
    if not info_data:
        print("Skill not found.")
        return

    slug = info_data.get("slug", args.skill_id)
    name = info_data.get("name", slug)
    status = info_data.get("status", "")

    # Get versions
    ver_result = _api_get(f"/skills/{args.skill_id}/versions")
    versions = ver_result.get("data", [])

    if not versions:
        print(f"Skill '{name}' has no versions available for download.")
        if status == "draft":
            print("  Note: draft skills require admin session to download.")
        return

    # Select version
    version = args.version
    if not version:
        version = versions[0].get("version")
        print(f"Using latest version: {version}")

    # Find version object
    ver_obj = None
    for v in versions:
        if v.get("version") == version:
            ver_obj = v
            break

    if not ver_obj:
        print(
            f"Version {version} not found. Available: {', '.join(v.get('version', '') for v in versions)}"
        )
        return

    # Determine install directory
    install_dir = args.dir or DEFAULT_INSTALL_DIR
    target_dir = os.path.join(install_dir, slug)

    # Check if already installed
    if os.path.isdir(target_dir) and os.path.isfile(
        os.path.join(target_dir, "SKILL.md")
    ):
        print(f"Skill '{name}' already installed at {target_dir}")
        if not args.force:
            print("Use --force to overwrite.")
            return
        print("Overwriting existing installation...")

    # Download
    download_url = f"{BASE_URL}/skills/{args.skill_id}/versions/{version}/download"
    tmp_zip = os.path.join(tempfile.gettempdir(), f"{slug}-{version}.zip")

    print(f"Downloading '{name}' v{version}...")
    _download_file(download_url, tmp_zip)
    print(f"  Downloaded {os.path.getsize(tmp_zip)} bytes")

    # Extract
    os.makedirs(target_dir, exist_ok=True)
    with zipfile.ZipFile(tmp_zip, "r") as zf:
        # Check if zip has a top-level directory
        names = zf.namelist()
        top_dirs = set()
        for n in names:
            parts = n.split("/")
            if len(parts) > 1:
                top_dirs.add(parts[0])
            elif len(parts) == 1 and not n.endswith("/"):
                top_dirs.add("")

        if len(top_dirs) == 1 and "" not in top_dirs:
            # Zip has a single top-level directory — strip it
            top = list(top_dirs)[0]
            for n in names:
                if n.startswith(top + "/"):
                    relative = n[len(top) + 1 :]
                    if not relative:
                        continue
                    dest = os.path.join(target_dir, relative)
                    if n.endswith("/"):
                        os.makedirs(dest, exist_ok=True)
                    else:
                        os.makedirs(os.path.dirname(dest), exist_ok=True)
                        with zf.open(n) as src, open(dest, "wb") as dst:
                            dst.write(src.read())
        else:
            # Extract directly
            zf.extractall(target_dir)

    # Cleanup temp zip
    os.unlink(tmp_zip)

    # Verify
    skill_md = os.path.join(target_dir, "SKILL.md")
    if os.path.isfile(skill_md):
        print(f"\nSuccessfully installed '{name}' v{version} to:")
        print(f"  {target_dir}")
        print(f"\nTo use this skill, add it to your Aether config:")
        print(f'  skills.paths: ["{target_dir}"]')
    else:
        print(f"\nWarning: No SKILL.md found after extraction.")
        print(f"  Extracted to: {target_dir}")
        print(f"  Contents: {os.listdir(target_dir)}")


def cmd_list(args):
    install_dir = args.dir or DEFAULT_INSTALL_DIR
    if not os.path.isdir(install_dir):
        print(f"No skills directory found at {install_dir}")
        return

    skills = []
    for entry in sorted(os.listdir(install_dir)):
        skill_path = os.path.join(install_dir, entry)
        skill_md = os.path.join(skill_path, "SKILL.md")
        if os.path.isdir(skill_path) and os.path.isfile(skill_md):
            skills.append(entry)

    if not skills:
        print(f"No skills installed in {install_dir}")
        return

    print(f"Installed skills ({len(skills)}):\n")
    for s in skills:
        print(f"  {s}  →  {os.path.join(install_dir, s)}")


def _check_clawhub():
    if not shutil.which("clawhub"):
        print("ClawHub CLI not found. Install with: npm i -g clawhub")
        sys.exit(1)


def _run_clawhub(cmd_args):
    _check_clawhub()
    result = subprocess.run(["clawhub"] + cmd_args, capture_output=False)
    sys.exit(result.returncode)


def cmd_clawhub_search(args):
    cmd = ["search", args.keyword]
    if args.registry:
        cmd.extend(["--registry", args.registry])
    _run_clawhub(cmd)


def cmd_clawhub_install(args):
    cmd = ["install", args.slug]
    if args.version:
        cmd.extend(["--version", args.version])
    if args.registry:
        cmd.extend(["--registry", args.registry])
    if args.workdir:
        cmd.extend(["--workdir", args.workdir])
    _run_clawhub(cmd)


def cmd_clawhub_update(args):
    cmd = ["update"]
    if args.slug:
        cmd.append(args.slug)
    elif args.all:
        cmd.append("--all")
    else:
        print("Specify a slug or --all")
        sys.exit(1)
    if args.version:
        cmd.extend(["--version", args.version])
    if args.force:
        cmd.append("--force")
    if args.no_input:
        cmd.append("--no-input")
    _run_clawhub(cmd)


def cmd_clawhub_publish(args):
    cmd = [
        "publish",
        args.path,
        "--slug",
        args.slug,
        "--name",
        args.name,
        "--version",
        args.version,
    ]
    if args.changelog:
        cmd.extend(["--changelog", args.changelog])
    if args.registry:
        cmd.extend(["--registry", args.registry])
    if args.workdir:
        cmd.extend(["--workdir", args.workdir])
    _run_clawhub(cmd)


def cmd_clawhub_list(args):
    _run_clawhub(["list"])


def cmd_clawhub_login(args):
    _run_clawhub(["login"])


def cmd_clawhub_whoami(args):
    _run_clawhub(["whoami"])


def main():
    parser = argparse.ArgumentParser(
        prog="skill_market",
        description="Search, download, and install skills from skill.aiphys.cn",
    )
    sub = parser.add_subparsers(dest="command", help="Available commands")

    # search
    p_search = sub.add_parser(
        "search", help="Search skills by keyword, tags, or category"
    )
    p_search.add_argument("keyword", nargs="?", default=None, help="Search keyword")
    p_search.add_argument(
        "--tags", default=None, help="Filter by tags (comma-separated)"
    )
    p_search.add_argument("--category", default=None, help="Filter by category")
    p_search.add_argument(
        "--sort",
        default="latest",
        choices=["latest", "downloads", "featured"],
        help="Sort order (default: latest)",
    )
    p_search.add_argument(
        "--featured", action="store_true", help="Only show featured skills"
    )
    p_search.add_argument("--page", type=int, default=1, help="Page number")
    p_search.add_argument(
        "--page-size", type=int, default=20, dest="page_size", help="Results per page"
    )

    # info
    p_info = sub.add_parser("info", help="Get skill details")
    p_info.add_argument("skill_id", help="Skill ID (UUID)")

    # versions
    p_ver = sub.add_parser("versions", help="List skill versions")
    p_ver.add_argument("skill_id", help="Skill ID (UUID)")

    # install
    p_install = sub.add_parser("install", help="Download and install a skill")
    p_install.add_argument("skill_id", help="Skill ID (UUID)")
    p_install.add_argument(
        "--version", default=None, help="Version to install (default: latest)"
    )
    p_install.add_argument(
        "--dir", default=None, help="Install directory (default: ~/.aether/skills)"
    )
    p_install.add_argument(
        "--force", action="store_true", help="Overwrite existing installation"
    )

    # list
    p_list = sub.add_parser("list", help="List installed skills")
    p_list.add_argument(
        "--dir", default=None, help="Skills directory (default: ~/.aether/skills)"
    )

    # --- ClawHub commands (fallback) ---
    p_ch = sub.add_parser(
        "clawhub-search", help="[ClawHub] Search skills on clawhub.com"
    )
    p_ch.add_argument("keyword", help="Search keyword")
    p_ch.add_argument("--registry", default=None, help="Custom registry URL")
    p_ch.set_defaults(func=cmd_clawhub_search)

    p_ch = sub.add_parser(
        "clawhub-install", help="[ClawHub] Install a skill from clawhub.com"
    )
    p_ch.add_argument("slug", help="Skill slug")
    p_ch.add_argument("--version", default=None, help="Version to install")
    p_ch.add_argument("--registry", default=None, help="Custom registry URL")
    p_ch.add_argument("--workdir", default=None, help="Working directory")
    p_ch.set_defaults(func=cmd_clawhub_install)

    p_ch = sub.add_parser("clawhub-update", help="[ClawHub] Update an installed skill")
    p_ch.add_argument("slug", nargs="?", default=None, help="Skill slug")
    p_ch.add_argument("--all", action="store_true", help="Update all skills")
    p_ch.add_argument("--version", default=None, help="Target version")
    p_ch.add_argument("--force", action="store_true", help="Force update")
    p_ch.add_argument("--no-input", action="store_true", help="No prompts")
    p_ch.set_defaults(func=cmd_clawhub_update)

    p_ch = sub.add_parser(
        "clawhub-publish", help="[ClawHub] Publish a skill to clawhub.com"
    )
    p_ch.add_argument("path", help="Skill directory path")
    p_ch.add_argument("--slug", required=True, help="Skill slug")
    p_ch.add_argument("--name", required=True, help="Skill name")
    p_ch.add_argument("--version", required=True, help="Version (semver)")
    p_ch.add_argument("--changelog", default=None, help="Changelog message")
    p_ch.add_argument("--registry", default=None, help="Custom registry URL")
    p_ch.add_argument("--workdir", default=None, help="Working directory")
    p_ch.set_defaults(func=cmd_clawhub_publish)

    p_ch = sub.add_parser(
        "clawhub-list", help="[ClawHub] List locally installed skills"
    )
    p_ch.set_defaults(func=cmd_clawhub_list)

    p_ch = sub.add_parser("clawhub-login", help="[ClawHub] Login to clawhub.com")
    p_ch.set_defaults(func=cmd_clawhub_login)

    p_ch = sub.add_parser(
        "clawhub-whoami", help="[ClawHub] Show current ClawHub identity"
    )
    p_ch.set_defaults(func=cmd_clawhub_whoami)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    cmds = {
        "search": cmd_search,
        "info": cmd_info,
        "versions": cmd_versions,
        "install": cmd_install,
        "list": cmd_list,
    }
    if hasattr(args, "func"):
        args.func(args)
    elif args.command in cmds:
        cmds[args.command](args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
