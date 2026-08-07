# 5-配置 Hooks 与子代理

Snow App 的生命周期 Hooks（自动化）与子代理（Sub-agents）配置既可以在
设置面板中手动完成，也可以由 **AI Agent 直接通过内置 `config` 工具写入**
应用数据库（与 UI 同源，立即生效）。

## 1. Hooks 配置教程

### 1.1 基本概念

- **Hook** 是挂在 AI 会话生命周期节点上的自动化规则：当某个事件发生时，
  按规则执行命令（`command`）、注入上下文（`context`）或向 AI 发出指令
  （`prompt`）。
- **作用域**：`global`（全局，所有项目生效）与 `project`（项目级，仅当前
  项目生效）。同一 hook 类型配置了项目级时，**项目级覆盖全局**。
- 每条 hook 配置 = 一个 `hookType` + 一组规则（`rules`）。

### 1.2 Hook 类型（hookType）

| hookType | 触发时机 | 支持的 action |
| --- | --- | --- |
| `onUserMessage` | 用户发送新消息后、转发给 AI 前 | `command`、`context` |
| `beforeToolCall` | 任何工具调用前（可用 matcher 限定工具） | `command` |
| `toolConfirmation` | 工具需要用户授权确认时 | `command` |
| `afterToolCall` | 工具调用完成后 | `command` |
| `onSubAgentComplete` | 子代理任务完成时 | `command`、`prompt` |
| `beforeSubAgentStart` | 子代理激活前（可用 matcher 限定子代理） | `command`、`context` |
| `beforeCompress` | 上下文压缩前 | `command` |
| `onSessionStart` | 打开已有会话时（fire-and-forget） | `command`、`context` |
| `onStop` | 会话停止/清理时（fire-and-forget） | `command`、`prompt` |

### 1.3 rules 数据结构

```jsonc
[
  {
    "description": "规则说明（必填）",
    "matcher": "bash-*",          // 可选：工具 hook 用通配符限定工具名
    "hooks": [                     // 必填：action 数组
      {
        "type": "command",        // command | prompt | context
        "command": "node guard.js", // type=command 时
        "timeout": 5000,          // 可选，毫秒
        "enabled": true           // 可选，默认 true
      }
    ]
  }
]
```

action 类型说明：

| type | 作用 | 适用 hook |
| --- | --- | --- |
| `command` | 执行 shell 命令；上下文 JSON 经 stdin 传入；按退出码处理输出 | 全部 |
| `prompt` | 给 AI 的指令，结果作为软信号 | `onSubAgentComplete`、`onStop` |
| `context` | 静态上下文注入 | `onSessionStart`、`onUserMessage`、`beforeSubAgentStart` |

### 1.4 退出码约定（command 类型）

| 退出码 | 含义 |
| --- | --- |
| `0` | 通过；stdout 作为上下文注入（如 `[Hook Context]`），对话中不可见 |
| `1` | 软警告；stdout 作为 `[Hook Warning]`；若 stdout 是 `{"decision":{"message":"..."}}` 格式的 JSON，则触发用户决策确认 UI |
| `2+` | 阻断；当前流程中断，stderr/错误信息展示给用户 |

### 1.5 配置方式

**方式 A：设置面板（手动）**

1. 打开 **设置 → Hooks 设置**；
2. 选择作用域 Tab（全局 / 项目；项目 Tab 需先选中一个项目）；
3. 选择 hook 类型 → 添加规则与动作 → 保存。

**方式 B：AI Agent 通过 config 工具（自动）**

```jsonc
// 全局 hook：拦截所有 bash 工具调用的危险命令
config-set scope=hooks key=beforeToolCall value={
  "rules": [
    {
      "description": "阻止对根目录执行 rm -rf",
      "matcher": "bash-*",
      "hooks": [
        {
          "type": "command",
          "command": "ctx=$(cat); cmd=$(echo \"$ctx\" | jq -r '.args.command // empty'); if echo \"$cmd\" | grep -qE 'rm\\s+-rf\\s+/'; then echo '已阻止：禁止对根目录执行 rm -rf'; exit 2; fi",
          "timeout": 5000
        }
      ]
    }
  ]
}

// 项目级 hook（需提供 projectId）：仅某项目生效，覆盖全局同名 hook
config-set scope=hooks key=onUserMessage projectId=<projectId> value={
  "rules": [
    {
      "description": "为该项目注入技术栈上下文",
      "hooks": [
        { "type": "context", "content": "本项目使用 Electron + Rust（napi-rs）。" }
      ]
    }
  ]
}

// 查询
config-list scope=hooks                    // 全局 hook 列表
config-list scope=hooks projectId=<projectId>  // 某项目的 hook 列表
config-get  scope=hooks key=beforeToolCall
config-delete scope=hooks key=beforeToolCall projectId=<projectId>
```

> `projectId` 即项目（工作区目录）的 `directoryId`，可通过
> `config-list scope=app` 或项目相关界面获得。

## 2. 子代理配置教程

### 2.1 基本概念

- 子代理是拥有独立 system prompt、工具集与 API 配置文件的专用 Agent，
  通过 `sub-agents-activate` 工具激活执行任务。
- **作用域**：全局（所有项目可用）与项目级（仅当前项目可用）。
  **激活时项目级子代理优先，未命中时回退到全局同名子代理**。
- 内置 `agent_general`（通用子代理）不可删除或通过 config 工具修改。

### 2.2 配置方式

**方式 A：设置面板（手动）**

1. 打开 **设置 → 子代理设置**；
2. 选择作用域 Tab（全局 / 项目）；
3. 添加/编辑子代理（名称、描述、系统提示词、MCP 工具、API 配置档）→ 保存。

**方式 B：AI Agent 通过 config 工具（自动）**

```jsonc
// 创建全局子代理（key = agentId）
config-set scope=subAgents key=agent_code_reviewer value={
  "name": "代码审查员",
  "description": "审查代码质量与安全性",
  "systemPrompt": "你是资深代码审查员，专注发现 bug、安全问题与性能隐患。",
  "toolsJson": ["grep-search", "filesystem-read", "codelens-file_outline"],
  "configProfile": "gpt-4o"
}

// 创建项目级子代理（提供 projectId；同 id 时项目级优先）
config-set scope=subAgents key=agent_db_migrator projectId=<projectId> value={
  "name": "数据库迁移助手",
  "description": "本项目专用：生成与执行数据库迁移",
  "systemPrompt": "你是本项目的数据库迁移专家……",
  "toolsJson": ["bash-terminal-execute", "dbx-dbx_execute_query"]
}

// 查询与删除
config-list scope=subAgents                        // 全部（含项目级）
config-get  scope=subAgents key=agent_code_reviewer
config-delete scope=subAgents key=agent_db_migrator projectId=<projectId>
```

> 注意：`toolsJson` 中的工具名必须是当前项目已启用的 MCP 工具或内置工具
> 全名（`{server_id}-{tool_name}`）。`configProfile` 必须是已存在的
> API 配置档名，为空表示跟随全局生效配置。

## 3. AI / 命令行配置引导（config 工具）

AI Agent 通过内置 `config` 工具配置时的规则速查（与 `config-list` 响应中
返回的 `guidance` 引导一致）：

### 3.1 子代理规则与常见坑

| 规则 | 说明 |
| --- | --- |
| `toolsJson` 显式工具名列表 **必须传 `projectId`** | 选择具体工具的子代理必然是**项目级**；全局子代理只能用 `"*"`（全部工具）或空列表 |
| 工具名必须项目可用 | `toolsJson` 中的每个工具名必须是该项目已启用的内置/MCP 工具全名，否则写入被拒 |
| `configProfile` 留空 | 表示跟随全局生效配置；填已存在的 API 配置档名可指定独立模型 |
| `systemPrompt` 完全自包含 | 子代理独立运行、**无会话历史**——使命、原则、工具用法、输出格式都要写全 |
| 项目级优先 | 激活时项目级子代理优先于同名全局子代理；未命中回退全局 |
| 内置保护 | `agent_general` 不可修改、不可删除 |

**获取 `projectId`**：即项目工作区目录的 `directoryId`，可在
`~/.snow/projects/index.json` 中按项目路径（`knownPaths`）查到；
也可让用户在 **设置 → 子代理设置 → 项目** 范围界面中选择项目后查看。

### 3.2 Hooks 规则速查

| 规则 | 说明 |
| --- | --- |
| `hookType` 白名单 | `onUserMessage` / `beforeToolCall` / `toolConfirmation` / `afterToolCall` / `onSubAgentComplete` / `beforeSubAgentStart` / `beforeCompress` / `onSessionStart` / `onStop` |
| `matcher` 通配符 | 工具类 hook 可用 glob 限定（如 `bash-*` 只拦 bash 工具） |
| `command` 退出码 | `0`=通过（stdout 注入 `[Hook Context]`）；`1`=软警告（stdout 为 `{"decision":{"message":"..."}}` 时触发用户决策 UI）；`2+`=阻断流程 |
| action 适用性 | `prompt` 仅 `onSubAgentComplete`/`onStop`；`context` 仅 `onSessionStart`/`onUserMessage`/`beforeSubAgentStart` |
| 项目级覆盖 | 传 `projectId` 的项目级 hook 覆盖同类型全局 hook |

### 3.3 配置流程建议

1. 先 `config-list scope=<域>` 查看现状与响应中的 `guidance` 引导；
2. 按上文「配置方式 B」的示例构造 `config-set` 请求；
3. 写入后 `config-get` 回读确认；
4. 涉及项目级配置时先确认 `projectId`（见 3.1）。
