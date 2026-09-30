# godot-ai-mcp 长期项目笔记

## 已核实的 MCP SDK 事实（禁止凭记忆改动）

- 包：`@modelcontextprotocol/server@2.2.0`（v2 线，取代 v1 的 `@modelcontextprotocol/sdk`），实现 MCP **2026-07-28** 规范。
- 启动：`serveStdio(factory)`（`@modelcontextprotocol/server/stdio`）。负责 era 判定 + transport 生命周期；默认 `legacy:'serve'`，**同时服务 2026 modern 与 2025 老客户端**。优于手工 `new StdioServerTransport()` + `connect()`。
- 注册：`McpServer.registerTool(name, { title, description, inputSchema, annotations }, cb)`。
- `inputSchema` 必须是 `StandardSchemaWithJSON`：`~standard.validate` **加上** `~standard.jsonSchema.input(options)`。
  ⚠️ `jsonSchema` 必须嵌在 `~standard` 下（不是顶层 `jsonSchema` 字段），否则 `tools/list` 拿不到参数结构。
- 注解字段名：`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`。
- 未知工具名由 SDK 在协议层拒绝（JSON-RPC `-32602`），到不了 ToolHost。
- 官方 client 的 `versionNegotiation.mode` **默认 `'legacy'`**；测 modern 路径要显式 `{ mode: 'auto' }` 并断言 `client.getProtocolEra() === 'modern'`。

## 项目自身的设计决定（不要擅自推翻）

- **JSON Schema 的唯一事实来源是本项目的 `src/types/index.ts` 子集 + `core/validation/schema.ts` 校验器**，不用 zod 定义工具 schema（zod 只是 SDK 的传递依赖，已从 dependencies 移除）。
- **入参校验的唯一权威是 ToolHost**。`sdkServer.ts` 的 `toSdkToolSchema()` 里 `validate` 故意不做拒绝 —— 否则 SDK 会用自己的错误格式抢先返回，破坏统一错误信封。handler 拿到的参数一定已过 ToolHost 校验。
- 分层由 `tests/architecture.test.ts` 自动强制：只有 `src/mcp/server/sdkServer.ts` 能 import MCP SDK；`src` 内禁止 `console.log` / `process.stdout`。
- `@modelcontextprotocol/client` 是 **devDependency**，仅用于 `tests/mcpServer.test.ts` 的 stdio 端到端验证。
- 并发：`LockManager.withLocks` 对 key 去重后**排序**获取（防死锁）；`TaskQueue` 复用 locks，key 前缀 `godot-run:`。v1 只在同一 MCP 进程内有效。

## Godot 格式的权威数据源（T2 必用，禁止凭记忆）

- 目标版本 **Godot 4.7.2-stable 真实存在**（2026-08-18 维护版本；4.7 于 2026-06-18 发布）。
- 格式定义在引擎源码 `scene/resources/resource_format_text.cpp`（+ `.h` 里的 `FORMAT_VERSION`），可按标签直接取：
  `https://raw.githubusercontent.com/godotengine/godot/4.7.2-stable/scene/resources/resource_format_text.cpp`
- 已从 4.7.2 源码确认的字段顺序（写作 fixtures / 序列化器时照此，不要凭记忆）：
  - `[gd_scene format=M uid="..."]` / `[gd_resource type="..." script_class="..." format=M uid="..."]`
  - `[ext_resource type="..." uid="..." path="..." id="..."]`
  - `[sub_resource type="..." id="..."]`
  - `[node name="..." type="..." parent="..." owner="..." index="..." unique_id=N node_paths=[...] groups=[...]]`
  - `[connection signal="..." from="..." to="..." method="..." flags=N unbinds=N binds= ...]`（注意 `binds= ` 后有空格）
  - `[editable path="..."]`
- ⚠️ `load_steps` **不是** `ResourceFormatSaverTextInstance::save()` 直接写出的；写它的是上层保存路径。不要想当然。
- 结论：fixtures 必须来自**真实引擎输出**或**逐条对照源码**，不能凭记忆手写 —— 实测已推翻过一次"常识"。

## 版本控制

- `git init -b main` 已完成；Stage 1 基线 = `216beb8`。
- 新增 `.gitattributes`：`* text=auto eol=lf`。**理由**：全局 `core.autocrlf=true` 会在 checkout 时把文件改成 CRLF，破坏 T2 的字节级无损往返；Godot 各平台都写 LF。
- `.gitignore` 排除 `node_modules/`、`dist/`、`.workbuddy/`。

## 外部参考资料（已从仓库清除，2026-09-30 用户要求）

- 仓库 docs / AGENTS.md 中所有涉及 godot-mcp（Coding-Solo）与 godot-mcp-toolkit（NPGameDev）的内容已按用户要求删除；项目现在只包含自身信息。
- toolkit 命令映射表完整归档在 `.workbuddy/memory/external-references-toolkit-mapping.md`；godot-mcp 14 能力清单与取舍结论可查 git 基线 `216beb8` 的历史版本。若后续 Runtime Adapter 实现需要参考，从这里取，不要恢复到仓库文档。
- AGENTS.md 章节已重编号（原 11–19 → 现 10–18），Prompt.md 同理（原三–八 → 现二–七）。

## 当前阶段与后续

- Stage 1 已完成并实际验证（build + 18 个测试全绿，含 legacy/modern 两个 era 的 stdio 端到端）。
- 后续任务卡见 `docs/HANDOFF.md`。**下一步是提供 Godot 4.7.2 真实样例到 `tests/fixtures/`**，然后 T1（project.godot 无损解析）→ T2（`.tscn/.tres` 无损解析，全项目最关键）→ T3/T4 → T5 → T6 → T7 → T8 → T9。
- 禁止凭记忆猜 `.tscn/.tres/project.godot/.import` 格式，必须以 fixtures 中真实文件为准。
