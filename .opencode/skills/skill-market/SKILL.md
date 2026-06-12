---
name: skill-market
description: "Search, browse, download, and install skills from skill.aiphys.cn (Skill Market / 技能广场) and clawhub.com. PRIORITY: Skill Market first, ClawHub as fallback — always search skill.aiphys.cn before falling back to clawhub.com. Trigger when the user asks to search for skills online, find a skill, install a skill, download a skill, or browse a skill registry, including phrases like '搜索 xxx skill', '搜索 xxx 技能', '线上搜索 xxx skill', '在线搜索 xxx 技能', '查找 xxx skill', '下载 xxx skill', '安装 xxx skill', 'skill market', 'skill.aiphys.cn', '技能广场', 'clawhub', 'clawhub.com', or when the agent determines it needs to discover and install a reusable skill from an online registry. Also use when the user wants to publish a skill to clawhub.com."
---

# Skill Market

Unified skill discovery and installation from two registries: [skill.aiphys.cn](https://skill.aiphys.cn/explore) (primary) and [clawhub.com](https://clawhub.com) (fallback).

## Priority Rule

**Always try Skill Market (skill.aiphys.cn) first.** It hosts physics/science-focused skills more relevant for research workflows. Only fall back to ClawHub (clawhub.com) if Skill Market returns no results or the user explicitly requests ClawHub.

| Registry | Priority | Focus | Access |
|----------|----------|-------|--------|
| skill.aiphys.cn | **Primary** | Physics, scientific research | HTTP API (no CLI dependency) |
| clawhub.com | Fallback | General-purpose | ClawHub CLI (`npm i -g clawhub`) |

## When to Use

- The user asks to search for skills online (any language)
- The user asks to download or install a skill from any online registry
- The user mentions "skill market", "技能广场", "skill.aiphys.cn", "clawhub", "clawhub.com"
- The agent determines the current task needs a skill not locally available

**Do NOT use** when only searching local skill folders or inspecting local SKILL.md files.

## Skill Market Commands (Primary)

```bash
python3 scripts/skill_market.py <command> [options]
```

### search

Search skills by keyword, tags, or category on skill.aiphys.cn:

```bash
python3 scripts/skill_market.py search "physics"
python3 scripts/skill_market.py search "paper" --category "physics"
python3 scripts/skill_market.py search --tags "Feynman integral"
```

### info

Get detailed information about a specific skill:

```bash
python3 scripts/skill_market.py info <skill_id>
```

### versions

List available versions for a skill:

```bash
python3 scripts/skill_market.py versions <skill_id>
```

### install

Download and install a skill to `~/.aether/skills/`:

```bash
python3 scripts/skill_market.py install <skill_id>
python3 scripts/skill_market.py install <skill_id> --version 1.0.0
python3 scripts/skill_market.py install <skill_id> --dir /custom/path
python3 scripts/skill_market.py install <skill_id> --force
```

### list

Show locally installed skills:

```bash
python3 scripts/skill_market.py list
```

## ClawHub Commands (Fallback)

Requires the ClawHub CLI (`npm i -g clawhub`). All commands detect whether `clawhub` is installed and prompt for installation if missing.

### clawhub-search

```bash
python3 scripts/skill_market.py clawhub-search "postgres backups"
```

### clawhub-install

```bash
python3 scripts/skill_market.py clawhub-install my-skill
python3 scripts/skill_market.py clawhub-install my-skill --version 1.2.3
```

### clawhub-update

```bash
python3 scripts/skill_market.py clawhub-update my-skill
python3 scripts/skill_market.py clawhub-update --all --force
```

### clawhub-publish

```bash
python3 scripts/skill_market.py clawhub-publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

### clawhub-list

```bash
python3 scripts/skill_market.py clawhub-list
```

### clawhub-login / clawhub-whoami

```bash
python3 scripts/skill_market.py clawhub-login
python3 scripts/skill_market.py clawhub-whoami
```

## Typical Workflow

1. **search** for relevant skills on skill.aiphys.cn
2. If no results, fall back to **clawhub-search** on clawhub.com
3. **info** / **versions** to review details
4. **install** (Skill Market) or **clawhub-install** (ClawHub) to download
5. Add the install path to `aether.jsonc` skills.paths if needed

## API Details (Skill Market)

- Base URL: `https://skill.aiphys.cn/v1`
- Public endpoints (no auth required): search, info, versions, download published skills
- Only **published** skills can be downloaded; draft skills require admin session
- Response format: JSON with `data` envelope

## ClawHub Notes

- Default registry: https://clawhub.com (override with `--registry`)
- Default workdir: cwd (falls back to OpenClaw workspace); install dir: `./skills` (override with `--workdir`)
- Update command hashes local files, resolves matching version, and upgrades to latest unless `--version` is set