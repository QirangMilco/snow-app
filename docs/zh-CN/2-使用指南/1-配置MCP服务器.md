# 1-配置MCP服务器

MCP（Model Context Protocol）服务器为 AI 提供外部工具，例如数据库查询、
浏览器自动化、文档检索等。本文介绍如何在 Snow App 中配置**全局 MCP 服务器**
（所有项目共享）。

## 1. 认识配置入口

| 入口 | 说明 |
| --- | --- |
| 设置 → MCP 设置 | 图形界面：添加/编辑/删除/启用/获取工具 |
| `config` 内置工具 | AI Agent 读写配置文件；写 `mcpServers` 自动同步应用数据库，立即生效 |
| `~/.snow/settings.json` 的 `mcpServers` 字段 | 与 Snow CLI 共享的配置文件，需手动同步 |

## 2. 方式一：图形界面（推荐新手）

1. 打开 **设置 → MCP 设置**；
2. 点击 **添加服务**，填写：
   - **名称**：如 `dbx`
   - **传输方式**：`stdio`（本地命令）或 `http`（远程服务）
   - **命令**（stdio）：可执行文件路径，如 `npx` 或完整路径
   - **参数**（stdio）：传给命令的参数，逐项添加
   - **URL**（http）：服务端点地址
   - **环境变量 / 请求头**：按需添加键值对
   - **启用服务**：保存后默认开启
3. 点击 **保存服务**；
4. 点击列表中的工具图标，**获取工具** 验证连通性。

### JSON 编辑与批量导入

- 编辑器内有 **表单 / JSON** 切换，可直接粘贴 JSON 编辑单个服务器；
- 全局页有 **导入 JSON** 按钮，支持三种格式批量导入：

```json
{
  "mcpServers": {
    "example": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": {},
      "enabled": true
    }
  }
}
```

也兼容 Claude 风格 `{ "servers": {...} }` 和纯服务器映射格式。

## 3. 方式二：让 AI Agent 配置（推荐）

Snow App 内置通用配置服务 `config`，Agent 可读写 `~/.snow/` 下的
配置文件（settings.json / config.json / proxy-config.json /
active-profile.json）：

| 工具 | 用途 |
| --- | --- |
| `config-list` | 列出可管理的配置域（settings/snowcfg/proxy/app）与键 |
| `config-get` | 读取指定键的值（apiKey 等敏感键自动脱敏） |
| `config-set` | 写入指定键（白名单 + 类型校验 + 自动备份 + 原子写） |
| `config-delete` | 删除指定键 |

配置 MCP 服务器 = 写入 `settings` 域的 `mcpServers` 键，示例：

```json
{
  "scope": "settings",
  "key": "mcpServers",
  "value": {
    "dbx": {
      "type": "stdio",
      "command": "D:\\fnm\\node-versions\\v24.15.0\\installation\\node.exe",
      "args": [
        "D:\\fnm\\node-versions\\v24.15.0\\installation\\node_modules\\@dbx-app\\mcp-server\\bin\\dbx-mcp-server.js"
      ],
      "env": {},
      "enabled": true
    }
  }
}
```

HTTP 服务器示例（value 中服务器对象）：

```json
{
  "scope": "settings",
  "key": "mcpServers",
  "value": {
    "my-http-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

> **生效方式**：写入 `settings.mcpServers` 时会自动按差集同步到应用数据库
> （与 UI“同步 Snow CLI MCP 设置”语义一致：新增/更新文件中的服务器，
> 删除不再存在的），**立即生效无需手动同步**。其余配置域（snowcfg/proxy/
> app）为纯文件写入，生效需重启应用或重新保存 UI 设置。
>
> **安全说明**：
> - 只能读写白名单内的配置域与键，拒绝任意路径；
> - `config-get` 对 `apiKey`/`visionApiKey` 等敏感键强制脱敏（如 `sk-****abcd`）；
> - 每次写入前自动备份原文件到 `~/.snow/.config-backups/`（保留最近 10 份），
>   写入采用原子替换，配置损坏可随时恢复。
>
> **Windows 路径注意**：JSON 中的反斜杠必须写成 `\\\\`，否则 `\\f`、`\\n`、
> `\\v` 会被当作转义序列，导致服务器启动失败。

### 项目级 MCP 服务器

给 `config-set settings mcpServers` 传 `projectId` 可**全量替换**该项目级
MCP 服务器（`projectId` 即项目工作区目录的 `directoryId`，可在
`~/.snow/projects/index.json` 按项目路径 `knownPaths` 查询）：

```jsonc
config-set scope=settings key=mcpServers projectId=<projectId> value={
  "dbx": { "type": "stdio", "command": "npx", "args": ["-y", "@dbx-app/mcp-server"], "env": {}, "enabled": true }
}
```

`config-get` / `config-delete` 传 `projectId` 读取/清空项目级服务器；项目级
与全局服务器独立并存、叠加生效（写入应用数据库，**立即生效**）。

## 4. 方式三：编辑 settings.json（批量/离线）

全局 MCP 配置也存储在 `~/.snow/settings.json` 的 `mcpServers` 字段：

```json
{
  "mcpServers": {
    "dbx": {
      "type": "stdio",
      "command": "D:\\fnm\\node-versions\\v24.15.0\\installation\\node.exe",
      "args": [
        "D:\\fnm\\node-versions\\v24.15.0\\installation\\node_modules\\@dbx-app\\mcp-server\\bin\\dbx-mcp-server.js"
      ],
      "env": {},
      "enabled": true
    }
  }
}
```

修改后需在 **设置 → MCP 设置 → 同步 Snow CLI MCP 设置** 手动导入。

## 5. 常见问题

| 症状 | 原因与处理 |
| --- | --- |
| 获取工具报 `connection closed: discover response` | 服务器基于旧 SDK，客户端会自动回退传统握手；仍失败则更新服务器版本 |
| 服务器启动失败 | 检查命令路径；Windows 反斜杠需 `\\` 转义；npx 命令加 `cmd /c` 前缀 |
| 配置保存后不生效 | 确认 `enabled: true`；settings.json 需手动同步 |
| 工具列表为空 | 服务器未返回工具，或 `enabled` 为 false |

## 6. 参考

- 字段完整说明：[3-参考手册/1-settings.json配置参考](../3-参考手册/1-settings.json配置参考.md)
