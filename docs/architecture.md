# 架构

## 分层(由 tests/architecture.test.ts 自动强制)

```
MCP Layer      src/mcp        协议适配、注册表、ToolHost(校验+统一错误)
Tool Layer     src/tools      只做 MCP 入出参与业务编排
Service Layer  src/services   业务逻辑(SceneService/ShaderService…),并发锁在这一层使用
Core Layer     src/core       文件系统、解析器/序列化器、校验、并发原语、错误、日志
Godot Layer    src/godot      Godot CLI 与 Runtime Adapter(可插拔)
Types          src/types      共享类型,零依赖
```

| 层 | 允许 import |
|---|---|
| types | 无 |
| core | types |
| godot | types, core |
| services | types, core, godot |
| tools | types, services(另外允许 `core/errors`);**Tool 之间互不 import** |
| mcp | types, core;**只有 `mcp/server/sdkServer.ts` 可接触 MCP SDK** |

`src/index.ts`(组合根)和 `src/dev-cli.ts` 不受限,是唯一同时认识所有层的地方。
另有硬规则:`src` 内禁止 `console.log` / `process.stdout`(stdout 归 MCP 协议,日志走 stderr)。

## 新增一个工具
1. 在 `src/tools/<domain>/` 建文件,导出 `ToolDefinition`(名字 `<domain>_<action>`,必须以领域开头)。
2. 定义 `inputSchema`(JSON Schema 子集,见 `core/validation/schema.ts`)。默认拒绝未知参数。
3. 在 `src/tools/index.ts` 加一行。**不需要改 MCP Server 核心。**
4. 业务逻辑放 Service,Tool 里只做参数转换和调用。
5. 失败一律 `throw new GodotMcpError(code, message, details)`。

## 统一约定
- 返回:成功 `{ ok:true, data, message? }`;失败 `{ ok:false, error:{ code, message, details? } }`,MCP 侧以 JSON 文本返回,失败时 `isError:true`。
- **warnings**:非致命提示走 `{ ok:true, data, warnings?: string[] }`(例如 `EDITOR_CONFLICT_WARNING`),不是错误。ToolHost 透传,空数组不出现。
- 错误码(只追加不改名):INVALID_ARGUMENT / TOOL_NOT_FOUND / FILE_NOT_FOUND / PARSE_ERROR / LOCK_TIMEOUT / TASK_TIMEOUT / RUNTIME_REQUIRED / RUNTIME_FAILED / INTERNAL / PROJECT_NOT_FOUND / RESOURCE_NOT_FOUND / GODOT_NOT_FOUND / GODOT_PROCESS_FAILED / VALIDATION_FAILED / FILE_CHANGED。
- 按需加载:环境变量 `GODOT_AI_MCP_GROUPS=project,shader` 只暴露这些领域,减少 agent 上下文占用。
- **错误边界**:上面这套信封覆盖"工具执行"阶段。但**未知工具名**在 MCP 协议层就被 SDK 拒绝(JSON-RPC `-32602`),根本到不了 ToolHost;ToolHost 的 `TOOL_NOT_FOUND` 只在本进程内可达(dev-cli / 单测)。这是 SDK 在履职,不去对抗它。

## 写操作约定(P1 起,所有写工具统一遵守)

- 所有写工具接受 `dryRun?: boolean`:只计算不落盘。
- 所有写工具接受 `expectedHash?: string`(被修改文件当前内容的 sha256,hex):不匹配抛 `FILE_CHANGED`。它是乐观并发控制的唯一手段 —— 编辑器/其他 agent 改了同一个文件时必须能被发现,而不是静默覆盖。
- 写工具返回 `{ changed, diff, newHash }`:`changed=false` 时 `diff` 为空串;`diff` 是行级 unified diff,由 `core/filesystem/unifiedDiff.ts` 生成(无新依赖,单点修改与 git 输出一致,多处分散改动合并成一个 hunk)。
- 所有 list/搜索类工具带 `limit` / `offset`,并用 `core/output.ts` 的 `paginate()` 返回 `{ items, total, nextOffset }`;文本类输出用 `truncateText(text, maxBytes)` 按 UTF-8 边界截断,返回 `{ text, truncated }`。
- 落盘一律走 `core/filesystem/safeWrite.ts`:同目录临时文件 + `rename`(原子),Windows 下短暂的 `EPERM/EACCES/EBUSY` 少量重试;内容统一 LF;失败时清理临时文件,不动原文件。
- 路径一律先过 `core/filesystem/fileGuard.ts`:只接受 `res://…`、项目相对路径、项目内绝对路径;拒绝 `..` 穿越、符号链接/junction 逃逸、项目外绝对路径、`user://`(报 INVALID_ARGUMENT)。
- 项目根由 `core/project/projectResolver.ts` 决定:工具参数 `projectPath` > 环境变量 `GODOT_PROJECT_PATH` > 从 cwd 向上查找 `project.godot`;找不到抛 `PROJECT_NOT_FOUND`。它作为 `AppContext.project` 提供给 Service 层。

## MCP 适配层(已核实,`src/mcp/server/sdkServer.ts`)

全项目**唯一**接触 MCP SDK 的文件(由 `tests/architecture.test.ts` 强制)。事实来自实际安装的包与 `.d.mts`,不是记忆:

| 项 | 事实 |
|---|---|
| 包 / 版本 | `@modelcontextprotocol/server@2.2.0`(v2 线,取代 v1 的 `@modelcontextprotocol/sdk`),实现 MCP **2026-07-28** 规范 |
| 启动方式 | `serveStdio(factory)`。它负责 era 判定与 transport 生命周期:默认 `legacy:'serve'`,**同时服务 2026 modern 客户端与 2025 老客户端**,比手工 `new StdioServerTransport()` + `connect()` 兼容性更好 |
| 注册 | `McpServer.registerTool(name, { title, description, inputSchema, annotations }, cb)` |
| `inputSchema` 类型 | 必须是 `StandardSchemaWithJSON` —— `~standard.validate` **加上** `~standard.jsonSchema.input(options)`,后者用于生成 `tools/list` 的 JSON Schema |
| 注解字段 | `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` |

**Schema 桥接**(`toSdkToolSchema`):项目保留自有的最小 JSON Schema 子集(`src/types/index.ts`)与校验器(`core/validation/schema.ts`)作为唯一事实来源,由桥接函数转成 SDK 要的 Standard Schema:

- `jsonSchema.input()` 原样返回我们的 JSON Schema → `tools/list` 能看到参数结构。
- `validate` 故意**不做拒绝**。入参校验的唯一权威是 ToolHost,这样 `INVALID_ARGUMENT` 才能保持项目统一的错误信封;若在桥接层真校验,SDK 会先用自己的错误格式返回,破坏统一结构。handler 拿到的参数一定已过 ToolHost 校验,不存在"未校验就执行"。

端到端由 `tests/mcpServer.test.ts` 用**官方客户端**经 stdio 连真实编译产物验证,legacy 与 modern 两个 era 各一条。

## 并发与排队(`src/core/concurrency`)

详见 **[docs/concurrency.md](./concurrency.md)**。要点:文件写锁按规范化路径 FIFO、多 key 排序防死锁、读不加锁;项目级 Godot 运行队列复用锁实现;超时返回 `LOCK_TIMEOUT` / `TASK_TIMEOUT` 并附占用者信息;**v1 只在同一 MCP 进程内有效**。

## 已知边界
- Shader 完整编译检查、导入设置生效、`export_mesh_library`、截图与运行时检查必须走 Runtime。
- 不做:编辑器 UI 操作、Undo/Redo、二进制资源(`.res/.scn`)编辑、Editor Plugin。
- `.tscn/.tres` 的具体格式细节必须以 **4.7.2 实际生成的文件**为准(放入 `tests/fixtures`),不得凭记忆假设。解析器要做到"无损":未知内容原样保留。
