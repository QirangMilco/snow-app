# Snow App 文档

> 基于 Electron、React、TypeScript 和 Rust 构建的高性能跨平台桌面应用。

欢迎阅读 Snow App 文档。本目录按 [Diátaxis](https://diataxis.fr/) 框架组织：
**快速开始**（Tutorial）带你上手，**使用指南**（How-to）解决具体任务，
**参考手册**（Reference）提供权威信息。

## 文档导航 / Documentation

| 中文 (zh-CN) | English (en) | 说明 / Description |
| --- | --- | --- |
| [1-快速开始](zh-CN/1-快速开始.md) | [1-getting-started](en/1-getting-started.md) | 安装与首次运行 / Install & first run |
| [2-使用指南/1-配置MCP服务器](zh-CN/2-使用指南/1-配置MCP服务器.md) | [2-guides/1-configure-mcp](en/2-guides/1-configure-mcp.md) | MCP 服务器配置 / Configure MCP servers |
| [2-使用指南/2-安装与管理Skills](zh-CN/2-使用指南/2-安装与管理Skills.md) | [2-guides/2-install-and-manage-skills](en/2-guides/2-install-and-manage-skills.md) | Skills 安装与管理 / Install & manage skills |
| [2-使用指南/3-配置API密钥与模型](zh-CN/2-使用指南/3-配置API密钥与模型.md) | [2-guides/3-configure-api-keys](en/2-guides/3-configure-api-keys.md) | API 与模型配置 / Configure API & models |
| [2-使用指南/4-配置代理与网络](zh-CN/2-使用指南/4-配置代理与网络.md) | [2-guides/4-configure-proxy](en/2-guides/4-configure-proxy.md) | 代理与网络 / Proxy & network |
| [3-参考手册/1-settings.json配置参考](zh-CN/3-参考手册/1-settings.json配置参考.md) | [3-reference/1-settings-json-reference](en/3-reference/1-settings-json-reference.md) | settings.json 字段参考 / settings.json reference |
| [3-参考手册/2-内置工具参考](zh-CN/3-参考手册/2-内置工具参考.md) | [3-reference/2-builtin-tools-reference](en/3-reference/2-builtin-tools-reference.md) | 内置工具参考 / Built-in tools reference |

## 给 AI Agent 的说明

本目录同时服务于 Snow App 内置的 **snow-app-docs** 技能。当你需要配置
MCP 服务器、安装 Skills、调整 API 或代理设置时：

1. 根据用户界面语言选择 `zh-CN/` 或 `en/` 分支；
2. 从 **使用指南（2-使用指南 / 2-guides）** 中找到对应任务文档并通读；
3. 不确定字段含义时查阅 **参考手册（3-参考手册 / 3-reference）**；
4. 按照文档步骤执行配置，完成后再向用户确认。

> 文档随应用版本同步更新。若某主题未覆盖，可查阅
> [GitHub 仓库](https://github.com/MayDay-wpf/snow-app) 的 README 或提交 issue。
