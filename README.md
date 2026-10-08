# godot-ai-mcp

独立运行的 Godot 4.7.2 MCP Server:默认直接读写 `.tscn/.tres/project.godot/.gdshader/.gd`,**不需要启动 Godot**;
只有必须运行引擎的能力才经独立的 Runtime Adapter 调用 Godot CLI。

## 状态

阶段 1(架构 + 最小可运行骨架)**已完成并通过实际验证**:

- `npm run build` / `npm test` 全绿(18 个测试)。
- MCP 适配层已用官方客户端经 stdio 端到端验证:连接、`tools/list`(含 JSON Schema)、`tools/call`、统一错误信封;
  2025 与 2026-07-28 两个协议 era 均可用。

## 使用

```bash
npm install
npm test                                   # 构建 + 全部测试(含 stdio 端到端)
node dist/src/dev-cli.js list              # 不经 MCP 客户端,直接列工具
node dist/src/dev-cli.js call utility_ping '{"echo":"hi"}'
node dist/src/index.js                     # 作为 MCP server 运行(stdio)
```

环境变量:

- `GODOT_AI_MCP_GROUPS=project,shader` —— 只暴露指定领域,减少 agent 上下文占用。
- `GODOT_AI_MCP_LOG=debug|info|warn|error` —— 日志级别。日志**只写 stderr**,stdout 留给 MCP 协议。

## 文档

- `docs/AGENTS.md` 项目最高级规范(架构底线、质量红线、任务协议)
- `docs/architecture.md` 分层、MCP 适配层已核实事实、错误约定
- `docs/concurrency.md` 文件锁与项目运行队列
- `docs/HANDOFF.md` 后续阶段的任务卡与分工建议(给接力的模型看)
