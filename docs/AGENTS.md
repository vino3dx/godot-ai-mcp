# godot-ai-mcp — Agent Project Context

开工前必读 `docs/WORKFLOW.md`(工作流唯一权威版本)。

本文件是 godot-ai-mcp 的长期 Agent 上下文。所有 Agent、所有后续任务默认先阅读本文件，再阅读当前任务说明。具体任务以用户当前任务为最高优先级。

## 1. 项目定位

godot-ai-mcp 是面向 Godot 4.7.2 的独立 MCP Server。

目标：让 AI Agent 在不启动 Godot Editor / Runtime 的情况下，通过文件系统和 Godot 文本资源格式完成绝大多数项目开发操作。

默认操作：

.tscn

.tres

project.godot

.gdshader

.gd

.import

普通项目文件

只有必须运行 Godot 才能完成的能力进入 Runtime Adapter。

明确不做：

Godot Editor Plugin

Editor UI 自动化

Undo/Redo

二进制 .res / .scn 编辑

核心原则：

简单、可靠、可维护

不过度设计

不为凑数量拆 Tool

架构可持续扩展

MCP Server 与 Godot Runtime 解耦

## 2. 技术边界

唯一目标 Godot 版本：

Godot 4.7.2

不要为旧版本增加兼容分支。

MCP SDK：

使用项目实际安装的当前稳定 SDK

不凭记忆假设 API

实现前检查 package.json、实际类型定义和官方文档

stdio：

stdout 只能输出 MCP 协议数据

所有日志必须写 stderr

## 3. 架构

```
MCP Layer
    ↓
Tool Layer
    ↓
Service Layer
    ↓
Core / Parser / Resource Layer
    ↓
FileSystem / Godot CLI
```

目标目录：

```
src/
├─ mcp/
│  ├─ server
│  ├─ registry
│  └─ schemas
├─ core/
│  ├─ project
│  ├─ filesystem
│  ├─ resources
│  ├─ parser
│  ├─ validation
│  └─ concurrency
├─ services/
├─ godot/
│  ├─ cli
│  └─ runtime
├─ tools/
└─ types/
```

Tool Layer

只负责：

MCP 输入输出

Schema

参数校验

调用 Service

返回统一结果

禁止在 Tool 中堆业务逻辑。

Service Layer

负责：

领域业务逻辑

多步骤业务流程

并发锁

调用 Core / Parser

必要时调用 RuntimeService

Core / Parser

负责：

文件系统

Godot 文本格式

Resource 模型

Parser / Serializer

Validation

Core 不得依赖 MCP。

Runtime

独立、可插拔。

普通 Resource / Scene / Shader 操作不得因为方便而调用 Runtime。

## 4. Tool Registry

新增 Tool 尽量只需要：

```
NewTool
→ Schema
→ Registry
```

不应为了增加 Tool 修改 MCP Server 核心代码。

Registry 支持：

领域分组

按组加载

read-only

write

destructive

runtime-required

命名统一：

领域_动作

例如：

scene_create
node_add
shader_create
project_get_info
runtime_run

## 5. 错误规范

统一错误码，例如：

FILE_NOT_FOUND
PARSE_ERROR
INVALID_ARGUMENT
PROJECT_NOT_FOUND
RESOURCE_NOT_FOUND
LOCK_TIMEOUT
TASK_TIMEOUT
RUNTIME_REQUIRED
GODOT_NOT_FOUND
GODOT_PROCESS_FAILED
VALIDATION_FAILED

不同 Tool 不得各自发明错误结构。

## 6. 并发

位置：

`src/core/concurrency/`

由 Service 层统一使用，Tool 不自己实现锁。

文件锁

按规范化文件路径加写锁

写操作等待锁

多文件写操作固定顺序获取锁，避免死锁

Godot 项目运行队列

同一项目同时只能有一个 Godot 进程执行：

run / validate / execute / screenshot / export / reimport

其他请求进入 FIFO。

等待信息应包含：

当前占用者

Tool

文件 / 项目

Task ID

已占用时间

队列位置

锁等待和任务执行必须有超时。超时返回 LOCK_TIMEOUT / TASK_TIMEOUT 并附占用信息。

任务异常、崩溃、超时后必须释放资源。

第一版只保证同一个 MCP 进程内有效。跨进程磁盘锁留作后续。

## 7. Godot 格式原则

这是本项目的重要技术底线：

禁止凭记忆猜 .tscn / .tres / project.godot / .import 格式。

必须优先：

真实 Godot 4.7.2
→ 生成最小测试项目
→ 生成真实样本
→ 样本建立 Parser 测试
→ Parser
→ Serializer
→ Round-trip 测试

特别关注：

load_steps

ext_resource

sub_resource

UID

Variant 文本

属性序列化

Resource 引用

Round-trip：

读取
→ 修改
→ 写回
→ 再读取
→ 验证

未修改内容尽可能保持原样，包括未知字段、Resource ID、UID 和引用关系。

## 8. Runtime 边界

没有 Godot 时，只做静态检查。

例如 Shader：

无 Godot：

括号匹配

shader_type

uniform 声明

render_mode

基础结构

需要 Runtime：

完整编译

实际运行验证

截图

reimport

mesh library export

## 9. 编辑器冲突

Godot Editor 同时打开 MCP 修改的文件时，可能出现覆盖、重载或冲突。

文档必须说明这一点。

可检测时给出：

EDITOR_CONFLICT_WARNING

不要因此引入 Editor Plugin。

## 10. 第一版能力

必须覆盖：

Project
FileSystem
Scene
Node
Resource
Shader
Material
Script
Runtime / Debug

第二版：

Animation
UI / Theme
TileMap / TileSet
Particle
Navigation
Audio
Import Settings

## 11. 当前开发阶段

项目阶段：

Stage 1  架构 + 最小 MCP Server
Stage 2  Parser + Project + File
Stage 3  Shader + Material
Stage 4  Scene + Node
Stage 5  Resource + Asset
Stage 6  Script
Stage 7  Runtime Adapter
Stage 8  第一版整理
Stage 9  第二版扩展

当前只做 Stage 1。

Stage 1：

架构设计

类型系统

Tool Registry

MCP Server

stdio

统一错误

stderr Logger

LockManager

TaskQueue

测试框架

一个最小 Tool

验收：

```
npm test
npm run build
```

Stage 2～9 禁止提前实现。

## 12. 测试规范

核心 Service 必须有测试。

至少覆盖：

Tool Schema

Parser

Serializer

Scene

Shader

Material

Project

Concurrency

Runtime Adapter

优先使用：

```
Before
→ Tool
→ After
→ Parse
→ Assert
```

绝大多数测试不得依赖 Godot Editor。真实 Godot 测试单独标记。

每次修改至少执行：

```
npm test
npm run build
```

测试失败必须修复后再交付。

## 13. Agent 工作协议

每个 Agent 接任务后：

先阅读本文件。

检查 git 状态。

检查 package.json / tsconfig。

检查当前 Stage。

阅读相关代码和测试。

先复用已有 Service / Parser / Type / Validation / Error / Lock。

只实现当前任务，不擅自扩大范围。

修改后运行测试和 build。

失败就修复，不把失败状态交给下一 Agent。

禁止因为“顺便优化”而大规模重构。

如果任务与架构冲突：

先指出冲突

提出最小修改方案

不要默默改变架构

## 14. 模型接力策略

GLM-5.3

负责：

架构

Parser / Serializer

Scene

Shader / Material 核心设计

Runtime Adapter

复杂 Bug

最终 Review

定位：

想清楚怎么做。

GLM-5.3-Flash

负责：

Tool 批量实现

Schema

常规 Service

测试

小范围 Debug

重复性代码

定位：

按既定设计实现。

DeepSeek-V4.1-Flash

负责：

批量编码

常规 Tool

测试

小范围 Debug

模型可以随时替换，项目架构不能依赖某一个模型。

## 15. 任务切割

不要给 Agent：

完成 Stage 3 Shader / Material

而应切成：

Task 3.1  ShaderService 基础接口
Task 3.2  shader_create
Task 3.3  shader_read
Task 3.4  uniform 分析
Task 3.5  uniform 修改
Task 3.6  测试
Task 3.7  Review

每个任务尽量：

单一目标

小范围修改

可独立测试

可独立回滚

## 16. 回复规范

中文优先，结论先行，简洁直接。

代码任务优先：

1. 完整修改后的代码
2. 修改原因
3. 测试结果
4. 一句话总结

不要：

重复用户已知信息

长篇解释显而易见代码

猜测 Godot 格式

为凑数量拆 Tool

为了“完整”提前实现未来 Stage

## 17. 质量底线

以下均不可接受：

编译通过但 Godot 文件实际无效

未运行测试却声称完成

猜测 Godot 4.7.2 格式

Tool 中堆业务逻辑

重复已有 Service

stdout 输出普通日志

锁异常后不释放

Runtime 依赖渗透到普通 Resource 操作

无需求增加旧 Godot 兼容分支

未经允许扩大当前 Stage

## 18. 规则优先级

发生冲突时：

```
用户当前明确任务
    >
本文件项目规范
    >
当前 Stage 范围
    >
Agent 自己的设计偏好
```

一句话目标：

构建一个独立、可靠、模块化、可扩展的 Godot 4.7.2 MCP Server，让 AI Agent 主要通过文件和文本资源直接开发 Godot 项目，只有必要时才调用 Godot Runtime。
