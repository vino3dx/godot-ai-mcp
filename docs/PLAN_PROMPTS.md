# godot-ai-mcp 路线图与接力提示词

## 使用方式
1. 每个阶段新开一次对话,说一句:执行 `docs/PLAN_PROMPTS.md` 里的 `P<编号>`,开工前读 `docs/WORKFLOW.md`。
2. 做完本地跑 `npm test`,把模型的回报 + `git diff --stat` + 测试输出贴给 Claude 验收,通过再进下一阶段。
3. 验收不过:把 Claude 的问题清单原样贴回给该模型修,不要换阶段。
4. 模型分工按风险:P3a / P3b / P5 / P6 / P9 用强模型(GLM-5.3),其余 Flash 即可。

## 阶段总览

| 阶段 | 内容 | 对应原任务卡 | 模型 | 前置 |
|---|---|---|---|---|
| P0 | 仓库清理 + 你提供 fixtures / extension_api / godot --help | — | Flash + 你 | — |
| P1 | 基础设施:项目解析、FileGuard、原子写、dryRun/diff、乐观并发、分页、错误码补全 | T3 前半 | Flash | P0 |
| P1b | 跨进程磁盘锁(可选,多 agent 同时连时才需要) | — | Flash | P1 |
| P2 | project.godot 无损解析 + project_* 工具 | T1 | Flash | P1 + fixtures |
| P3a | .tscn/.tres 无损解析与序列化 | T2 | 强模型 | P2 |
| P3b | Variant 文本编解码 | (新增) | 强模型 | P3a |
| P4 | filesystem_* + UID/.import + 引用检查与移动修复 | T3/T4 | Flash | P3a |
| P5 | Shader | T5 | 强模型设计 + Flash 补工具 | P3a |
| P6 | Material | T6 | 强模型 | P5 |
| P7a | 引擎类元数据(extension_api 静态加载) | (新增) | Flash | P0 |
| P7b | Scene / Node 工具 | T7 | Flash | P3b + P7a |
| P8 | Script | (新增) | Flash | P7b |
| P9 | Runtime Adapter + Debug | T8 | 强模型 | P4 |
| P10 | 整理、文档、客户端接入 | T9 | Flash | 全部 |

---

## 通用规则

通用规则见 `docs/WORKFLOW.md`,开工前先读。

---

## P0 仓库清理 + 你要先准备的材料

**你自己做(阻塞项,没有这些后面全是猜):**
- 用 Godot 4.7.2 新建一个小项目,放进 `tests/fixtures/sample_project/`,至少包含:`project.godot`(含 autoload、input map、layer 名、main scene)、一个 `.tscn`(多种节点、子资源、信号连接、groups、unique name、脚本挂载、实例化子场景、一个继承场景)、`.tres`(ShaderMaterial、StandardMaterial3D 各一个)、`.gdshader`(含多种 uniform 与 hint)、`.gd`、带 `.uid` 的资源、一个 `.import` 文件。节点属性里要出现:Vector2/3、Color、Transform3D、NodePath、Array、Dictionary、PackedVector3Array、ExtResource/SubResource 引用。
- 生成类元数据:`godot --headless --dump-extension-api`,把得到的 `extension_api.json` 放到 `data/extension_api-4.7.2.json`(体积可能很大,可 gzip 成 `.json.gz`,读取用 node 内置 zlib)。
- 保存 `godot --help` 全文到 `tests/fixtures/godot-help.txt`。
- 保存一份真实运行日志(含一条脚本报错、一条 warning)到 `tests/fixtures/godot-run-log.txt`。

**提示词(Flash):**

```text
任务 P0:仓库清理,不改任何功能代码。
1. .gitignore 追加 dist/、.workbuddy/、.godot-ai-mcp/;`git rm -r --cached dist .workbuddy` 取消误提交的产物;提交已 staged 的 LICENSE。
2. README.md 里 AGENTS.md 的路径改为 docs/AGENTS.md;确认 .gitattributes 为 `* text=auto eol=lf` 且 tests/fixtures 下的文件不会被改写换行(必要时加 `tests/fixtures/** -text`)。
3. 新建 tests/fixtures/README.md,按 docs/HANDOFF.md 的「你需要先做的一件事」列出 fixtures 清单与来源要求(必须来自真实 Godot 4.7.2 输出)。
4. 验收:npm test 全绿;`git status` 干净;dist/ 与 .workbuddy/ 不再被跟踪。
```

Claude 验收要点:`git ls-files | grep -E "^(dist|\.workbuddy)/"` 无输出;测试数仍为 18。

---

## P1 基础设施 ✅ ad90372

```text
任务 P1:写操作与路径的基础设施(不实现任何领域工具)。
1. errors/types:ErrorCode 只追加 PROJECT_NOT_FOUND、RESOURCE_NOT_FOUND、GODOT_NOT_FOUND、GODOT_PROCESS_FAILED、VALIDATION_FAILED、FILE_CHANGED。ToolOutput 增加可选 `warnings?: string[]`,ToolHost 与 toMcpContent 透传(EDITOR_CONFLICT_WARNING 这类走 warnings,不是错误)。允许为此修改 src/mcp/server/toolHost.ts,并补测试。
2. core/project/projectResolver.ts:确定项目根。优先级:工具参数 projectPath > 环境变量 GODOT_PROJECT_PATH > 从 cwd 向上查找 project.godot。找不到抛 PROJECT_NOT_FOUND。返回规范化绝对路径,挂到 AppContext。
3. core/filesystem/fileGuard.ts:res:// ↔ 绝对路径互转;拒绝路径穿越(..)、符号链接逃逸、项目外绝对路径、user://(报明确错误);处理 Windows 反斜杠与大小写。
4. core/filesystem/safeWrite.ts:原子写(同目录临时文件 + rename,Windows 下失败少量重试);统一 LF;可选 `expectedHash`(原内容 sha256),不匹配抛 FILE_CHANGED;可选 `dryRun`:不落盘,返回 { changed, diff }。diff 自己实现简单行级 unified diff,不新增依赖。
5. core/output.ts:`paginate(items,{limit,offset})` 与 `truncateText(text,maxBytes)`,返回 { items,total,nextOffset } / { text,truncated }。
6. docs:architecture.md 增加「写操作约定」一节:所有写工具统一带 `dryRun?: boolean`、`expectedHash?: string`,返回 { changed, diff?, newHash };所有 list 类工具带 limit/offset。concurrency.md 增加:锁不可重入,Service 只在公共入口加锁,内部私有方法不得再次加同一把锁。
验收:路径穿越/符号链接/Windows 路径用例被拒;原子写在中途异常时不留半截文件;expectedHash 不匹配被拒;dryRun 不改文件;architecture.test.ts 不动。
```

Claude 验收要点:safeWrite 的异常路径是否清理临时文件;fileGuard 对 `res://../x` 的处理;diff 对空文件/无换行结尾的处理。

---

## P1b 跨进程磁盘锁(可选)

> 判断:每个 agent(Claude Code、Cursor、WorkBuddy…)通常各自起一个 stdio 进程,进程内锁管不到彼此。你只会同时连一个 agent 就跳过本阶段。

```text
任务 P1b:跨进程磁盘锁,最小实现。
1. 新增 src/core/concurrency/diskLock.ts(本任务允许在该目录新增文件并最小改动 lockManager 以接入,现有测试不得改弱)。
2. 锁文件:<项目根>/.godot-ai-mcp/locks/<sha1(key)>.lock,内容 JSON { pid, host, tool, target, taskId, since }。用 `wx` 独占创建;等待用 100~250ms 带抖动轮询,受 timeoutMs 约束。
3. 持有期间每 5s 更新 mtime 作心跳;stale 判定:同 host 且 pid 不存在,或 mtime 超过 TTL(默认 30s)→ 回收。释放删除文件;进程 exit 时同步清理自己持有的锁。
4. LockManager.withLocks 增加可选 `crossProcess: true`:先拿进程内锁再拿磁盘锁;TaskQueue 的项目级运行队列同样支持。超时错误的 details 附上锁文件里的占用者信息。
5. 测试:同进程两个 DiskLock 实例模拟双进程;一个 child_process 真实双进程互斥用例;stale 回收用例(伪造死 pid)。
6. docs/concurrency.md 更新范围说明,注明网络盘不保证。
```

---

## P2 project.godot 解析 + Project 工具(T1)

```text
任务 P2:project.godot 无损解析与 project_* 工具。格式只以 tests/fixtures/sample_project/project.godot 为准。
1. core/parser/projectGodot.ts:保留原文本(注释、空行、顺序、未知段、多行值)。提供 get/set/remove key、新增 section。只改一个键时,字节 diff 仅该键所在行。
2. services/projectService.ts + tools/project/:project_get_info(名称、main scene、features、config_version、autoload 摘要)、project_get_setting、project_set_setting、project_list_autoloads/add/remove(autoload 值的前缀写法以 fixtures 为准)、project_list_input_actions、project_remove_input_action、project_set_input_action_raw(事件值作为原样 Godot 文本写入,只做括号/引号平衡检查,不解析内部结构)。
3. 写工具全部遵守 P1 的写操作约定(dryRun / expectedHash),并经 LockManager 加写锁。工具总数不超过 10 个。
验收:往返字节级相等;改一个键 diff 只有一行;含多行值的 fixtures 往返无损;写入经锁;错误一律 GodotMcpError。
```

---

## P3a .tscn/.tres 无损解析与序列化(T2,全项目最关键)

```text
任务 P3a:.tscn/.tres 无损解析与序列化。这是全项目最关键的一环,宁慢勿猜。
依据:tests/fixtures 的真实文件,以及 Godot 4.7.2 源码 scene/resource_format_text.cpp(.MEMORY.md 里有地址与已核实的字段顺序)。
1. core/parser/tscn.ts:解析段头 gd_scene / gd_resource / ext_resource / sub_resource / node / connection / editable / resource;属性行 `key = value` 的值保留为原始字符串。多行值边界用"括号与引号平衡扫描",必须正确处理字符串内的括号与转义、&"StringName"、^"NodePath"、Dictionary、Packed*Array(...)、Object(...)。
2. 文档模型保留:段头属性顺序、空行、注释、未知字段、各 id、uid。未被修改的段逐字节原样输出,只重写被改动的段。
3. 编辑 API(只做模型层,不做 Tool):setNodeProperty、addNode、removeNode(连带子节点与相关 connection)、renameNode(同步更新子节点 parent 路径与 connection from/to)、reparentNode、addExtResource(复用已有同路径同类型条目)、addSubResource。新增 id 的生成规则对照 fixtures 与源码,不得改动已有 id。
4. load_steps:对照 fixtures 与源码得出"修改后是否需要更新"的结论,写入 docs/architecture.md;不确定就停下来问我。
5. 测试:每个 fixtures 文件原样往返字节相等;改一个节点属性后 diff 只有一行;删除/重命名节点后 connection 与 parent 路径一致;损坏文件抛 PARSE_ERROR 并带行号。
```

Claude 验收要点:是否真用了 fixtures 而不是自造文本;renameNode 是否漏掉 `node_paths` / 其他 NodePath 引用(这个我会专门查)。

---

## P3b Variant 文本编解码

```text
任务 P3b:Variant 文本编解码(core/parser/variant.ts)。格式依据 fixtures 与 4.7.2 源码中的 variant 文本写入/解析实现(先确认源码里的实际文件路径,不要凭记忆)。
1. parse(raw) → 轻量 AST;format(typedJson) → raw。覆盖:Vector2/2i/3/3i/4、Color、Rect2、Transform2D/3D、Basis、Quaternion、AABB、NodePath、StringName、Array、Dictionary、Packed*Array、ExtResource("id")、SubResource("id")、数字/布尔/字符串。
2. 遇到不认识的类型:原样保留,不报错、不丢失。只有"生成新值"时才走 typed JSON → raw。
3. 工具入参约定写进 docs:agent 可传 (a)Godot 原样文本,经平衡检查后写入;(b)typed JSON,如 {"type":"Vector3","value":[0,1,0]}。数字显示格式严格对照 fixtures,不要自创。
4. 测试:fixtures 里出现的每个 Variant 值 parse → format 后与原文逐字相同。
```

---

## P4 Filesystem + UID + 引用(T3/T4)

```text
任务 P4:filesystem_* 与 UID/引用服务。
1. filesystem_list(glob,分页)、filesystem_read(大小上限,超限 truncated)、filesystem_write(dryRun/expectedHash)、filesystem_delete(destructive,同时处理 .uid 与 .import 伴随文件)、filesystem_search(文本搜索,限制结果数)。
2. UID:读取 .uid 文件与资源头 uid;uid → 路径查询;检测缺失与重复。新建资源是否要写 uid:先查 4.7.2 源码 core/io/resource_uid.cpp 与 fixtures 再决定;没把握就新建文件不写 uid,并在回报里说明。
3. asset_find_references(谁引用了某资源,含 ext_resource 路径与 uid)、filesystem_move(移动/重命名文件,同步移动 .uid/.import 并修复所有 .tscn/.tres/project.godot 中的引用)、project_validate(静态检查:ext_resource 路径存在、uid 一致、脚本/shader 存在、节点 parent 合法)。
4. 所有写入走 P1 写约定与锁;多文件修改用 withLocks。
验收:路径穿越被拒;move 后引用全部可解析且 diff 只含被改引用;project_validate 在 fixtures 上零误报,并能检出人为制造的坏引用。
```

---

## P5 Shader(T5)

```text
任务 P5:ShaderService。先设计,再写工具;设计写进 docs/architecture.md 的 Shader 一节,我确认后你再继续。
1. 通用模型 ShaderParameter { name, type, defaultValue, hint, hintRange, group, instance, global }。文本级解析 .gdshader:shader_type、render_mode、uniform(含 group_uniforms、instance、global、hint_range、source_color 等 hint)、注释保留。uniform 类型与 hint 的合法清单以 Godot 4.7.2 官方文档/源码为准,在 docs 里写出来源。
2. 工具:shader_create(按 spatial / canvas_item / particles / sky / fog 的最小模板)、shader_get_info、shader_list_uniforms、shader_add_uniform / shader_set_uniform / shader_remove_uniform、shader_set_render_mode、shader_check(静态:括号匹配、shader_type 存在、uniform 重名、基础结构)。完整编译不在本阶段(P9)。
3. 文本改动最小 diff;遵守写约定与锁。
验收:每种 uniform 类型/hint 有测试;往返不破坏注释与格式;shader_check 对 fixtures 零误报。
```

---

## P6 Material(T6)

```text
任务 P6:MaterialService(基于 P3a 的 .tres 解析器,外部 .tres 材质优先)。
工具:material_create(ShaderMaterial / StandardMaterial3D)、material_get、material_set_param(shader 参数的属性名前缀与写法以 fixtures 为准)、material_sync_shader(shader uniform 增删后同步:新增写默认值、孤立参数报告、类型不匹配警告)、material_find_duplicates(内容 hash)。
验收:往返无损;sync 后 diff 只含相关行;shader 引用经 ext_resource 且 id 复用正确。
```

---

## P7a 引擎类元数据

```text
任务 P7a:core/resources/classDb.ts,静态加载 data/extension_api-4.7.2.json(或 .gz)。
1. 先检查这个 JSON 实际有哪些字段(类、继承、属性、信号、方法、枚举、api_type 等),把"能提供什么 / 不能提供什么"写进 docs;不要假设有属性默认值或编辑器专属类。
2. 提供:类是否存在、继承链、isInstanceOf、属性名与类型、信号列表、枚举。懒加载并缓存。
3. 工具:node_search_types(关键字搜索)、node_describe_type(类的属性/信号/父类)。
验收:Node3D → Node 继承链正确;未知类返回 RESOURCE_NOT_FOUND;加载耗时与内存在文档里记录。
```

---

## P7b Scene / Node 工具(T7)

按三个小提交做,一次只贴一个子步骤。

```text
任务 P7b-1:scene_* 工具(基于 P3a/P3b/P7a)。
scene_create(根节点类型经 classDb 校验)、scene_get_tree(精简树,depth/limit 参数控制输出)、scene_list、scene_instantiate(把另一个 .tscn 作为子节点实例化,走 ext_resource)。
```

```text
任务 P7b-2:node_* 基础工具。
node_add(类型经 classDb 校验)、node_remove、node_rename、node_reparent、node_get_properties、node_set_property(值经 Variant codec;属性名不在 classDb 中时给 warnings,不拒绝,因为脚本导出变量不在引擎类里)。
```

```text
任务 P7b-3:node_* 进阶工具。
node_set_script(新增 ext_resource + 设置 script 属性)、node_add_to_group / node_remove_from_group、node_connect_signal / node_disconnect_signal(信号名经 classDb 或脚本大纲校验,connection 段写法以 fixtures 为准)。
```

三个子步骤的共同验收:每个工具"改前解析 → 工具 → 改后再解析"断言;diff 仅含预期行;写入均走锁与 dryRun/expectedHash。

---

## P8 Script

```text
任务 P8:ScriptService。注意:这不是完整 GDScript 解析器,只做轻量大纲,文档里必须写明。
1. script_create(extends、class_name、模板。生成的 GDScript 用制表符缩进;函数与 @export 变量上方用 `##` 文档注释,普通注释用 `#`)。
2. script_get_outline(行级/缩进感知解析:class_name、extends、signal、@export 变量、const、enum、func、内部类)。
3. script_patch_function(按函数名 replace / insert_after / append,保持缩进)、script_set_content(dryRun/expectedHash)、script_check(静态:tab/空格混用、括号平衡;完整检查留给 P9 的 runtime_check_script)。
4. 4.7.2 下 .gd 伴随的 .uid 文件以 fixtures 为准处理(创建/移动/删除时同步)。
验收:大纲在 fixtures 的 .gd 上与人工核对一致;patch 后其余字节不变。
```

---

## P9 Runtime Adapter + Debug(T8)

```text
任务 P9:Runtime Adapter(src/godot/cli、src/godot/runtime),独立可插拔,普通文件级工具不得依赖它。
1. Godot 路径检测:工具参数 > 环境变量 GODOT_PATH > PATH 中的 godot/godot4(含 Windows 的 .exe)。找不到抛 GODOT_NOT_FOUND;用 `--version` 校验为 4.7.2,不一致给 warnings。
2. 进程管理:child_process.spawn,参数用数组,不走 shell;输出缓冲有上限;超时用 AbortSignal 杀进程(含 Windows 子进程树);所有路径都释放 TaskQueue。
3. CLI 选项一律以 tests/fixtures/godot-help.txt 为准,不要凭记忆写。日志解析以 tests/fixtures/godot-run-log.txt 为样本。
4. 工具:runtime_get_version、runtime_check_script、runtime_validate_project、runtime_run_scene(带超时与自动退出)、runtime_run_script、runtime_reimport、debug_get_last_log。export 与截图不在本阶段,若 --help 里没有可用选项就不做,写进回报。
5. 所有运行经 TaskQueue.runExclusive;排队时返回当前占用者(tool、taskId、已占用时间、队列位置);utility_task_status 增加运行中进程信息(pid)。
6. 测试:用 node 脚本伪造 godot 可执行文件测试排队/超时/abort/崩溃释放;真实 Godot 用例在没有 GODOT_PATH 时自动跳过。
```

Claude 验收要点:超时后子进程是否真被杀(Windows 尤其);伪 godot 崩溃后队列是否继续。

---

## P10 整理与接入

```text
任务 P10:第一版整理。
1. scripts/ 下写自动检查并接入 npm test:工具名符合 `领域_动作`;每个入参都有 description;写工具的 annotations 非 readOnly,删除类标 destructive;所有 list 类工具带 limit/offset;返回结构统一。
2. 由注册表自动生成 docs/tools.md(含 Runtime Required 列),不手写。
3. README:各客户端接入示例(命令 `node <绝对路径>/dist/src/index.js`;JSON 配置的 command/args/env 写法;环境变量 GODOT_AI_MCP_GROUPS、GODOT_PROJECT_PATH、GODOT_PATH、GODOT_AI_MCP_LOG)。
4. docs/editor-conflict.md:说明 Godot 编辑器同时打开同一文件的风险与建议(改前先关闭该场景/脚本标签;用 expectedHash 检测外部改动)。不引入 Editor Plugin。
5. 统计工具总数,超过 60 个就在回报里列出可合并/可删的候选。
```

---

## 明确不做(防范围膨胀)
编辑器 UI、Undo/Redo、二进制 .res/.scn、Editor Plugin、截图与 export(除非 P9 确认 CLI 支持)、MCP Resources/Prompts、第二版领域(Animation / UI / TileMap / Particle / Navigation / Audio / Import Settings)。第一版全部验收后再单独立项。
