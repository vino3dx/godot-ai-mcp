# PROJECT DIFFERENTIATION AUDIT

> 审计对象：`godot-ai-mcp`（新仓，本次主要审计对象）
> 对照对象：`godot-mcp`（旧仓，只读参考）
> 审计日期：2026-10-12
> 审计方式：本地源码逐文件读取 + 跨仓比对；**未使用任何代码相似度百分比工具**，所有相似判断均基于具体路径与行号证据。
> 结论标注约定：**【已验证】**= 直接读到源码/配置可复现；**【推测】**= 基于证据的合理推断；**【待验证】**= 需要运行或额外样本才能确认。

---

## 0. 执行摘要

**没有发现新仓复制旧仓代码的证据。** 两仓是同一作者（vino3dx）在同一领域（Godot MCP）上的两条独立实现路线：

- 旧仓 = 单文件 TS（`src/index.ts`，71.75 KB）+ 外部 GDScript，**靠启动 Godot 引擎/编辑器**完成任务，无测试、无文件写入安全机制。
- 新仓 = 分层 TS（`src/core|services|tools|mcp|godot`）+ 纯文本 AST 解析器，**不依赖编辑器**直接读写 Godot 文本资源，有 23 个测试与完整写入安全机制。

**新仓与"预期产品定位"总体吻合**（文件驱动、少编辑器控制、独立解析器与测试、命名规范统一）。发现的问题集中在**元数据/文档与实际不一致**、**少量死代码与跨文件重复**、以及**一处解析器能力缺口**，**没有发现方向性偏离或架构照搬**。

严重程度分布：Critical 0 · High 3 · Medium 6 · Low 4。

---

## 1. 两仓真实结构概览

### 1.1 新仓 `D:\Dev\godot-ai-mcp` 【已验证】

- 根目录：`src/`、`tests/`、`package.json`、`package-lock.json`、`tsconfig.json`、`README.md`、`LICENSE`、`.gitignore`。
- **没有 `docs/` 目录、没有 `.github/`、没有 `AGENTS.md`/`CONTRIBUTING.md`。**
- 源码：`src/` 共 54 个 `.ts`，分 `core/ services/ tools/<7 域>/ mcp/ godot/ types/`。
- 测试：`tests/` 23 个 `.test.ts` + `fixtures/`（仅 `godot-help.txt` + `README.md`，**无真实 Godot 样例工程**）。
- 构建：`tsc -p tsconfig.json` → `outDir: dist`（`tsconfig.json:6`）；入口 `src/index.ts`，bin 指向 `./dist/src/index.js`（`package.json:6-8`）。
- 测试框架：Node 内置 `node:test`；`npm test` = 先 build 再 `node --test "dist/tests/**/*.test.js"`（`package.json:14`）。
- Git：分支 `main`；远端 `origin`/`godot-ai-mcp` 均为 `git@github.com:vino3dx/godot-ai-mcp.git`【已验证】。
- ⚠️ **仓库当前处于未完成的交互式 rebase 中**（见 §9）。

### 1.2 旧仓 `D:\Dev\Godot\godot-mcp` 【已验证】

- 源码：`src/index.ts`（71.75 KB，单文件类 `GodotServer`）+ `src/scripts/godot_operations.gd`（48.97 KB GDScript）。
- 构建：`tsc && node scripts/build.js` → `outDir: ./build`；bin → `./build/index.js`。
- 构建辅助：`scripts/build.js`、`scripts/pack.js`、`scripts/setup-mcp.mjs`。
- **无测试、无 CI workflow、无 lint 配置**（`.github/` 仅 `FUNDING.yml`）。
- 依赖：`@modelcontextprotocol/sdk@0.6.0`（v1 风格 `setRequestHandler`）。
- Git：`origin` = `git@github.com:vino3dx/godot-mcp.git`，`upstream` = `git@github.com:Coding-Solo/godot-mcp.git` → **旧仓是上游的 fork**；`package.json` 仍标 `version 0.1.1` 但代码内自述版本为 `0.1.0`（三方不一致）。

---

## 2. 核心架构对比

| 维度 | 新仓 `godot-ai-mcp` | 旧仓 `godot-mcp` |
|---|---|---|
| 形态 | 分层多模块（54 文件） | 单文件巨类 + 1 个 GDScript |
| 入口 | `src/index.ts`（25 行组合根） | `src/index.ts`（71.75 KB） |
| 分层 | `MCP → Tool → Service → Core/Parser` + 独立 `godot` 层 | 无分层，全部内联在一个类 |
| 文件读写 | 自研**纯文本 AST parser/serializer**，不启编辑器 | 委托 Godot 引擎（`ResourceLoader`/`ResourceSaver`），经 GDScript |
| 编辑器依赖 | **无**（README:11 明确"No need to launch the editor"）【已验证】 | 核心依赖：`launch_editor`/`run_project` 均 spawn 引擎 |
| MCP SDK | `@modelcontextprotocol/server ^2.2.0` + `registerTool` | `@modelcontextprotocol/sdk 0.6.0` + `setRequestHandler` |
| 写入安全 | FileGuard 路径校验 + schema 校验 + 原子写 + dryRun/diff + expectedHash + 运行队列 | 仅 `validatePath` 拦 `..`；无原子写、无锁 |
| 并发控制 | `LockManager` + `TaskQueue`（项目级单进程） | 单例 `activeProcess`，先 kill 再起 |
| 错误体系 | 稳定错误码 `ErrorCode` + `GodotMcpError` + 统一信封 | `McpError`/`ErrorCode`（SDK 内置） |
| 测试 | 23 文件，`node:test`，含架构约束测试 | 0 |
| 架构约束执行 | `tests/architecture.test.ts` 扫描 import 强制分层 | 无 |

**架构对比结论：不存在"照搬"。** 两者的模块划分、调用链、状态管理方式没有共同点——旧仓根本没有"层"的概念。

**新仓分层真实性【已验证】**：`tests/architecture.test.ts:11-20` 定义 ALLOWED 依赖表并自动扫描 import，未发现反向依赖；工具层不直接 import `node:fs`（统一走 `ctx.file`）。但 README 的架构图**不准确**（见问题 M-4）。

---

## 3. 工具能力映射表

新仓 19 工具（`src/tools/index.ts:24-44`【已验证】）vs 旧仓 14 工具（`src/index.ts:668-927`）。

| 能力 | 旧仓工具 | 新仓工具 | 实现路径是否独立 |
|---|---|---|---|
| 取 Godot 版本 | `get_godot_version` | `runtime_get_version` | **独立**：新仓有 provenance(`source`)+可注入 runner（`godot/cli.ts:39-77,120-172`） |
| 运行项目 | `run_project` | `runtime_run_project` | **独立**：新仓受控 spawn + 运行队列（`runtimeService.ts:126,259`） |
| 停止/抓输出 | `stop_project`、`get_debug_output` | **无对应**（新仓改为截图 `runtime_capture_screenshot`） | — |
| 启动编辑器 | `launch_editor` | **刻意无**（符合定位） | — |
| 列项目 | `list_projects` | **无** | — |
| 项目信息 | `get_project_info`（读 `project.godot` 仅正则取 name） | `project_get_config`（**完整无损解析**） | **独立** |
| 改项目配置 | 无 | `project_set_config` | 新仓独有 |
| 建/改/存场景 | `create_scene`、`add_node`、`save_scene`（引擎侧） | `scene_get_tree`、`scene_update_node_property`、`scene_remove_node`（文本侧） | **独立**：旧仓让引擎改，新仓改文本 |
| 资源/依赖 | `load_sprite`、`export_mesh_library` | `resource_get_info`、`resource_update_property`、`resource_add_or_update_external` | **独立** |
| UID | `get_uid`、`update_project_uids` | **无独立工具**（解析时原样保留 UID） | — |
| 运行场景/导出 | 无 | `runtime_run_scene`、`runtime_export_project` | 新仓独有 |
| 脚本/Shader | 无 | `script_get_info`、`script_update_export_default`、`shader_get_info`、`shader_update_uniform_default` | 新仓独有 |
| 健康/状态 | 无 | `utility_ping`、`utility_task_status` | 新仓独有 |

**重叠度**：19 个新工具中，仅 2 个（版本、运行项目）与旧仓能力概念重叠；其余为不同能力或不同实现路径。**概念重叠全部可由"MCP 协议 + Godot 官方 CLI/文件格式契约"解释。**【已验证】

---

## 4. 代码相似度与疑似复制点

**结论：未发现复制嫌疑（文件级/函数级/字符串级/架构级/文档级/Git 历史级）。**【已验证】

| 检查维度 | 发现 | 证据 |
|---|---|---|
| 相同文件路径 | 仅 `src/index.ts` 同名，但 25 行 vs 71.75 KB，内容完全不同；旧仓**没有** `tools/`、`services/`、`core/`、`mcp/` 目录 | 两仓目录清单 |
| 逐字相同字符串 | 旧仓工具描述（`src/index.ts:672,686,722,731`）在新仓全库 grep **0 命中**；新仓特有串（`GODOT_NOT_FOUND`、`project root override` 等）在旧仓 **0 命中** | 双向 grep |
| 同名同逻辑函数 | 无。概念同为"查版本"，但旧仓 `handleGetGodotVersion()`（`index.ts:1226`）与新仓 `getGodotVersion()`（`godot/cli.ts:120`）实现完全不同 | — |
| GDScript 复用 | 旧仓 `godot_operations.gd`（12 个函数）在新仓**完全不存在**；新仓 `.gd` 文件数 = 0 | grep |
| 第三方 API | 两者都用 `@modelcontextprotocol/*`，但为**不同 major 版本**、不同 API 面 | `package.json` 对比 |
| Git 历史 | 新仓 reflog 全为 vino 的分阶段自建提交（P0→P1→逐 Service），**无任何"移植/复制"字样** | `.git/logs/HEAD` |

**唯一"同源"解释**：作者相同（vino3dx）、且都遵循 MCP 协议与 Godot 官方文件格式 → 属正常现象，不构成复制。

---

## 5. 合理重叠 vs 不合理重复

### 5.1 合理重叠（保留）
- 两仓都用 MCP 协议 / stdio / TypeScript / Godot 官方格式 —— 领域必然。【已验证】
- "定位 Godot 可执行文件 + 取版本" —— 任何 Godot MCP 都需要的通用基础设施。【已验证】
- 通用文件名（`package.json`/`tsconfig.json`/`README.md`/`LICENSE`）。【已验证】

### 5.2 实现路径独立（保留）
- 解析器、场景/资源/项目/脚本/Shader 服务、写入安全机制、并发队列 —— 新仓自研，旧仓不存在。【已验证】

### 5.3 设计重复（建议评估，非旧仓照搬）
新仓**内部**存在跨文件重复实现（见问题 M-5），与旧仓无关。

### 5.4 代码复制嫌疑
**无。**【已验证】

### 5.5 证据不足
- 新仓 git 的逐提交"新增文件清单"（`git log --diff-filter=A --name-only`）本次因环境限制未完整枚举；但 reflog 的提交语义已足以排除"初始提交直接引入旧仓文件"的模式。**【待验证】**

---

## 6. 新项目与预期定位的偏差

| 预期定位 | 实际 | 判定 |
|---|---|---|
| 面向 AI Agent 的项目理解/静态分析/工程化编辑 | 已实现纯文本解析 + 读写工具 | **符合** |
| 专用模块处理 config/scene/resource/script/shader/material | config/scene/resource/script/shader 已有；**material 尚无**（可视为未展开） | **基本符合** |
| 直接读写文件，少依赖编辑器 | 真实文件驱动，无编辑器 spawn | **符合** |
| 引擎相关操作走 CLI / Runtime Adapter | `runtime_*` 5 工具：run/scene/export/screenshot/version | **符合** |
| 文件正确性/安全/并发/测试/错误恢复 | FileGuard+schema+原子写+dryRun+diff+expectedHash+队列；23 测试 | **符合**（一处 `withLocks` 未接线，见 M-6） |
| 工具接口领域清晰/参数稳定/行为约定明确 | 7 域、`domain_action` 命名由 `toolRegistry.ts:3,10-11` 强制 | **符合** |

**是否沦为旧仓工具集复刻？否**【已验证】。是否含大量编辑器控制？**否**【已验证】。Parser/Serializer 是否独立设计与测试？**是**【已验证】。

**偏差项**：
1. 文档层面与实际能力不一致（工具数、版本、docs 引用）→ 见 High/Medium 问题。
2. `material` 领域尚未开展（非缺陷，属进度）。

---

## 7. 问题清单（证据 / 严重程度 / 修复建议）

### High

**H-1 README 工具矩阵与实际不一致** 【已验证】
- 证据：`README.md:44`（"Tool Matrix (15 tools)"）与 `README.md:136`（"当前工具矩阵（共 15 个）"）称 15 个；实际 `src/tools/index.ts:24-44` 注册 **19** 个，README 漏列 `runtime_run_project`/`runtime_run_scene`/`runtime_export_project`/`runtime_capture_screenshot`。
- 建议：更新 README 中英文两处工具数与矩阵，补 Runtime 分组。**低风险，应修**。

**H-2 Godot 目标版本声明自相矛盾** 【已验证】
- 证据：对外/格式依据侧 = **4.7.2**（`package.json:4`、`src/tools/utility/ping.ts:12`、`src/core/parser/types.ts:7`、`godotConfig.ts:3`、`godotResource.ts:3`、`tests/parser.test.ts:8`、`tests/fixtures/README.md:1,23,30`）；实测侧 = **4.6/4.6.3**（`src/godot/cli.ts:2,12,36,158`、`runtime/run.ts:10`、`runtime/screenshot.ts:5`、`tests/godotCli.test.ts:61-64`）；README badge/示例 = **4.6.3**（`README.md:3,9,84,176`）。
- 说明：本机实际安装并运行的是 **4.6.3**（`runtime_get_version` 实测 `4.6.3.stable.official`），但代码对外声明 4.7.2。
- 建议：**需你裁决**目标版本后统一；在此之前至少消除"同一文件内自相矛盾"。涉及对外契约（`ping.ts` 输出 + 其测试），属**中风险**，先给方案不擅改。

**H-3 README 引用的文档全部不存在** 【已验证】
- 证据：`README.md:104-109,196-201` 列出 `docs/HANDOFF.md`、`docs/AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/concurrency.md`；全仓仅 2 个 md（`README.md`、`tests/fixtures/README.md`），**`docs/` 目录不存在**。
- 建议：二选一——(a) 补齐这些文档（含本审计已新增的 `docs/audits/`）；(b) 修正 README 文档表使其与实际一致。**低风险**。

### Medium

**M-1 package.json 元数据缺失** 【已验证】
- 证据：`package.json` **无 `repository`、无 `author`、无 `bugs`/`homepage`**；`license: "MIT"`（`:17`）与 `LICENSE`（`Copyright (c) 2026 vino3dx`）一致。
- 建议：补 `repository`（URL 已确认：`https://github.com/vino3dx/godot-ai-mcp`）、`author: "Vino (https://github.com/vino3dx)"`、`homepage`。**低风险，应修**。

**M-2 README 徽章与实际不符** 【已验证】
- 证据：`README.md:5` 徽章 "Node.js 18+" vs `package.json:9-11` `engines.node >= 22`；`README.md:6` 徽章 "TypeScript 5.x" vs `package.json:21` `typescript ^6.0.3`。
- 建议：同步徽章为 Node 22+ / TypeScript 6.x（或以 `engines` 为准）。**低风险**。

**M-3 "无损往返"未经真实引擎样本证实 → 已于 2026-10-12 解决** 【已验证】
- 原证据：`tests/parser.test.ts:331-335` 的真实样例往返用例因 `tests/fixtures/sample_project` 不存在而**恒为 skip**；`tests/fixtures/README.md:4` 亦自述"样例尚未提供"。
- 现状：已补齐由 **Godot 4.6.3**（`4.6.3.stable.official.7d41c59c4`）实际写出的样例（`tests/fixtures/sample_project/`，来源与限制见 `tests/fixtures/SOURCE.md`）。该用例**已实际执行并通过**：`npm test` 172 用例 0 失败；设 `GODOT_BIN` 后 0 跳过。`project_set_config` 的 `dryRun` 对该真实样例输出**单行 diff**，未写入。
- 残留限制：样例头部无 `uid=`、无 `load_steps`（4.6.3 运行时保存不写），且未含继承场景 —— 详见 `tests/fixtures/SOURCE.md` 第四节。

**M-4 README 架构图与实际分层不符** 【已验证】
- 证据：README 图 `MCP→Tool→Service→Core/Parser→FileSystem`（`README.md:101,193`）(a) 缺独立 `godot` 层；(b) 不存在 `Core/Parser→FileSystem` 依赖——真实是 Service 同时依赖 `core/parser` 与 `core/filesystem`（`src/services/fileService.ts:6-7`）。
- 建议：修正架构图。**低风险**。

**M-5 解析器不更新 `load_steps` → 影响范围已缩小（2026-10-12 复核）** 【已验证】
- 证据：`src/services/resourceService.ts:75-76` 仅**读取** `load_steps`；`addOrUpdateExternalResource` 增删 `ext_resource` 后**不重算**（全仓 `load_steps` 命中仅 `resourceService.ts:53,75,76`）。
- 新证据：Godot **4.6.3 运行时保存不写出 `load_steps`**（实测：3 ext + 3 sub 的场景仍为 `[gd_scene format=3]`；注册 `ResourceUID` 亦不改变输出）。真实 4.6 工程 61 个 `.tscn` 中仅 **4 个**含 `load_steps`（旧写法遗留）。
- 结论：**对 4.6+ 新写出的文件，该缺口实际不触发**；仅在编辑「已含 `load_steps` 的旧文件」且增删资源时才会过期。
- 建议（降级）：优先补一个「编辑含 `load_steps` 的旧文件」的用例，而非直接重算逻辑。**低风险**。

**M-6 `LockManager.withLocks` 生产零调用（写了没用）** 【已验证】
- 证据：`withLocks` 仅定义于 `src/core/concurrency/lockManager.ts:60`，并被 `tests/concurrency.test.ts` 使用；`src/` 内**无生产调用点**（`taskQueue.ts:2,21` 只用了 `normalizeLockKey`/`newTaskId`）。即文件级加锁能力未接线到写路径，文件并发实际只靠 `expectedHash`。
- 建议：要么接入写路径，要么删除以消除"过度设计"信号。**低风险**。

**M-7 跨文件重复实现** 【已验证】
- 证据：`sceneService.ts:213-269` 与 `resourceService.ts:297-335` 中 `bodyValue`/`separatorOf`/`insertIndex`/`assertValidValue`/`decodeQuoted`/`attrValue` **几乎逐字重复**；`joinLines`（`scriptService.ts:135` / `shaderService.ts:143`）与注释切分逻辑（`scriptService.ts:110-133` / `shaderService.ts:114-137`）近似重复；6+ 测试文件重复 `lineDiff` 辅助函数。
- 建议：抽取共享 helper（`core/parser` 内），**避免无收益的大重构**——仅合并确属同义的部分。**低风险**。

### Low

**L-1 死代码** 【已验证】
- `src/core/output.ts:9,21` 的 `paginate`/`truncateText`：仅测试使用，生产零调用（注释称"所有 list 工具用这个"，实际 19 个工具无一使用）。
- `src/core/filesystem/fileGuard.ts:62` `FileGuard.contains`：`src/` 内零调用。
- `src/godot/runtime/run.ts:69` `RUNTIME_FLAGS`：`src/` 内零引用。
- 建议：确认用途（预留 or 遗留）后删除或接线。

**L-2 死错误码** 【已验证】
- `src/types/index.ts:6,8` 的 `VALIDATION_FAILED`、`RUNTIME_REQUIRED` 在全仓从未被抛出。
- 建议：删除或标注预留。

**L-3 `EDITOR_CONFLICT_WARNING` 无生产产生点** 【已验证】
- 定义于 `src/types/index.ts:46`、`toolHost.ts:39`，仅出现在 `tests/toolHost.test.ts:37,43`；无任何编辑器探测代码（符合"少编辑器控制"定位，但该 warning 形同虚设）。
- 建议：删除或实现真实编辑器占用探测。

**L-4 部分模块无测试** 【已验证】
- 无专门测试：`src/dev-cli.ts`、`src/core/logger.ts`、`sdkServer.ts` 的 `toSdkToolSchema`、`statusService.ts` 的"有锁占用"正例。
- 建议：按优先级补 `statusService` 正例与 `dev-cli` 冒烟。

---

## 8. 尚未验证的内容及原因

| 项 | 状态 | 原因 |
|---|---|---|
| `npm run build` | **已通过**【已验证】 | `tsc -p tsconfig.json` 无错误，退出码 0 |
| `npm test` | **已通过**【已验证】 | 172 用例 → **170 通过 / 0 失败 / 2 跳过**（默认环境） |
| `npm test`（设 `GODOT_BIN`=4.6.3 console） | **已通过**【已验证】 | 172 用例 → **172 通过 / 0 失败 / 0 跳过** |
| fixtures 真实样例往返 | **已通过**【已验证】 | `tests/fixtures/sample_project/`（真实 4.6.3 输出）逐字节 `serialize(parse(x)) === x`，用例已实际执行 |
| 引擎加载样例工程 | **已通过**【已验证】 | `godot --headless --path <sample_project> --quit-after 5` 退出码 0、无错误/警告 |
| 真实 Godot CLI 冒烟 | **已通过**【已验证】 | 设 `GODOT_BIN` = 本机 4.6.3 console 后跑 `dist/tests/runtime.real.test.js`：3/3 通过，含 `--headless --version` 退出码 0 与"截图最小工程并断言 PNG 头与尺寸" |
| 4.7.2 vs 4.6.3 真实目标版本裁决 | **待验证** | 仅依据代码注释文字，需用户裁决 |
| `load_steps` 错误是否导致 Godot 加载失败 | **待验证** | 需真实 Godot 实测 |
| `godot-help.txt` 由 4.6.3 还是 4.7.2 生成 | **待验证** | 未打开文件核对版本串 |
| 新仓逐提交新增文件清单 | **待验证** | 未运行 `git log --diff-filter=A --name-only` |
| `@modelcontextprotocol/server@^2.2.0` 与 `client@^2.2.0` 的真实存在性/稳定性 | **待验证** | 未核查 npm 元数据 |

---

## 9. 审计期间的仓库状态风险（重要）

**【已验证】** 审计时新仓处于**未完成的交互式 rebase** 中：

- `.git/rebase-merge/` 存在；`head-name = refs/heads/main`；`onto = b61959e`；`orig-head` = `a522d5f`；`done` 为空（**0/13 条命令已执行**）。
- `git-rebase-todo` 仍列出 13 条 `pick`，HEAD 仍为 `a522d5f`（rebase 尚未应用任何提交）。
- 存在 `.git-rebase-todo.swp` → **可能有编辑器会话仍打开在 rebase todo 上**。

**影响**：在此状态下修改**已跟踪文件**（如 `README.md`、`package.json`），会导致 `git rebase --continue` 因"存在未暂存改动"而拒绝继续。新增**未被跟踪的文件**（如本文件、根 `AGENTS.md`）不受影响。

**建议**：先结束该 rebase（在确认 todo 内容无误后 `git rebase --continue`，或 `git rebase --abort` 放弃），再进行已跟踪文件的修改。

---

## 10. 下一步最值得处理的三个问题

1. **H-2 版本声明统一**（需你裁决 4.6.x 还是 4.7.x 作为目标）——这是唯一涉及"对外契约 + 测试断言"的一致性问题，影响面最大。
2. **H-1 / H-3 / M-1 / M-2 / M-4 README+元数据一致性**——一次性把"文档说的"与"代码做的"对齐，成本低、收益直接。
3. **M-3 真实样例 + M-5 `load_steps`**——让"无损往返"从"对手写样例成立"升级为"对真实引擎产物成立"，这是本项目核心卖点的可信度基础。

---

## 附：审计范围与方法说明

- 本次审计读取了：两仓 `package.json`/`tsconfig.json`/`README.md`/`LICENSE`/`.gitignore`、新仓全部 `src/`（54 文件）与 `tests/`（23 文件）的结构与关键内容、旧仓 `src/index.ts` 与 `src/scripts/godot_operations.gd`、两仓 `.git/config` 与 reflog。
- 未修改旧仓任何文件。
- 所有行号引用均来自实际读取的当前文件内容；**未编造任何行号或相似度数值**。
