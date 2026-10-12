# godot-ai-mcp

[![npm version](https://img.shields.io/npm/v/vinofx-godot-ai-mcp.svg)](https://www.npmjs.com/package/vinofx-godot-ai-mcp)
[![Godot](https://img.shields.io/badge/Godot-4.6.3+-478CBF?logo=godotengine&logoColor=white)](https://godotengine.org/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-8A2BE2)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Standalone MCP Server for Godot 4.6.3+**  
Read & write `.tscn` / `.tres` / `project.godot` / `.gdshader` / `.gd` files directly via pure-text AST parsers.  
**No need to launch the Godot editor for daily development.**  
Runtime Adapter only calls Godot CLI when engine-dependent capabilities are required.

---

**Language / 语言**  
### [English](#english) & [中文](#中文)

---

<a id="english"></a>

## English

### Core Features

1. **Lossless Round-trip Parsing**  
   The core parser strictly preserves unmodified content, comments, whitespace, `sub_resource`, `ext_resource`, and `UID` identifiers when reading and modifying Godot text resources.

2. **Background Auto-Management**  
   Based on the standard MCP (Model Context Protocol). Once configured in an AI client, the client automatically starts and manages the Node.js process in the background. No manual terminal launch required.

3. **Natural Language = Project Control**  
   After setup, simply chat with the AI (e.g. “Read the current project config and parse the main scene tree”). The AI will automatically operate the project through MCP tools.

### Install from npm (recommended)

```bash
# Requires Node.js >= 22 (see "engines" in package.json)
npx -y vinofx-godot-ai-mcp

# or install globally, which provides the `godot-ai-mcp` command
npm install -g vinofx-godot-ai-mcp
```

`npx` fetches the published package on demand — **no clone, no build, no Godot editor**. The command starts a **stdio MCP server**: it logs

```
[godot-ai-mcp] INFO MCP server "godot-ai-mcp@1.0.0" listening on stdio, 19 tools exposed
```

to stderr, then waits for JSON-RPC on stdin (Ctrl+C to quit). You normally never run it by hand — your AI client launches it.

### MCP Client Configuration (npm)

Add this to your AI client's MCP config (`.cursor/mcp.json`, CodeBuddy, Cline, …):

```json
{
  "mcpServers": {
    "godot-ai-mcp": {
      "command": "npx",
      "args": ["-y", "vinofx-godot-ai-mcp"],
      "env": {
        "GODOT_PATH": "<absolute path to the Godot console executable>",
        "GODOT_AI_MCP_LOG": "debug"
      }
    }
  }
}
```

| Environment variable | Required | Meaning |
|---|---|---|
| `GODOT_PATH` | only for `runtime_*` tools | Absolute path to the Godot CLI. Tried first, `PATH` second (`src/godot/cli.ts`). A non-existent path fails loudly with `GODOT_NOT_FOUND` instead of silently falling back. |
| `GODOT_AI_MCP_GROUPS` | no | Comma-separated domain filter exposing fewer tools, e.g. `project,shader` (`src/mcp/registry/toolRegistry.ts`). |
| `GODOT_AI_MCP_LOG` | no | `debug` / `info` / `warn` / `error`; default `info` (`src/core/logger.ts`). |

> **Windows note**: if your client cannot find `npx`, use `"command": "npx.cmd"`, or `"command": "cmd"` with `"args": ["/c", "npx", "-y", "vinofx-godot-ai-mcp"]`.

> **🔴 Recommended**: using the console version of Godot is recommended, as it significantly improves AI operational efficiency.

### Usage

Once configured, just talk to your AI in natural language:

| What you say | Tool the AI calls |
|---|---|
| “Which Godot version does the CLI report?” | `runtime_get_version` |
| “Read `res://project.godot` and show the main scene and renderer settings.” | `project_get_config` |
| “Print the node tree of `res://main.tscn`.” | `scene_get_tree` |
| “In `res://player.tscn`, set `Sprite2D.position` to `Vector2(32, 64)`.” | `scene_update_node_property` |
| “Run the project and capture a screenshot.” | `runtime_run_project` + `runtime_capture_screenshot` |

Every write tool accepts two safety switches (see `src/tools/scene/updateNodeProperty.ts` and its siblings):

- `dryRun: true` — return the unified diff **without writing**.
- `expectedHash: "<sha256>"` — optimistic concurrency: if the file changed after the hash was read, the call fails with `FILE_CHANGED` instead of overwriting.

Typical safe-edit loop: a read tool (`scene_get_tree`, `project_get_config`, …) returns the current file hash → call the write tool with `dryRun: true` and review the diff → repeat without `dryRun`, passing `expectedHash`.

### Quick Start from Source (contributors)

```bash
# Install & Build
npm install
npm run build
# Output: dist/src/index.js
```

```bash
# Run all unit + Stdio e2e tests
npm test

# Debug CLI (without MCP client)
node dist/src/dev-cli.js list
node dist/src/dev-cli.js call utility_ping '{"echo":"heartbeat"}'
```

Local-build client config (instead of `npx`):

```json
{
  "mcpServers": {
    "godot-ai-mcp": {
      "command": "node",
      "args": [
        "D:/Dev/godot-ai-mcp/dist/src/index.js"
      ],
      "env": {
        "GODOT_PATH": "E:/Program Files/Godot Engine/Godot_v4.6.3-stable_win64.exe/Godot_v4.6.3-stable_win64_console.exe",
        "GODOT_AI_MCP_LOG": "debug"
      }
    }
  }
}
```

> **⚠️ Note**: Please replace the path with the actual absolute path on your local machine.

### Current Status & Verified Capabilities

| Stage | Description | Status |
|-------|-------------|--------|
| Stage 1 | MCP Server foundation + Stdio communication | Completed |
| Stage 2 | Core parsers, Scene/Resource services, FileService | Completed |
| Stage 3 | Project config + GDScript/Shader management | Completed |

**Tool Matrix (19 tools)**

| Category | Tools |
|----------|-------|
| Utility / Runtime | `utility_ping`, `utility_task_status`, `runtime_get_version`, `runtime_run_project`, `runtime_run_scene`, `runtime_export_project`, `runtime_capture_screenshot` |
| Scene | `scene_get_tree`, `scene_update_node_property`, `scene_remove_node` |
| Resource | `resource_get_info`, `resource_update_property`, `resource_add_or_update_external` |
| Project / Shader / Script | `project_get_config`, `project_set_config`, `shader_get_info`, `shader_update_uniform_default`, `script_get_info`, `script_update_export_default` |

### Architecture & Documentation

Strict unidirectional dependency:

```
MCP Layer → Tool Layer → Service Layer → Core/Parser → FileSystem
```

| Document | Description |
|----------|-------------|
| `docs/HANDOFF.md` | Global handoff notes & progress |
| `docs/AGENTS.md` | Architecture rules & quality red lines |
| `docs/ARCHITECTURE.md` | Layered architecture & MCP protocol details |
| `docs/concurrency.md` | File locks & runtime queue design |

---

<a id="中文"></a>

## 中文

### 核心特性

1. **直读直写与无损解析（Round-trip）**  
   核心解析器保证在对 Godot 文本资源进行读取与修改时，未修改的部分、注释、格式空格以及 `sub_resource` / `ext_resource` / `UID` 标识会被严格原样保留。

2. **后台自动化托管（无需手动启动）**  
   基于标准 MCP（Model Context Protocol）协议。配置到 AI 客户端后，客户端会在后台自动拉起并常驻管理 Node.js 服务进程，无需在终端手动运行。

3. **自然语言对话即操作**  
   配置完成后，直接在 AI 客户端聊天框中使用自然语言下发指令（例如：“帮我读取当前项目的配置并解析主场景树”），AI 会自动通过 MCP 操控项目。

### 从 npm 安装（推荐）

```bash
# 需要 Node.js >= 22（见 package.json 的 engines 字段）
npx -y vinofx-godot-ai-mcp

# 或全局安装，会提供 `godot-ai-mcp` 命令
npm install -g vinofx-godot-ai-mcp
```

`npx` 会按需拉取已发布的包 —— **不需要克隆源码、不需要编译、不需要打开 Godot 编辑器**。该命令启动的是一个 **stdio MCP 服务**：它会先在 stderr 输出

```
[godot-ai-mcp] INFO MCP server "godot-ai-mcp@1.0.0" listening on stdio, 19 tools exposed
```

然后等待 stdin 上的 JSON-RPC 消息（Ctrl+C 退出）。通常你不需要手动运行它 —— AI 客户端会自己拉起。

### 在 AI 客户端中配置（npm）

在 AI 客户端（如 Cursor、CodeBuddy、Cline 等）的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "godot-ai-mcp": {
      "command": "npx",
      "args": ["-y", "vinofx-godot-ai-mcp"],
      "env": {
        "GODOT_PATH": "<你的 Godot 控制台版可执行文件的绝对路径>",
        "GODOT_AI_MCP_LOG": "debug"
      }
    }
  }
}
```

| 环境变量 | 是否必需 | 说明 |
|---|---|---|
| `GODOT_PATH` | 仅 `runtime_*` 类工具需要 | Godot CLI 的绝对路径。优先读取它，其次在 `PATH` 中查找（`src/godot/cli.ts`）。路径不存在时会直接报 `GODOT_NOT_FOUND`，不会静默回退到 `PATH`。 |
| `GODOT_AI_MCP_GROUPS` | 否 | 逗号分隔的领域过滤，只向客户端暴露部分工具，例如 `project,shader`（`src/mcp/registry/toolRegistry.ts`）。 |
| `GODOT_AI_MCP_LOG` | 否 | `debug` / `info` / `warn` / `error`，默认 `info`（`src/core/logger.ts`）。 |

> **Windows 提示**：如果客户端找不到 `npx`，可改为 `"command": "npx.cmd"`，或用 `"command": "cmd"` 搭配 `"args": ["/c", "npx", "-y", "vinofx-godot-ai-mcp"]`。

> **🔴 推荐**：建议使用控制台（Console）版本的 Godot，能显著提升 AI 操作效率。

### 用法

配置完成后，直接用自然语言对 AI 下指令即可：

| 你可以这样说 | AI 实际调用的工具 |
|---|---|
| “CLI 报告的 Godot 版本是多少？” | `runtime_get_version` |
| “读取 `res://project.godot`，告诉我主场景和渲染设置。” | `project_get_config` |
| “打印 `res://main.tscn` 的节点树。” | `scene_get_tree` |
| “把 `res://player.tscn` 里 `Sprite2D.position` 改成 `Vector2(32, 64)`。” | `scene_update_node_property` |
| “运行项目并截一张图。” | `runtime_run_project` + `runtime_capture_screenshot` |

所有写操作类工具都支持两个安全开关（见 `src/tools/scene/updateNodeProperty.ts` 及其同类文件）：

- `dryRun: true` —— 只返回 unified diff，**不落盘**。
- `expectedHash: "<sha256>"` —— 乐观并发：若文件在读取hash 之后被改动，调用会以 `FILE_CHANGED` 失败，而不是覆盖别人的修改。

推荐的安全编辑闭环：先用读类工具（`scene_get_tree`、`project_get_config` 等）拿到当前文件 hash → 用 `dryRun: true` 调写工具看 diff → 去掉 `dryRun` 并带上 `expectedHash` 再调一次。

### 从源码启动（贡献者）

```bash
# 安装与编译
npm install
npm run build
# 输出目录：dist/src/index.js
```

```bash
# 运行全部单元测试与 Stdio 端到端集成测试
npm test

# 内置调试 CLI（不经 MCP 客户端）
node dist/src/dev-cli.js list
node dist/src/dev-cli.js call utility_ping '{"echo":"heartbeat"}'
```

使用本地构建产物时的客户端配置（替代 `npx`）：

```json
{
  "mcpServers": {
    "godot-ai-mcp": {
      "command": "node",
      "args": [
        "D:/Dev/godot-ai-mcp/dist/src/index.js"
      ],
      "env": {
        "GODOT_PATH": "E:/Program Files/Godot Engine/Godot_v4.6.3-stable_win64.exe/Godot_v4.6.3-stable_win64_console.exe",
        "GODOT_AI_MCP_LOG": "debug"
      }
    }
  }
}
```

> **⚠️ 注意**：请将路径替换为你本机的实际绝对路径。

### 当前状态与已验证能力

| 阶段 | 描述 | 状态 |
|------|------|------|
| Stage 1 | MCP 服务端基础 + Stdio 通信架构 | 已完成 |
| Stage 2 | 核心解析器、Scene/Resource 服务、FileService | 已完成 |
| Stage 3 | 项目配置 + GDScript/Shader 管理 | 已完成 |

**当前工具矩阵（共 19 个）**

| 分类 | 工具 |
|------|------|
| Utility / Runtime | `utility_ping`、`utility_task_status`、`runtime_get_version`、`runtime_run_project`、`runtime_run_scene`、`runtime_export_project`、`runtime_capture_screenshot` |
| Scene | `scene_get_tree`、`scene_update_node_property`、`scene_remove_node` |
| Resource | `resource_get_info`、`resource_update_property`、`resource_add_or_update_external` |
| Project / Shader / Script | `project_get_config`、`project_set_config`、`shader_get_info`、`shader_update_uniform_default`、`script_get_info`、`script_update_export_default` |

### 项目架构与文档

严格遵循单向依赖架构：

```
MCP Layer → Tool Layer → Service Layer → Core/Parser → FileSystem
```

| 文档 | 说明 |
|------|------|
| `docs/HANDOFF.md` | 全局交接文档与进展记录 |
| `docs/AGENTS.md` | 架构禁令与质量红线 |
| `docs/ARCHITECTURE.md` | 分层架构细则与 MCP 协议适配说明 |
| `docs/concurrency.md` | 文件并发锁与运行队列设计 |

---

## License

MIT
