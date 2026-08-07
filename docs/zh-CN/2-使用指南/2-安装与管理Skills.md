# 2-安装与管理Skills

Skill（技能）是一份指导 AI Agent 完成特定任务的文档（`SKILL.md`）。
本文介绍如何安装、编写、开关和卸载 Skills。

## 1. 技能存放位置

Snow App 按以下目录自动加载技能（优先级从高到低）：

| 目录 | 作用域 |
| --- | --- |
| `<项目>/.agents/skills/` | 项目级（最高优先级） |
| `<项目>/.snow/skills/` | 项目级 |
| `~/.agents/skills/` | 全局用户级 |
| `~/.snow/skills/` | 全局用户级（内置技能安装位置） |

每个技能是一个包含 `SKILL.md` 的目录，目录名即技能 ID：

```
~/.snow/skills/
└── my-skill/
    └── SKILL.md
```

## 2. 从 GitHub 安装

### 图形界面方式

1. 打开 **设置 → Skills 设置**；
2. 在"从 GitHub 安装"输入框粘贴仓库地址；
3. 支持完整 URL、`owner/repo` 简写，可指定分支和子目录。URL 格式示例：
   - `https://github.com/owner/repo` 或 `owner/repo`——使用默认分支，自动发现仓库根目录或 `skills/` 子目录下的技能；
   - `https://github.com/owner/repo/tree/<branch>/<subdir>`——指定分支与子目录，例如安装 cli/cli 仓库 `trunk` 分支 `skills/gh` 子目录的技能：`https://github.com/cli/cli/tree/trunk/skills/gh`；
4. 点击安装，完成后技能出现在列表中，可立即开关。

### 手动方式（Agent 可直接执行）

```bash
# 下载仓库到临时目录
git clone --depth 1 https://github.com/owner/repo.git /tmp/my-skill-repo
# 找到 SKILL.md（可能在根目录或子目录），复制到全局技能目录
mkdir -p ~/.snow/skills/my-skill
cp /tmp/my-skill-repo/SKILL.md ~/.snow/skills/my-skill/SKILL.md
```

新技能立即被加载，无需重启应用。

## 3. SKILL.md 格式

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

**frontmatter 字段**：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | 技能名称，缺省时取目录名 |
| `description` | 否 | 技能描述，用于 Agent 自动选择 |
| `enabled` | 否 | 默认 `true`；`false` 则默认关闭 |
| `allowed_tools` | 否 | 列出后技能执行时**只能使用**这些工具 |

## 4. 开关与卸载

- **开关**：设置 → Skills 设置 → 列表中的开关；
- **卸载 GitHub 安装的技能**：Skills 设置 → 卸载按钮；
- **手动卸载**：删除对应技能目录。
- **Agent 管理**：Agent 也可用 `config` 内置服务完成上述操作——
  `config-list scope=skills` 查看现状、`config-set scope=skills value={enabled}`
  切换开关（全局改写 frontmatter / 项目级写应用数据库）、
  `config-set scope=skills value={url, location}` 与 `config-delete scope=skills`
  安装与卸载（卸载仅限 GitHub 来源）。详见
  《3-参考手册/2-内置工具参考.md》。

## 5. 内置技能

Snow App 随应用自带 **snow-app-docs** 技能（默认开启），它指导 Agent
阅读应用文档后帮助用户配置 MCP、Skills、API、代理等。可在 Skills 设置中
随时关闭。

## 6. 常见问题

| 症状 | 原因与处理 |
| --- | --- |
| 安装后技能没出现 | 确认目录结构为 `<skills-dir>/<skill-id>/SKILL.md` |
| Agent 无法使用某些工具 | 技能声明了 `allowed_tools`，需在 frontmatter 中补充 |
| 技能不生效 | 检查 `enabled` 字段；frontmatter 格式错误时技能会被跳过 |
