---
name: skill-market-publisher
description: "Publish, update, and manage skills on skill.aiphys.cn (Skill Market / 技能广场). Upload a single skill, batch-upload all skills in a directory, upload new versions, or list existing skills. Trigger when the user asks to upload a skill to skill.aiphys.cn, publish a skill to skill market, batch upload skills, push a new skill version, or manage skills on the Skill Market platform, including phrases like '上传 skill', '发布 skill', '批量上传', 'publish to skill market', 'upload to skill.aiphys.cn', '上传新版本', '更新 skill 版本'. Requires Skill Market account credentials (email + password) provided via SKILL_MARKET_EMAIL and SKILL_MARKET_PASSWORD environment variables, or entered interactively."
---

# Skill Market Publisher

Upload, update, and manage skills on [skill.aiphys.cn](https://skill.aiphys.cn) (Skill Market).

## Authentication

Credentials are read from environment variables, falling back to interactive prompt:

```bash
export SKILL_MARKET_EMAIL="your@email.com"
export SKILL_MARKET_PASSWORD="yourpassword"
```

If not set, the script will prompt for email and password at runtime.

## Commands

```bash
python3 scripts/publish.py <command> [options]
```

### publish

Upload a single skill (auto-creates zip, checks for duplicates):

```bash
python3 scripts/publish.py publish ./my-skill
python3 scripts/publish.py publish ./my-skill --zip ./my-skill.zip
```

Workflow:
1. Parse SKILL.md frontmatter for name, description, version
2. Check if a skill with the same slug already exists on the platform
3. If exists: upload new version only (no duplicate creation)
4. If new: create skill draft (`POST /v1/skills`), then upload version
5. Auto-create zip from skill directory if `--zip` not provided

### publish-all

Batch publish all skills in a directory:

```bash
python3 scripts/publish.py publish-all ./skills网站
```

Processes every subdirectory containing a `SKILL.md`. Individual failures do not stop the batch; a summary is printed at the end.

### list-mine

List all skills on the platform:

```bash
python3 scripts/publish.py list-mine
```

### new-version

Upload a new version for an existing skill:

```bash
python3 scripts/publish.py new-version <skill_id> --file ./my-skill.zip --version 2.0.0
```

## SKILL.md Frontmatter Requirements

The script reads these fields from YAML frontmatter:

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Used as skill name and slug (kebab-case) |
| `description` | Yes | Truncated to 500 chars max |
| `metadata.version` | No | Semver format (e.g., `1.0.0`); defaults to `1.0.0` |

Example:
```yaml
---
name: my-skill
description: "Does useful things."
metadata:
  version: "1.2.0"
---
```

## API Details

- Base URL: `https://skill.aiphys.cn/v1`
- Login: `POST /v1/auth/login` → session cookie
- Create skill: `POST /v1/skills` → `{name, slug, description}`
- Upload version: `POST /v1/skills/{id}/versions` → multipart with `file` + `version` field
- List skills: `GET /v1/skills`
- Version must follow semver (e.g., `1.0.0`, `2.1.0-beta.1`); `1.0` will be rejected

## Notes

- Skills are created as `draft` status; publishing requires admin action (API endpoint currently disabled)
- Duplicate detection: checks existing skills by slug before creating
- Auto-zip excludes dotfiles and `__pycache__` directories
- Version is read from `metadata.version` in frontmatter; falls back to `1.0.0`