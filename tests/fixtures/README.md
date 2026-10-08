# tests/fixtures —— 真实 Godot 4.7.2 样例

这些文件是**解析器与序列化器的唯一事实来源**（见 `docs/AGENTS.md` 第 7 节、`docs/WORKFLOW.md` 第 3 节：禁止凭记忆猜 `.tscn/.tres/project.godot` 格式）。
**当前目录只有本说明，样例尚未提供**——样例到位前 P2 / P3a（T1 / T2）不能开工。

## 一、必须提供的文件（清单源自 `docs/PLAN_PROMPTS.md` 的 P0「你自己做」）

工程样例统一放 `tests/fixtures/sample_project/`；引擎程序生成的元数据与日志放下表指定路径。

| 文件 | 内容要求 |
|---|---|
| `sample_project/project.godot` | 真实工程配置，段名与键以引擎实际输出为准：至少含 main scene、**autoload**、**input map**、**layer 名**，最好保留编辑器写入的注释 |
| `sample_project/` 主场景 `.tscn` | 同一场景内同时具备：多种节点类型、子资源、信号连接、**groups**、**unique name**、**脚本挂载**、**实例化子场景**（`[ext_resource]` 指向另一个 `.tscn`） |
| 被实例化的子场景 `.tscn` | 主场景用到的那个子场景（本身可以很简单） |
| **继承场景** `.tscn`（inherited） | 以某个场景为 base 再保存出来的继承场景 |
| `sample_project/*.tres` | **ShaderMaterial** 与 **StandardMaterial3D** 各一个 |
| `.gdshader` | 含 `shader_type`、`render_mode`、多个参数声明（尽量覆盖不同类型与范围提示） |
| `.gd` | 一个普通 GDScript，带 `class_name` / 导出变量更好 |
| 带 `.uid` 的资源 | 引擎为资源写出的旁挂 UID 文件（具体文件名以引擎实际输出为准） |
| 一个 `.import` 文件 | 引擎为导入资源写出的导入配置（内容以引擎实际输出为准） |
| `tests/fixtures/godot-help.txt` | `godot --help` **全文**——CLI 选项的唯一依据 |
| `tests/fixtures/godot-run-log.txt` | 一次真实运行的日志，含**至少一条脚本报错**和**至少一条 warning** |
| `data/extension_api-4.7.2.json` | `godot --headless --dump-extension-api` 的输出；体积大时可 gzip 成 `.json.gz`（读取用 node 内置 zlib） |

节点属性需覆盖的 Variant 类型（用于参照真实文本写法）：
`Vector2` / `Vector3`、`Color`、`Transform3D`、`NodePath`、`Array`、`Dictionary`、`PackedVector3Array`，以及 `ExtResource` / `SubResource` 引用。

## 二、来源要求（硬性）

1. **必须由真实 Godot 4.7.2 生成**：在本机用 Godot 4.7.2-stable 新建工程，在编辑器里创建并保存，或由引擎写出。请把 `godot --version`（或 Help → About）的输出一并给出，写进提交信息或回报里。
2. **禁止手写、禁止从旧版本或别的项目拷贝后手改。** 字段顺序、是否出现某些键、UID 与 Variant 文本的具体写法，全部以引擎实际输出为准——本项目已被实测推翻过一次「常识」。
3. **允许最小化，但必须留痕**：若为减小体积删过节点/属性，请在第三节清单里逐项标注 `hand-trimmed` 并说明删了什么。被删过的文件不能再作为「未修改内容原样保留」的基准。
4. **不要做格式化**：不要用编辑器或脚本重排缩进与换行（`.tscn` 的缩进由引擎写出）。
5. **字节要保住**：仓库对 `tests/fixtures/**` 设了 `-text`（见根目录 `.gitattributes`），Git 不做任何 EOL 转换；提交的应当就是引擎刚写出的原样字节。

## 三、清单（生成后逐项打勾，并补上实际文件名）

- [ ] `sample_project/project.godot`（main scene / autoload / input map / layer 名）
- [ ] 主场景 `.tscn`（多节点 / 子资源 / 信号连接 / groups / unique name / 脚本挂载 / 实例化子场景）
- [ ] 被实例化的子场景 `.tscn`
- [ ] 继承场景 `.tscn`
- [ ] ShaderMaterial `.tres`
- [ ] StandardMaterial3D `.tres`
- [ ] `.gdshader`（多个 uniform + hint）
- [ ] `.gd`
- [ ] 至少一个 `.uid` 文件
- [ ] 至少一个 `.import` 文件
- [ ] 节点属性覆盖上表列出的 Variant 类型
- [ ] `tests/fixtures/godot-help.txt`
- [ ] `tests/fixtures/godot-run-log.txt`（含 1 条报错 + 1 条 warning）
- [ ] `data/extension_api-4.7.2.json`（或 `.json.gz`）

## 四、暂不要求

- `.godot/` 目录（引擎缓存）：不入库。
- 二进制资源（`.res` / `.scn`）：本项目明确不做。
