# godot-ai-mcp

开发一个独立的 MCP Server 项目:**godot-ai-mcp**。

目标:构建一个面向 **Godot 4.7.2** 的、模块化、可扩展的 AI MCP 工具集,让 AI agent 在不启动 Godot 的情况下完成绝大多数项目开发操作。

---

## 一、核心要求

* 唯一目标版本:Godot 4.7.2。不为旧版本做兼容分支。
* MCP Server 独立运行,不依赖 Godot Editor / Godot Runtime。
* 默认通过文件系统、Godot 文本资源格式(`.tscn` `.tres` `project.godot` `.gdshader` `.gd`)完成操作。
* 不使用 Godot Editor Plugin,也不实现 Undo/Redo 和"活的场景树"。
* 只有必须运行 Godot 才能完成的能力,才通过独立的 Runtime Adapter 调用 Godot CLI。
* MCP 协议层、工具层、服务层、核心/解析层、Runtime 层必须解耦。
* **不设工具数量目标。** 工具数量由能力决定:第一版预计 40~60 个,全部扩展完成后可能接近 100 个。不为凑数拆分或重复工具。
* 优先简单、可靠、可维护。不要过度设计,不要重复造轮子。
* 工具按领域分组,支持按需加载分组,避免工具列表一次性占满 agent 上下文。
* MCP SDK 使用当前最新稳定版(先查询确认版本,不要沿用旧的 0.6.0)。
* stdio 传输时,日志只能写 stderr,绝不能污染 stdout。

---

## 二、参考资料与取舍

### 1. godot-mcp(Coding-Solo,MIT)
以下 14 个能力必须全部保留(名称可统一改写):
launch_editor、run_project、get_debug_output、stop_project、get_godot_version、list_projects、get_project_info、create_scene、add_node、load_sprite、export_mesh_library、save_scene、get_uid、update_project_uids。

只复用它的 **Godot 可执行文件路径检测** 和 **CLI 启动逻辑**,放入 Runtime 层。其余按新架构重写。

### 2. godot-mcp-toolkit-main.zip(NPGameDev,MIT,约 100 个命令)
先分析,再取舍,不复制其架构。分三类处理:

| 类别 | 内容 | 处理 |
|---|---|---|
| A 文件/资源级 | tileset、spriteframes、procedural(曲线/渐变/噪声)、audiobus、theme、texture/sound generate、resource、classdb、input_map、project 设置与 layer names、script.check、file/folder、导航/路径编辑 | 全部重新实现为纯文件版本 |
| B 活场景树 + Undo/Redo | scene.*、node.*、signal、animation、autoload、editor.*、debug 断点 | 只实现"读 .tscn → 修改 → 写回"的版本,放弃 Undo 和编辑器实时同步 |
| C 运行中的游戏 | game.start/stop、playtest、输入注入、runtime 状态 | 只保留 run / stop / debug output / 截图,由 Runtime Adapter 实现 |

注意:
* toolkit 的桥接包 `@npgamedev/godot-mcp-server` 不在压缩包内,其 schema 需要自行设计。
* 如果改写自 toolkit 的代码,在 `ATTRIBUTIONS.md` 中保留 NPGameDev 的 MIT 版权声明;godot-mcp 同理。
* 先输出"toolkit 命令 → 新工具"的映射表,再开始实现相关阶段。

---

## 三、能力范围

| 范围 | 内容 |
|---|---|
| **第一版必须覆盖** | 项目、文件系统、场景/节点、资源、Shader/Material、脚本、运行与调试 |
| **第二版再做** | 动画、UI/Theme、TileMap/TileSet、粒子、导航、音频、导入设置修改 |
| **明确不做** | 编辑器 UI 操作、Undo/Redo、二进制资源(`.res` `.scn`)编辑、Godot Editor Plugin |

### 已知边界(必须写入 docs 并在工具返回中体现)
* **Shader 语法检查:** 无 Godot 时只做基础静态检查(括号匹配、uniform 声明、render_mode 合法性、shader_type)。完整编译检查必须走 Runtime。
* **导入设置:** 直接修改 `.import` 文件后,需要 Godot 编辑器或 CLI 重新导入才生效。
* **export_mesh_library:** 必须通过 Runtime 完成。
* **与编辑器的冲突:** 如果 Godot 编辑器同时打开了同一个场景/脚本,直接改磁盘文件可能被编辑器覆盖或触发重载。文档中要写明,返回结果里在可检测时给出提示。
* **格式细节:** `.tscn/.tres` 的具体格式(头部字段、`load_steps`、UID 写法、Variant 文本形式等)必须以 4.7.2 实际生成的文件为准,不得凭记忆假设。不确定时先说明,再验证。

---

## 四、目标结构

```
godot-ai-mcp/
├─ src/
│  ├─ mcp/
│  │  ├─ server
│  │  ├─ registry
│  │  └─ schemas
│  ├─ core/
│  │  ├─ project
│  │  ├─ filesystem
│  │  ├─ resources
│  │  ├─ parser
│  │  ├─ validation
│  │  └─ concurrency   # LockManager / TaskQueue
│  ├─ services/        # SceneService / ShaderService / MaterialService ...
│  ├─ godot/
│  │  ├─ cli
│  │  └─ runtime
│  ├─ tools/
│  │  ├─ project  scene  node  resource  script
│  │  ├─ shader  material  animation  filesystem
│  │  ├─ asset  debug  runtime  utility
│  └─ types/
├─ tests/
├─ docs/
└─ package.json
```

### 分层原则

```
MCP Layer
  ↓
Tool Layer        只负责 MCP 输入输出、参数校验、业务编排
  ↓
Service Layer     业务逻辑(SceneService / ShaderService ...),并发锁在这一层
  ↓
Core / Parser / Resource Layer
  ↓
FileSystem / Godot CLI
```

示例:`create_scene → SceneTool → SceneService → TscnSerializer → FileSystem`。
不要在 Tool 中直接写大量文件处理代码。

### 禁止
* Tool → Tool
* Tool → Godot Plugin
* Core → MCP
* 普通 Resource 操作 → Runtime

Runtime 是可插拔 Adapter,核心 MCP 不依赖它。

### Tool Registry
新增工具只需要:1. 创建 Tool;2. 定义 schema;3. 注册。**不修改 MCP Server 核心代码。**
Registry 需支持:领域分组、按组按需加载、只读/写入/破坏性标注、是否需要 Runtime。

### 统一约定
* 工具命名统一(`领域_动作`,例如 `scene_create`、`shader_add_uniform`)。
* 参数 schema、返回结构、错误结构统一。
* 错误带稳定错误码和可读信息(例如 `FILE_NOT_FOUND`、`PARSE_ERROR`、`LOCK_TIMEOUT`、`RUNTIME_REQUIRED`)。

---

## 五、并发与排队(核心能力)

多个 agent/任务可能同时操作同一个项目,需要保护。放在 `core/concurrency`,由 **Service 层**统一使用,Tool 不各自处理。

### 1. 文件级写锁
* 按规范化后的文件路径加锁。
* 读操作不加锁;写操作先获取锁,后到者等待。
* 需要修改多个文件的操作,必须按固定顺序获取,防止死锁。

### 2. 项目级 Godot 运行队列
* 同一项目同一时间只允许一个 Godot 进程(run / validate / execute / screenshot 等)。
* 其余请求进入 FIFO 队列,依次执行。

### 3. 占用提示(重点)
当请求需要等待时,返回或日志中必须包含:
* 当前占用者(工具名、目标文件/项目、任务 ID)
* 已占用时长
* 自己在队列中的位置

### 4. 超时
* 等待锁和执行任务都必须有超时,超时返回 `LOCK_TIMEOUT`,并附带当前占用者信息。
* 任务崩溃或超时后必须释放锁,不能死锁。

### 5. 范围说明
第一版只保证**同一个 MCP 进程内**有效。跨进程(多个 agent 各自启动 MCP 实例)需要磁盘锁文件,列为可选的后续项,不在第一版实现,但在文档中写明。

---

## 六、阶段计划

**规则:每个阶段自带测试;完成后先测试、验证、整理,再进入下一阶段。不要一次性生成所有工具。**

### 阶段 1:架构与最小可运行 Server
只输出并实现:
* 架构设计文档(含 toolkit 映射表、并发设计)
* 类型系统
* Tool Registry(含分组与按需加载)
* MCP Server(stdio)
* 统一错误处理
* 日志系统(stderr)
* LockManager / TaskQueue 的基础实现与单元测试
* 测试框架
* 一个最小可运行 Tool(例如 `godot_get_version` 或 `utility_ping`)

验收:MCP Client 可以正常连接并调用该工具;`npm test`、`npm run build` 通过。

### 阶段 2:解析器与 Project / File 基础
**先做解析器和往返测试,再做工具。**
* `project.godot`、`.tscn`、`.tres`、`.gdshader`、`.gd`、`.import` 的读取/写入
* 往返测试:读取 → 修改 → 写回 → 再读取,未修改部分必须保持不变(包括未知字段的原样保留、ext_resource / sub_resource id、UID)
* project.godot 读取/修改、项目信息分析、Godot 版本检测、文件扫描
* 文件读写/搜索、目录管理
* UID 查询、UID 引用检查
* Resource 类型识别

验收:不启动 Godot 即可完成大部分项目分析和资源读取。

### 阶段 3:Shader / Material(核心模块)
建立独立的 `ShaderService`、`MaterialService`。

必须建立通用参数模型:
```
ShaderParameter { name, type, defaultValue, hint, hintRange }
```
使未来扩展 Shader Graph、VFX、PostProcess 时不必重新设计基础结构。

Shader 至少覆盖:创建/读取/修改/删除、代码搜索、uniform 分析与增删改、参数分析、shader 类型检测、render_mode 分析、keyword/feature 分析、基础语法检查、引用与使用位置分析、批量替换、模板生成、参数文档生成。

Material 至少覆盖:创建/读取/修改、类型分析、Shader 绑定、Shader 参数读写、Texture 参数绑定与替换、引用分析、使用统计、重复检测、批量修改、参数复制与同步、自动生成。

### 阶段 4:Scene / Node
优先直接操作 `.tscn`。
* 创建/读取/保存/分析 Scene
* Node 查询/创建/删除/重命名/移动/属性修改/父子关系修改/批量操作
* Scene 合并/拆分、PackedScene 分析、Scene 依赖分析、Node 类型统计
* 覆盖 godot-mcp 原有的 create_scene、add_node、save_scene、load_sprite

### 阶段 5:Resource / Asset
通用 Resource Service:
* 创建/查询/属性读写、引用分析、依赖分析
* 批量重命名、移动、复制、删除
* 资源路径修复、UID 修复
* 丢失资源检测、重复资源检测、项目资源统计

### 阶段 6:Script
GDScript 创建/查询、类/函数/信号/export 属性分析、脚本引用分析、搜索、批量修改、基础语法检查。

### 阶段 7:Runtime Adapter
保持独立模块:
```
MCP Tool → RuntimeService → Godot CLI → Process → Output Parser
```
只有这些能力调用 Godot:launch_editor、run_project、stop_project、get_debug_output、validate_project、execute_script、capture_screenshot、export_mesh_library、reimport。
使用第五节的项目级运行队列。Runtime 代码不得进入普通 Tool。

### 阶段 8:第一版整理
* 统计现有工具,检查重复、命名、schema、返回结构、错误结构是否统一
* 生成 `docs/tools.md`:

| Tool | Category | Description | Runtime Required |
|---|---|---|---|

* 完成文档:已知边界、并发说明、与编辑器冲突说明

### 阶段 9(第二版):动画 / UI / TileMap / 粒子 / 导航 / 音频 / 导入设置
按需要逐个领域扩展,每个领域独立成组,不修改核心架构。

---

## 七、测试要求

* 核心 Service 都要有单元测试。
* 包含:Tool schema 校验、Parser、序列化往返、Scene 修改、Shader、Material、Project、并发锁与队列、Runtime Adapter(可用假进程 mock)。
* 测试模式:修改前文件 → Tool → 修改后文件 → 再解析 → 验证结果。
* 绝大多数测试不得依赖 Godot Editor。需要真实 Godot 的测试单独标记,可跳过。
* 最终 `npm test` 与 `npm run build` 必须正常完成。

---

## 八、未来扩展

新增工具时:`NewTool → 调用已有 Service → 注册到 Tool Registry`,不修改核心架构。

**现在只做阶段 1。**