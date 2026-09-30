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
- 错误码(只追加不改名):INVALID_ARGUMENT / TOOL_NOT_FOUND / FILE_NOT_FOUND / PARSE_ERROR / LOCK_TIMEOUT / TASK_TIMEOUT / RUNTIME_REQUIRED / RUNTIME_FAILED / INTERNAL。
- 按需加载:环境变量 `GODOT_AI_MCP_GROUPS=project,shader` 只暴露这些领域,减少 agent 上下文占用。
- **错误边界**:上面这套信封覆盖"工具执行"阶段。但**未知工具名**在 MCP 协议层就被 SDK 拒绝(JSON-RPC `-32602`),根本到不了 ToolHost;ToolHost 的 `TOOL_NOT_FOUND` 只在本进程内可达(dev-cli / 单测)。这是 SDK 在履职,不去对抗它。

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
