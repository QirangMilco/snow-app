---
name: snow-app-docs
description: >-
  Guides the agent to read the built-in Snow App documentation
  (~/.snow/docs) and then help the user configure MCP servers, skills,
  API keys/models, proxy & network, or look up settings.json fields and
  built-in tools. Use this skill whenever the user asks to configure,
  inspect or troubleshoot any of these areas. Covers the config built-in
  service (config-list/get/set/delete), the skills-config built-in
  service (list/setEnabled/installGithub/uninstall) and the
  app-control-openSettings shortcut.
enabled: true
allowed_tools:
  - config-list
  - config-get
  - config-set
  - config-delete
  - skills-config-list
  - skills-config-setEnabled
  - skills-config-installGithub
  - skills-config-uninstall
  - app-control-openSettings
  - bash-terminal-execute
  - filesystem-read
  - filesystem-replace_edit
  - filesystem-create
  - websearch-websearch-search
  - websearch-websearch-fetch
---

# Snow App 文档阅读与配置指导（Docs & Configuration Guide）

当用户请求**配置 MCP 服务器、安装与管理 Skills、配置 API 密钥与模型、
配置代理与网络**，或询问 **settings.json 字段 / 内置工具**时，先阅读应用
内置文档，再按文档步骤动手配置，而不是凭记忆操作。

## 1. 先读文档（Read the docs first）

文档随应用安装到 `~/.snow/docs/`（Windows 为 `C:\Users\<用户名>\.snow\docs\`）。
根据用户界面语言选择分支：

- 中文界面 → 读 `~/.snow/docs/zh-CN/`
- English UI → read `~/.snow/docs/en/`

按任务定位文档（路径相对所选语言分支）：

| 任务 | 使用指南（How-to） | 参考手册（Reference） |
| --- | --- | --- |
| 配置 MCP 服务器 | `2-使用指南/1-配置MCP服务器.md`（en: `2-guides/1-configure-mcp.md`） | `3-参考手册/1-settings.json配置参考.md` |
| 安装与管理 Skills | `2-使用指南/2-安装与管理Skills.md`（en: `2-guides/2-install-and-manage-skills.md`） | — |
| 配置 API 密钥与模型 | `2-使用指南/3-配置API密钥与模型.md`（en: `2-guides/3-configure-api-keys.md`） | `3-参考手册/1-settings.json配置参考.md` |
| 配置代理与网络 | `2-使用指南/4-配置代理与网络.md`（en: `2-guides/4-configure-proxy.md`） | — |
| 查询内置工具 | — | `3-参考手册/2-内置工具参考.md`（en: `3-reference/2-builtin-tools-reference.md`） |

> 若 `~/.snow/docs/` 不存在，说明文档尚未同步，可提示用户重启应用后重试。

## 2. 按文档执行配置（Then apply the configuration）

通读对应文档后按步骤执行：

- **MCP 服务器**：用 `config-set` 写 `settings` 域的 `mcpServers` 键
  （value 为服务器名到配置对象的映射，Windows 路径用 `\\` 转义）；
  写入会自动按差集同步到应用数据库，**立即生效**，无需手动同步；
  也可先 `config-get`/`config-list` 查看现状。
- **API / 代理等配置**：同样通过 `config` 工具读写 `snowcfg`（config.json）、
  `proxy`（proxy-config.json）、`app`（active-profile.json）等白名单域。
- **安全须知**：`config` 工具只能读写白名单内的配置域与键；`config-get`
  对 `apiKey`/`visionApiKey` 等敏感键强制脱敏（如 `sk-****abcd`），**不要
  向用户索要或试图获取明文密钥**；每次写入前自动备份到
  `~/.snow/.config-backups/`，写入为原子替换。
- **打开设置页**：用 `app-control-openSettings`，`page` 参数取值见文档
  （如 `mcp-settings`、`api-settings`、`proxy-browser-settings`）。
- **编辑配置文件**：需要读写 `~/.snow/` 下的 JSON 时使用 filesystem 工具，
  注意 **Windows 路径中的反斜杠必须写成 `\\`**（JSON 转义），否则
  `\f`/`\n`/`\v` 会被解析为转义序列导致配置失效。
- **管理 Skills**：用 `skills-config-list` 查看可用技能与 GitHub 已装记录；
  用 `skills-config-setEnabled` 切换开关——不传 `projectId` 时改写 SKILL.md
  frontmatter 的 `enable` 字段（全局生效，注意字段名是 `enable` 而非
  `enabled`），传 `projectId` 时写入应用数据库项目级覆盖（立即生效且优先
  于 frontmatter）；用 `skills-config-installGithub` 从 GitHub 安装（
  `location` 为 `global` 或 `project`，项目安装需带 `projectId`），用
  `skills-config-uninstall` 卸载（**仅限 GitHub 安装的技能**，手动放置或
  应用自带的技能需删除目录）。也可按文档中的目录约定手动放置 `SKILL.md`，
  新技能立即加载，无需重启应用。

## 3. 完成确认（Confirm with the user）

配置完成后，向用户确认结果，并主动询问是否需要进一步验证
（例如获取 MCP 工具列表验证连通性）。
