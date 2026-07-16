#!/usr/bin/env python3
"""Skill Market Publisher — upload, update, and manage skills on skill.aiphys.cn."""

import argparse
import getpass
import json
import os
import re
import sys
import tempfile
import zipfile

import ssl
import urllib.request
import urllib.error

BASE_URL = "https://skill.aiphys.cn/v1"

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()

_session_cookie = None


def _get_credentials():
    email = os.environ.get("SKILL_MARKET_EMAIL")
    password = os.environ.get("SKILL_MARKET_PASSWORD")
    if not email:
        email = input("Skill Market email: ").strip()
    if not password:
        password = getpass.getpass("Skill Market password: ")
    return email, password


def _login():
    global _session_cookie
    if _session_cookie:
        return
    email, password = _get_credentials()
    data = json.dumps({"email": email, "password": password}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/auth/login",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=_SSL_CTX) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            _session_cookie = resp.headers.get("Set-Cookie", "")
            # Extract just the cookie value
            for part in _session_cookie.split(";"):
                if "sm_session=" in part:
                    _session_cookie = part.strip()
                    break
            print(f"Login successful!")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"Login failed ({e.code}): {body}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network error: {e.reason}")
        sys.exit(1)


def _api_request(method, path, data=None, files=None):
    _login()
    url = f"{BASE_URL}{path}"
    headers = {"Cookie": _session_cookie}

    if files:
        # Multipart form data
        boundary = "----publish-boundary"
        body = b""
        for key, (filename, filedata, content_type) in files.items():
            body += f"--{boundary}\r\n".encode()
            body += f'Content-Disposition: form-data; name="{key}"; filename="{filename}"\r\n'.encode()
            body += f"Content-Type: {content_type}\r\n\r\n".encode()
            body += filedata + b"\r\n"
        for key, value in (data or {}).items():
            body += f"--{boundary}\r\n".encode()
            body += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
            body += f"{value}\r\n".encode()
        body += f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
    elif data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
    else:
        req = urllib.request.Request(url, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, context=_SSL_CTX) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            err = json.loads(raw)
            msg = err.get("error", {}).get("message", raw)
        except json.JSONDecodeError:
            msg = raw
        print(f"Error {e.code}: {msg}")
        return None
    except urllib.error.URLError as e:
        print(f"Network error: {e.reason}")
        return None


def _parse_frontmatter(skill_md_path):
    with open(skill_md_path, "r", encoding="utf-8") as f:
        content = f.read()

    fm_match = re.search(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL | re.MULTILINE)
    if not fm_match:
        return None, None, "1.0.0", content

    fm_text = fm_match.group(1)
    name = None
    description = ""
    version = "1.0.0"

    name_match = re.search(r"^name:\s*(.+?)\s*$", fm_text, re.MULTILINE)
    if name_match:
        name = name_match.group(1).strip().strip("\"'")

    desc_match = re.search(r"^description:\s*(.+?)(?=\n[a-zA-Z]|\Z)", fm_text, re.MULTILINE | re.DOTALL)
    if desc_match:
        val = desc_match.group(1).strip()
        if val.startswith('"') and val.endswith('"'):
            val = val[1:-1]
        elif val.startswith("'") and val.endswith("'"):
            val = val[1:-1]
        description = val.strip()

    ver_match = re.search(r"version:\s*[\"']?(\d+\.\d+\.\d+[^\"'\n]*)[\"']?", fm_text)
    if ver_match:
        version = ver_match.group(1).strip()

    return name, description, version, content


def _make_slug(name):
    return name.lower().replace(" ", "-").replace("_", "-")


def _make_zip(skill_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(skill_dir):
            dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]
            for file in files:
                if file.startswith("."):
                    continue
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, skill_dir)
                zf.write(file_path, arcname)


def _find_existing_skill(slug):
    result = _api_request("GET", "/skills", data=None)
    if not result:
        return None
    items = result.get("data", {}).get("items", [])
    for item in items:
        if item.get("slug") == slug:
            return item
    return None


def cmd_publish(args):
    skill_dir = os.path.abspath(args.skill_dir)
    skill_md = os.path.join(skill_dir, "SKILL.md")

    if not os.path.isfile(skill_md):
        print(f"Error: No SKILL.md found in {skill_dir}")
        sys.exit(1)

    name, description, version, _ = _parse_frontmatter(skill_md)
    if not name:
        print(f"Error: No 'name' field in frontmatter of {skill_md}")
        sys.exit(1)

    if len(description) > 500:
        description = description[:497] + "..."

    slug = _make_slug(name)

    print(f"=== Publishing: {name} (slug: {slug}, v{version}) ===")

    # Check for existing skill with same slug
    existing = _find_existing_skill(slug)
    if existing:
        skill_id = existing["id"]
        existing_name = existing.get("name", "")
        print(f"  Found existing skill: {existing_name} (id={skill_id})")
        print(f"  Will upload new version {version} only.")
    else:
        # Create new skill draft
        create_data = {"name": name, "slug": slug, "description": description}
        result = _api_request("POST", "/skills", data=create_data)
        if not result:
            print("  FAILED: Could not create skill")
            return False

        skill_id = result.get("data", {}).get("id")
        if not skill_id:
            print(f"  FAILED: No skill_id in response: {result}")
            return False
        print(f"  Created skill draft (id={skill_id})")

    # Prepare zip
    zip_path = os.path.join(tempfile.gettempdir(), f"{slug}-{version}.zip")
    if args.zip and os.path.isfile(args.zip):
        zip_path = args.zip
        print(f"  Using existing zip: {zip_path}")
    else:
        print(f"  Creating zip from {skill_dir}...")
        _make_zip(skill_dir, zip_path)
    print(f"  Zip size: {os.path.getsize(zip_path)} bytes")

    # Upload version
    with open(zip_path, "rb") as f:
        file_data = f.read()

    result = _api_request(
        "POST",
        f"/skills/{skill_id}/versions",
        data={"version": version},
        files={"file": (f"{slug}.zip", file_data, "application/zip")},
    )

    # Cleanup temp zip
    if not args.zip:
        os.unlink(zip_path)

    if not result:
        print("  FAILED: Version upload failed")
        return False

    ver_data = result.get("data", {})
    print(f"  SUCCESS: v{ver_data.get('version', version)} uploaded")
    print(f"  Skill ID: {skill_id}")
    return True


def cmd_publish_all(args):
    skills_dir = os.path.abspath(args.skills_dir)
    if not os.path.isdir(skills_dir):
        print(f"Error: {skills_dir} is not a directory")
        sys.exit(1)

    skill_dirs = sorted([
        d for d in os.listdir(skills_dir)
        if os.path.isdir(os.path.join(skills_dir, d))
        and not d.startswith(".")
        and os.path.isfile(os.path.join(skills_dir, d, "SKILL.md"))
    ])

    print(f"Found {len(skill_dirs)} skills to publish\n")

    success = []
    failed = []

    for skill_name in skill_dirs:
        skill_dir = os.path.join(skills_dir, skill_name)
        ok = cmd_publish(argparse.Namespace(skill_dir=skill_dir, zip=None))
        if ok:
            success.append(skill_name)
        else:
            failed.append(skill_name)
        print()

    print("=== SUMMARY ===")
    print(f"Successful: {len(success)}")
    print(f"Failed: {len(failed)}")
    if success:
        print("\nOK:")
        for s in success:
            print(f"  {s}")
    if failed:
        print("\nFAILED:")
        for s in failed:
            print(f"  {s}")


def cmd_list_mine(args):
    result = _api_request("GET", "/skills", data=None)
    if not result:
        return

    items = result.get("data", {}).get("items", [])
    if not items:
        print("No skills found.")
        return

    print(f"{'Name':<30} {'Slug':<30} {'ID':<40} {'Status':<10} {'Versions':<10}")
    print("-" * 120)
    for item in items:
        name = item.get("name", "")
        slug = item.get("slug", "")
        sid = item.get("id", "")
        status = item.get("status", "")
        has_ver = "Yes" if item.get("current_version_id") else "No"
        print(f"{name:<30} {slug:<30} {sid:<40} {status:<10} {has_ver:<10}")


def cmd_new_version(args):
    skill_id = args.skill_id
    version = args.version

    # Verify version is semver
    if not re.match(r"^\d+\.\d+\.\d+", version):
        print(f"Error: Version '{version}' is not valid semver (e.g., 1.0.0)")
        sys.exit(1)

    # Check zip file
    zip_path = os.path.abspath(args.file)
    if not os.path.isfile(zip_path):
        print(f"Error: {zip_path} not found")
        sys.exit(1)

    print(f"=== Uploading new version {version} for skill {skill_id} ===")
    print(f"  Zip: {zip_path} ({os.path.getsize(zip_path)} bytes)")

    with open(zip_path, "rb") as f:
        file_data = f.read()

    result = _api_request(
        "POST",
        f"/skills/{skill_id}/versions",
        data={"version": version},
        files={"file": (os.path.basename(zip_path), file_data, "application/zip")},
    )

    if not result:
        print("  FAILED")
        return

    ver_data = result.get("data", {})
    print(f"  SUCCESS: v{ver_data.get('version', version)} uploaded")
    print(f"  Version ID: {ver_data.get('id', 'N/A')}")


def main():
    parser = argparse.ArgumentParser(
        prog="publish",
        description="Publish skills to skill.aiphys.cn (Skill Market)",
    )
    sub = parser.add_subparsers(dest="command", help="Available commands")

    # publish
    p_pub = sub.add_parser("publish", help="Publish a single skill")
    p_pub.add_argument("skill_dir", help="Path to skill directory (containing SKILL.md)")
    p_pub.add_argument("--zip", default=None, help="Use existing zip file instead of auto-creating")
    p_pub.set_defaults(func=cmd_publish)

    # publish-all
    p_all = sub.add_parser("publish-all", help="Batch publish all skills in a directory")
    p_all.add_argument("skills_dir", help="Directory containing skill subdirectories")
    p_all.set_defaults(func=cmd_publish_all)

    # list-mine
    p_list = sub.add_parser("list-mine", help="List all skills on the platform")
    p_list.set_defaults(func=cmd_list_mine)

    # new-version
    p_ver = sub.add_parser("new-version", help="Upload a new version for an existing skill")
    p_ver.add_argument("skill_id", help="Skill ID (UUID)")
    p_ver.add_argument("--file", required=True, help="Zip file to upload")
    p_ver.add_argument("--version", required=True, help="Version (semver, e.g., 2.0.0)")
    p_ver.set_defaults(func=cmd_new_version)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()