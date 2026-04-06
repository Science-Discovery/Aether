---
name: clawhub
description: Use the ClawHub CLI to search, install, update, and publish agent skills from clawhub.com. Trigger when the user asks to search for skills online, such as "搜索 xxx skill", "搜索 xxx 技能", "线上搜索 xxx skill", "在线搜索 xxx 技能", "查找 xxx skill", "下载 xxx skill", or "安装 xxx skill". Also use when the agent determines it needs to discover and download a new skill from an online registry to complete the task.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["clawhub"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "clawhub",
              "bins": ["clawhub"],
              "label": "Install ClawHub CLI (npm)",
            },
          ],
      },
  }
---

# ClawHub CLI

## When to Use

Use this skill when:

- The user explicitly asks to search for a skill online, including phrases like `搜索 xxx skill`, `搜索 xxx 技能`, `线上搜索 xxx skill`, `在线搜索 xxx 技能`, `查找 xxx skill`, or `寻找 xxx 技能`
- The user asks to download or install a skill, including phrases like `下载 xxx skill`, `安装 xxx skill`, or `帮我找一个 xxx skill 并装上`
- The user wants to browse available skills from an online registry rather than inspect local files
- The agent determines that the current task is better solved by discovering and installing a reusable skill from ClawHub

Do not use this skill when the task is only to search the local repository for existing skill folders or inspect local `SKILL.md` files.

Install

```bash
npm i -g clawhub
```

Auth (publish)

```bash
clawhub login
clawhub whoami
```

Search

```bash
clawhub search "postgres backups"
```

Install

```bash
clawhub install my-skill
clawhub install my-skill --version 1.2.3
```

Update (hash-based match + upgrade)

```bash
clawhub update my-skill
clawhub update my-skill --version 1.2.3
clawhub update --all
clawhub update my-skill --force
clawhub update --all --no-input --force
```

List

```bash
clawhub list
```

Publish

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

Notes

- Default registry: https://clawhub.com (override with CLAWHUB_REGISTRY or --registry)
- Default workdir: cwd (falls back to OpenClaw workspace); install dir: ./skills (override with --workdir / --dir / CLAWHUB_WORKDIR)
- Update command hashes local files, resolves matching version, and upgrades to latest unless --version is set
