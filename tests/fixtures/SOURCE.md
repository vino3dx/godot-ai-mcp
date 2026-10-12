# tests/fixtures 样例来源记录

记录 `tests/fixtures/sample_project/` 的生成来源、覆盖范围与已知限制。
（本文件是新增的说明文件；被跟踪的 `tests/fixtures/README.md` 未改动。）

## 一、来源（硬性事实）

- **引擎版本**：`4.6.3.stable.official.7d41c59c4`（由 `godot --version` 实测输出）
- **二进制**：`E:\Program Files\Godot Engine\Godot_v4.6.3-stable_win64.exe\Godot_v4.6.3-stable_win64_console.exe`
- **生成日期**：2026-10-12
- **生成方式**：本机 Godot 4.6.3 引擎实际写出（非手写、非从其他项目拷贝）

> 注意：`tests/fixtures/README.md` 中写的目标版本是 **4.7.2**；本次样例按当前实际基线 **4.6.3** 生成。
> 按要求未修改该 README 与 Godot 目标版本声明，故此处显式记录该差异。

### 生成命令

```text
# 1) 让引擎初始化工程并写出 .uid / .import
Godot_v4.6.3-stable_win64_console.exe --headless --path <sample_project> --import

# 2) 运行临时生成器(_gen.gd, 已删除),由引擎写出场景与资源
Godot_v4.6.3-stable_win64_console.exe --headless --path <sample_project> --script res://_gen.gd

# 3) 再次导入,生成 PNG 的 .import
Godot_v4.6.3-stable_win64_console.exe --headless --path <sample_project> --import

# 4) 删除临时生成器与 .godot 缓存
```

## 二、哪些文件由引擎写出，哪些是人工源码

| 文件 | 性质 |
|---|---|
| `project.godot` | **引擎写出**（`ProjectSettings.save()`；含 header 注释、autoload、input map、layer_names） |
| `main.tscn` / `child.tscn` | **引擎写出**（`PackedScene.pack()` + `ResourceSaver.save()`） |
| `shader_material.tres` / `standard_material.tres` | **引擎写出**（`ResourceSaver.save()`） |
| `*.uid`（`child.gd.uid` / `game_state.gd.uid` / `main.gd.uid` / `sample.gdshader.uid`） | **引擎写出**（编辑器导入流程） |
| `icon_fixture.png.import` | **引擎写出**（导入流程；PNG 本身由引擎 `Image.save_png()` 写出） |
| `main.gd` / `child.gd` / `game_state.gd` / `sample.gdshader` | **人工源码**（着色器与脚本属用户源码，引擎不生成） |

## 三、当前覆盖范围

- **project.godot**：header 注释、`[application]`（name/description/main_scene/features）、`[autoload]`、`[input]`（含 `Object(InputEventKey,...)` 多行值）、`[layer_names]`。
- **main.tscn**：多节点类型（Node3D / Camera3D / DirectionalLight3D / MeshInstance3D / Area3D / CollisionShape3D / Timer）；3 个 `ext_resource`（脚本 ×2、被实例化子场景 ×1）；3 个 `sub_resource`；`[connection]` 信号连接；**本文件实测不含 `groups=`（原描述有误，2026-10-12 更正）**；`unique_name_in_owner`；子场景实例（`instance=ExtResource`）；`NodePath` / `PackedStringArray` / `PackedVector3Array` / `Array` / `Dictionary` / `Color` / `Vector2` / `Vector3` / `Transform3D`。
- **child.tscn**：脚本挂载 + 子资源引用。
- **.tres**：`ShaderMaterial`（引用 `.gdshader`，含 `shader_parameter/*`，含值为 `null` 的参数）与 `StandardMaterial3D`。
- **.gdshader**：`shader_type` / `render_mode` / 多种 `uniform` 与 hint。
- **UID**：4 个 `.uid` 旁挂文件 + `.import` 内的 `uid=`。
- **.import**：1 个（PNG）。

## 四、已知限制（明确记录，未静默跳过）

1. **场景/资源头部无 `uid=`**：4.6.3 的**运行时** `ResourceSaver` 不写出 `uid=`（实测注册 `ResourceUID` 也无效）；只有**编辑器**保存才写。真实编辑器保存的工程 61/61 个 `.tscn` 头部都带 `uid=`，故本样例在此维度不及编辑器产物。
2. **无 `load_steps`**：4.6.3 运行时保存不写 `load_steps`；真实工程中仅 4/61 个 `.tscn` 含该字段（旧写法遗留）。因此本样例**不覆盖** `load_steps` 的读写路径。
3. **无继承场景（inherited scene）**：GDScript 无公开 API 以程序方式保存继承场景，本次未生成。
4. **无 `godot-run-log.txt` / `extension_api*.json`**：不属本轮往返验证所需，未生成。
5. **不含 `.godot/` 缓存**：按样例规范不入库。
6. **未覆盖字符串转义**（如路径内引号/反斜杠）与 `PackedByteArray` 等长数组：可在后续追加。

## 五、可复现性

删除 `.godot/` 后重跑 `--import` 可重建导入缓存；样例文件本身由引擎确定性写出，但 `unique_id` / `.uid` 每次生成会不同。

## 六、T6.5 实测结论（真实 Godot 4.6.3，2026-10-12）

验证脚本 `tests/fixtures/t6_verify.gd`，判定用例 `tests/sceneWriteTools.real.test.ts`；引擎 save 出的对照样例如 `tests/fixtures/t6_engine_saved.tscn`。

- 引擎加载 `.tscn` 的 `[connection]` 时会并入 `CONNECT_PERSIST(2) | CONNECT_INHERITED(32)`，因此 `flags=` 读回 = 写入值 `| 34`（0→34、1→35、3→35、4→38、7→39）。
- 引擎保存时 `f = flags & ~32`，且**仅当 `f & ~2 != 0`** 才写出 `flags=f`（34→省略、35→3、38→6、39→7）；仓库据此让写入成为引擎 save 的不动点。
- `[connection]` 段之间**没有空行**（只有 `[node]` 段带尾随空行）；`ext_resource` 块连续、没有块内空行。
- `ext_resource` **不写 `uid=`**（运行时 `ResourceSaver` 亦然；只有编辑器保存才写）。
- 新节点不写 `unique_id=` 也能加载，引擎 save 时自行补上。
- 未验证项（不追）：`binds=`/`unbinds=` 与带参连接、`index=` 兄弟序重排、A→B→A 深层循环实例化、`keepGlobalTransform`、`%unique_name_in_owner`、编辑器保存路径的 `uid=`、`script_create` 生成 `.gd` 的 `.uid` 补写、多行属性值经引擎往返。
