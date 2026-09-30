# 交接说明

## 当前状态
- **阶段 1 完成,并且这次是"跑通"而不是"推测通过"**:`npm run build`、`npm test` 全绿(18 个测试,含 2 个真实 MCP 客户端端到端用例)。
- 已完成:类型、Tool Registry(含分组按需加载)、ToolHost(校验+统一错误)、错误、Logger(stderr)、LockManager / TaskQueue、最小工具(`utility_ping`、`utility_task_status`)、分层守卫测试、`dev-cli`。
- **T0 已完成**:依赖已安装,`src/mcp/server/sdkServer.ts` 已按真实 `.d.mts` 重写(不再用 `any`,不再有占位 schema),并用官方 `@modelcontextprotocol/client` 经 stdio 验证了连接、`tools/list`(JSON Schema 真的上线)、`tools/call`、统一错误信封。legacy(2025 `initialize`)与 modern(2026-07-28 `server/discover`)两个 era 都验证过。
- 已核实的 SDK 事实(版本、`serveStdio`、Standard Schema 契约、注解字段名、schema 桥接为何不做拒绝)都写在 `docs/architecture.md` 的「MCP 适配层」一节。**别凭记忆改这部分。**

## 给接力模型的固定规则(每次任务开头贴上)
1. 先读 `AGENTS.md`、`docs/architecture.md` 和本文件,只做**被分配的那一张任务卡**,不要顺手做别的。
2. 改完必须 `npm test` 全绿;`tests/architecture.test.ts` 不许改弱、不许绕过。
3. 不要修改 `src/core/concurrency/`、`src/mcp/`、`tests/architecture.test.ts`,除非任务卡明确要求。
4. Tool 里不写文件/解析逻辑,只调 Service。不确定 4.7.2 文件格式细节时,以 `tests/fixtures` 里的真实文件为准,没有就停下来问,不要凭记忆写。
5. 不新增依赖(除非任务卡说明);不使用 `console.log`;失败一律抛 `GodotMcpError`。
6. 完成后回报:改了哪些文件、新增了哪些测试、哪些事没做。

## 你需要先做的一件事:提供 4.7.2 真实样例
在你的机器上用 Godot 4.7.2 新建一个小项目,把这些文件放进 `tests/fixtures/`:
`project.godot`、一个含多种节点/子资源/信号连接/实例化子场景的 `.tscn`、一个 `.tres`(Material 和 Shader 各一个)、一个 `.gdshader`、一个 `.gd`、一个带 `.uid` 的资源。
解析器的正确性完全取决于它们;没有它们,任何模型写出来的解析器都只是猜测。

## 任务卡

| # | 任务 | 验收 | 风险 | 建议由谁做 |
|---|---|---|---|---|
| ~~T0~~ | ~~装依赖、核对并修正 `sdkServer.ts`、用真实客户端验证~~ | **已完成** | — | — |
| T1 | `project.godot` 无损解析/序列化(保留注释、顺序、未知段) | 往返测试:读→改一个键→写→再读,其余字节不变 | 中 | 强模型或你审核后的 Flash |
| T2 | `.tscn/.tres` 无损解析/序列化(段头属性、ext_resource/sub_resource id、UID、Variant 文本原样保留) | 用 fixtures 做往返;改一个节点属性后 diff 只有该行 | **高,全项目最关键** | 强模型(GLM-5.3 级别或 Claude) |
| T3 | `FileGuard`(路径限制在项目目录内、`res://` 与 `user://` 转换)+ 文件扫描/读写/搜索 Service 与 `filesystem_*` `project_*` 工具 | 路径穿越用例被拒;写操作经 `LockManager` | 低 | Flash |
| T4 | UID:`.uid` 与资源头部 UID 的查询、引用检查、缺失检测 | 用 fixtures 通过 | 中 | Flash + 强模型审核 |
| T5 | `ShaderService`:通用 `ShaderParameter{name,type,defaultValue,hint,hintRange}` 模型,uniform 增删改/分析、render_mode、基础检查 | 每个 uniform 类型/hint 有测试 | 中高(设计决定后续扩展) | 强模型设计 + Flash 补工具 |
| T6 | `MaterialService`:ShaderMaterial/StandardMaterial3D 读写、参数绑定/同步、重复检测 | 往返 + 用 T2 的写入器 | 中 | 强模型 |
| T7 | 场景/节点工具批量(node_* / scene_*) | 基于 T2 的服务;每工具"改前→工具→改后→再解析" | 低~中 | Flash(有 T2 之后) |
| T8 | Runtime Adapter:Godot 路径检测、CLI 启动、输出解析、项目级运行队列、`--dump-extension-api` 缓存 | 用假进程测试队列/超时/abort;真实 Godot 测试单独标记可跳过 | 中高(进程管理) | 强模型 |
| T9 | 阶段 8 整理:`docs/tools.md` 生成、命名/schema/返回结构一致性检查 | 有脚本自动检查 | 低 | Flash |

**顺序**:提供 fixtures → T1/T2 → T3/T4 → T5 → T6 → T7 → T8 → T9。T2 没有完成前,不要开始 T5~T7。

## 分工建议
- **按风险分,不按模型名分**:设计性、易出错、难验证的(T2、T5、T6、T8)交给最强的可用模型;有现成模板、有明确验收的机械活(T3、T7、T9)交给 Flash 类模型。
- 每张任务卡单独开一次对话,粘贴"固定规则"+ 任务卡 + 相关文件,做完你本地跑 `npm test` 再进入下一张。

## 环境备注
- 目标 Godot 版本 4.7.2;当前沙箱**没有** Godot 可执行文件,真实 Runtime 测试(T8)需要你在本机跑。
- 本机已装 Node 22.22.2;`npm install` 可用(有网络)。构建产物在 `dist/`,入口 `dist/src/index.js`。
- 仓库尚未 `git init`。开工前建议先初始化并提交阶段 1 基线,便于后续每个任务卡独立回滚。
