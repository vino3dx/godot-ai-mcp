# godot-ai-mcp

[![Godot](https://img.shields.io/badge/Godot-4.6.3%20%2F%204.x-478CBF?logo=godotengine&logoColor=white)](https://godotengine.org/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-8A2BE2)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Standalone MCP Server for Godot 4.6.3 / 4.x**  
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

### Current Status & Verified Capabilities

| Stage | Description | Status |
|-------|-------------|--------|
| Stage 1 | MCP Server foundation + Stdio communication | Completed |
| Stage 2 | Core parsers, Scene/Resource services, FileService | Completed |
| Stage 3 | Project config + GDScript/Shader management | Completed |

**Tool Matrix (15 tools)**

| Category | Tools |
|----------|-------|
| Utility / Runtime | `utility_ping`, `utility_task_status`, `runtime_get_version` |
| Scene | `scene_get_tree`, `scene_update_node_property`, `scene_remove_node` |
| Resource | `resource_get_info`, `resource_update_property`, `resource_add_or_update_external` |
| Project / Shader / Script | `project_get_config`, `project_set_config`, `shader_get_info`, `shader_update_uniform_default`, `script_get_info`, `script_update_export_default` |

### Quick Start

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

### MCP Client Configuration

Add the following to your AI client’s MCP config (e.g. `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "godot-ai-mcp": {
      "command": "node",
      "args": [
        "D:/Dev/godot-ai-mcp/dist/src/index.js"
      ],
      "env": {
        "GODOT_PATH": "E:/Program Files/Godot Engine/Godot_v4.6.3-stable_win64.exe/Godot_v4.6.3-stable_win64.exe",
        "DEBUG": "true"
      }
    }
  }
}
```

> Replace the paths with your local absolute paths.

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

### 当前状态与已验证能力

| 阶段 | 描述 | 状态 |
|------|------|------|
| Stage 1 | MCP 服务端基础 + Stdio 通信架构 | 已完成 |
| Stage 2 | 核心解析器、Scene/Resource 服务、FileService | 已完成 |
| Stage 3 | 项目配置 + GDScript/Shader 管理 | 已完成 |

**当前工具矩阵（共 15 个）**

| 分类 | 工具 |
|------|------|
| Utility / Runtime | `utility_ping`、`utility_task_status`、`runtime_get_version` |
| Scene | `scene_get_tree`、`scene_update_node_property`、`scene_remove_node` |
| Resource | `resource_get_info`、`resource_update_property`、`resource_add_or_update_external` |
| Project / Shader / Script | `project_get_config`、`project_set_config`、`shader_get_info`、`shader_update_uniform_default`、`script_get_info`、`script_update_export_default` |

### 快速开始

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

### 在 AI 客户端中配置

在 AI 客户端（如 Cursor、CodeBuddy、Cline 等）的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "godot-ai-mcp": {
      "command": "node",
      "args": [
        "D:/Dev/godot-ai-mcp/dist/src/index.js"
      ],
      "env": {
        "GODOT_PATH": "E:/Program Files/Godot Engine/Godot_v4.6.3-stable_win64.exe/Godot_v4.6.3-stable_win64.exe",
        "DEBUG": "true"
      }
    }
  }
}
```

> 请将路径替换为你本机的实际绝对路径。

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