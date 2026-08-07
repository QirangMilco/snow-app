# 2-install-and-manage-skills

A skill is a document (`SKILL.md`) that guides an AI agent to complete a specific task. This article explains how to install, write, toggle, and uninstall skills.

## 1. Skill Locations

Snow App automatically loads skills from the following directories (priority from high to low):

| Directory | Scope |
| --- | --- |
| `<project>/.agents/skills/` | Project level (highest priority) |
| `<project>/.snow/skills/` | Project level |
| `~/.agents/skills/` | Global user level |
| `~/.snow/skills/` | Global user level (built-in skill install location) |

Each skill is a directory containing a `SKILL.md`; the directory name is the skill ID:

```
~/.snow/skills/
└── my-skill/
    └── SKILL.md
```

## 2. Installing from GitHub

### Via the GUI

1. Open **Settings → Skills Settings**;
2. Paste the repository address into the "Install from GitHub" input box;
3. Full URLs and `owner/repo` shorthand are supported, and you can specify a branch and a subdirectory. URL examples:
   - `https://github.com/owner/repo` or `owner/repo` — uses the default branch and auto-discovers skills at the repo root or under `skills/`;
   - `https://github.com/owner/repo/tree/<branch>/<subdir>` — targets a specific branch and subdirectory, e.g. `https://github.com/cli/cli/tree/trunk/skills/gh` installs the skill under `skills/gh` on the `trunk` branch of `cli/cli`;
4. Click Install; once complete, the skill appears in the list and can be toggled immediately.

### Manually (the agent can execute this directly)

```bash
# 下载仓库到临时目录
git clone --depth 1 https://github.com/owner/repo.git /tmp/my-skill-repo
# 找到 SKILL.md（可能在根目录或子目录），复制到全局技能目录
mkdir -p ~/.snow/skills/my-skill
cp /tmp/my-skill-repo/SKILL.md ~/.snow/skills/my-skill/SKILL.md
```

New skills are loaded immediately; no app restart is needed.

## 3. SKILL.md Format

```markdown
---
name: skill-name
description: 一句话说明用途（Agent 据此判断何时使用）
enabled: true
allowed_tools:
  - filesystem-read
  - bash-terminal-execute
---

# 技能正文

给 Agent 的详细操作指导……
```

**Frontmatter fields**:

| Field | Required | Description |
| --- | --- | --- |
| `name` | No | Skill name; defaults to the directory name if omitted |
| `description` | No | Skill description, used by the agent for automatic selection |
| `enabled` | No | Defaults to `true`; `false` means disabled by default |
| `allowed_tools` | No | When listed, the skill can **only use** these tools during execution |

## 4. Toggling and Uninstalling

- **Toggle**: Settings → Skills Settings → the switch in the list;
- **Uninstall GitHub-installed skills**: Skills Settings → the Uninstall button;
- **Uninstall manually**: delete the corresponding skill directory.
- **Via the agent**: the agent can perform the same operations with the `config` built-in service — `config-list scope=skills` to inspect the current state, `config-set scope=skills value={enabled}` to toggle a skill (global: rewrites the frontmatter; project: writes an app DB override), and `config-set scope=skills value={url, location}` / `config-delete scope=skills` to install/uninstall (uninstall only works for GitHub-installed skills). See `3-reference/2-builtin-tools-reference.md`.

## 5. Built-in Skills

Snow App ships with the **snow-app-docs** skill (enabled by default), which guides the agent to read the app documentation and then help users configure MCP, skills, API, proxy, etc. You can turn it off at any time in Skills Settings.

## 6. FAQ

| Symptom | Cause & fix |
| --- | --- |
| The skill doesn't appear after installation | Make sure the directory structure is `<skills-dir>/<skill-id>/SKILL.md` |
| The agent cannot use certain tools | The skill declares `allowed_tools`; add the tools in the frontmatter |
| The skill has no effect | Check the `enabled` field; skills with invalid frontmatter are skipped |
