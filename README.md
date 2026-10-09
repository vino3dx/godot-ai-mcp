# godot-ai-mcp

独立运行的 Godot 4.7.2 MCP Server：默认直接读写 `.tscn` / `.tres` / `project.godot` / `.gdshader` / `.gd` 文件，**日常开发完全不需要启动 Godot 引擎**[cite: 1]。只有在执行必须依赖引擎运行的能力时，才由独立的 Runtime Adapter 调用 Godot CLI 执行[cite: 1]。

---

## 💡 核心特性与工作方式

1. **直读直写与无损解析（Round-trip）**：
   - 核心解析器保证在对 Godot 文本资源进行读取与修改时，未修改的部分、注释、格式空格以及 `sub_resource` / `ext_resource` / `UID` 标识会被严格原样保留[cite: 1, 4]。
2. **后台自动化托管（无需手动启动）**：
   - 本项目基于标准 MCP (Model Context Protocol) 协议运行[cite: 1, 2]。将其配置到 AI 客户端后，客户端会在后台自动拉起并常驻管理 Node.js 服务进程，无需在终端手动运行服务器。
3. **自然语言对话即操作**：
   - 配置完成后，无需手动传送代码，直接在 AI 客户端聊天框中使用自然语言向 AI 下发指令（例如：“帮我在 Godot 项目里新建一个 2D Player 场景”），AI 便会自动通过 MCP 操控 Godot 项目[cite: 5]。

---

## 📌 当前状态

- **T0（准备与验证阶段）**：环境与依赖核对、测试样例（Fixtures）建立以及基线确定已全部完成[cite: 2, 4]。
- **Stage 1 / T1（服务端基础与 Stdio 通信架构）**：
  - 基于 `@modelcontextprotocol/sdk` 构建[cite: 2, 3]。
  - Stdio 端到端测试 100% 全绿（同时兼容 2025 与 2026-07-28 协议 era，参数 Schema 校验、标准错误信封及无毒 Stdio 管道均已验证）[cite: 1, 2]。
- **Stage 2 / T2（核心解析器与服务层）**：推进中，攻克 `project.godot` 及 `.tscn/.tres` 的无损往返解析与修改服务。

---

## 🚀 快速开始与本地开发

### 1. 安装与编译

```bash
npm install
npm run build
```[cite: 1, 3, 5]

### 2. 本地测试与调试 CLI

```bash
# 运行全部单元测试与 Stdio 端到端集成测试
npm test

# 使用内置调试 CLI 查看工具列表与测试（不经 MCP 客户端）
node dist/src/dev-cli.js list
node dist/src/dev-cli.js call utility_ping '{"echo":"hi"}'
```[cite: 1]

---

## ⚙️ 在 AI 客户端中配置使用

在你的 AI 客户端（如 WorkBuddy、Cline、Cursor 等）的 MCP 配置文件（如 `mcpSettings.json` 或 `.cursor/mcp.json`）中添加如下配置[cite: 5]：

```json
{
  "mcpServers": {
    "godot-ai-mcp": {
      "command": "node",
      "args": ["<项目绝对路径>/dist/src/index.js"],
      "env": {
        "GODOT_AI_MCP_GROUPS": "project,shader",
        "GODOT_AI_MCP_LOG": "info"
      }
    }
  }
}
```[cite: 1, 3, 5]

### 环境变量说明

- `GODOT_AI_MCP_GROUPS=project,shader` —— 控制暴露的工具领域，减少 Agent 上下文占用[cite: 1]。
- `GODOT_AI_MCP_LOG=debug|info|warn|error` —— 日志级别[cite: 1]。日志**只写 stderr**，绝对不污染 stdout 通信管道[cite: 1]。

---

## 📚 项目文档体系（单一事实来源 Single Source of Truth）

项目采用瘦身后的精简文档管理策略，避免长历史对话导致 Flash 模型误读：

- `docs/HANDOFF.md`：**全局最重要交接文档**，记载当前 Stage/Task 进度、测试基线 Commit 和接力任务卡[cite: 1, 2]。
- `docs/AGENTS.md`：项目最高级规范、分层架构禁令（MCP -> Tool -> Service -> Parser）与质量红线[cite: 1, 2]。
- `docs/ARCHITECTURE.md`：分层架构细则、MCP 适配层验证事实与错误处理约定[cite: 1, 2]。
- `docs/concurrency.md`：文件并发锁与项目运行队列设计[cite: 1]。