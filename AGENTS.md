# AGENTS.md

本文件是 `godot-ai-mcp` 的持续开发规范，供 AI Agent 与人类贡献者共同遵守。
定位一句话：**Godot 文本资源的纯文本读写工具**——不启动编辑器，直接解析与修改 `.tscn` / `.tres` / `project.godot` / `.gdshader` / `.gd`，仅在需要引擎语义时调用 Godot CLI。

---

## 1. 项目定位与差异化（必须坚持）

- 本项目是**独立设计**的 Godot MCP 工具，**不是**旧项目 `D:\Dev\Godot\godot-mcp` 的复制品。
- 与旧项目的根本区别：
  - 旧项目：单文件 + 外部 GDScript，**靠启动 Godot 引擎/编辑器**完成操作。
  - 本项目：分层架构 + 自研纯文本 AST 解析器，**文件驱动、不依赖编辑器**。
- 允许的"相同"：MCP 协议、stdio 通信、TypeScript 技术栈、Godot 官方文件格式。除此之外的相似都必须能解释清楚。
- 边界：不新增"启动/接管编辑器"类功能；编辑与静态分析优先，引擎相关能力走 `runtime_*`。

## 2. 硬性红线

1. **修改前先读源码和测试。** 不得在未读取相关实现与既有测试的情况下改动代码。
2. **禁止复制旧仓代码。** 不得为"复用"而直接搬运 `D:\Dev\Godot\godot-mcp` 的代码或 GDScript。跨仓参考仅用于理解需求。
3. **禁止凭记忆猜测 Godot 文件格式。** 涉及 `.tscn` / `.tres` / `project.godot` / `.gdshader` 时，必须以**真实样本**和**对应版本的实际行为**为依据；无法确认时先取得样本或标注"待验证"。
4. **核心能力必须有针对性测试。** Parser / Serializer / 文件修改类改动，必须附对应用例（含往返与边界）。
5. **编译通过 ≠ Godot 能加载。** 不得以 `tsc` 成功或单测通过，宣称产物可被 Godot 正常加载。
6. **不得修改旧仓。** `D:\Dev\Godot\godot-mcp` 只读。
7. **不得覆盖用户数据，不得执行破坏性 Git 操作**（`reset --hard` / `push --force` / 未经授权 `commit` 等）。提交、推送、发布一律需明确授权。

## 3. 工程原则

- 简单、实用、可维护、可测试优先；**避免过度设计与无收益的架构抽象**。
- 修改尽量**小而明确**，不做与任务无关的重构。
- 保持分层单向依赖：`MCP → Tool → Service → Core/Parser`（`godot` 层为独立适配层），由 `tests/architecture.test.ts` 强制。
- 工具命名遵守 `<domain>_<action>`，领域目录与 `domain` 字段一致；新增工具需在 `src/tools/index.ts` 的 `allTools` 登记。
- 写入路径必须经过既有安全设施：`FileGuard`（路径）、schema 校验、`safeWrite`（原子写）、`dryRun`/diff、`expectedHash`（乐观并发）。
- 错误通过稳定错误码（`src/types/index.ts` 的 `ErrorCode`，只追加不改名）与统一错误信封返回。

## 4. 交付约定

完成一项任务后，必须报告：

1. 修改了哪些文件、各自为什么；
2. 测试 / 构建结果（明确区分：已通过 / 已失败 / 未执行 / 无法验证及原因）；
3. 风险与未完成事项。

## 5. 已知限制（避免误报为能力）

- 解析器**不重算 `load_steps`**：增删 `ext_resource` 后该字段可能过期。
- "无损往返"目前仅对手写样例有测试；`tests/fixtures/sample_project` 真实样例缺失，相关用例被 skip。
- 文件级锁 `LockManager.withLocks` 尚未接入生产写路径。

## 6. 待决策事项（不要擅自改动）

- **Godot 目标版本尚未裁决（2026-10-12 记录）。** 代码对外声明 `4.7.2`（`package.json:4`、`src/tools/utility/ping.ts:12` 及其测试断言 `tests/mcpServer.test.ts:86`、解析器注释），但 README 徽章/示例与本机实测（`runtime_get_version` 返回 `4.6.3`）均为 `4.6.3`。
  - **在裁决前**：不要新增任何"兼容某版本"的声明；不要把 4.7.2 或 4.6.3 中的任一方当作既定事实写进新代码或新文档；如必须提及，标注为"待裁决"。

> 详细审计见 `docs/audits/PROJECT_DIFFERENTIATION_AUDIT.md`。
