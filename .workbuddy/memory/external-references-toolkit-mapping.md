# godot-mcp-toolkit 命令 → godot-ai-mcp 去向

来源:上传的 `godot-mcp-toolkit-main.zip`(约 100 个命令,MIT)。只参考能力,不复制架构。
新工具名为**草案**,实现时以各阶段为准。「V1」= 第一版,「V2」= 第二版,「不做」= 依赖编辑器/运行中游戏或性价比低。

> 更正:早先我把 classdb 归为"纯文件级"。实际上它查询的是引擎 ClassDB,需要引擎数据。
> 方案:用 Godot CLI 导出一次 API 描述(`--dump-extension-api`,**需在 4.7.2 上验证该参数与输出**),缓存为 JSON,之后 classdb 类查询全是文件操作。

## 项目 / 文件
| toolkit | 新工具(草案) | 阶段 | 说明 |
|---|---|---|---|
| project.get_settings / set_setting | project_get_settings / project_set_setting | V1 | 直接改 project.godot |
| project.get_layer_names / set_layer_names | project_get_layer_names / project_set_layer_names | V1 | project.godot 的 layer_names 段 |
| autoload.manage | project_autoload_list / add / remove | V1 | project.godot 的 [autoload] |
| input_map.action / event | project_input_action_* / project_input_event_* | V1 | project.godot 的 [input] |
| file.delete / folder.create / folder.delete | filesystem_delete / filesystem_create_dir / filesystem_delete_dir | V1 | 带路径守卫,限制在项目目录内 |
| save.list/read/write/delete | — | 不做 | 操作 user:// 存档,与项目开发关系小 |
| asset.list / get_dependencies | asset_list / resource_get_dependencies | V1 | 依赖 = 解析 ext_resource |
| asset.import | runtime_reimport | V1 | 需 Runtime |
| meta.set_limits | — | 不做 | 编辑器桥接的内部机制 |

## 场景 / 节点
| toolkit | 新工具(草案) | 阶段 | 说明 |
|---|---|---|---|
| scene.create / create_inherited / delete | scene_create / scene_create_inherited / scene_delete | V1 | 直接写 .tscn |
| scene.get_tree / query / diff | scene_get_tree / scene_query / scene_diff | V1 | 解析 .tscn |
| scene.instantiate | scene_add_instance | V1 | 写 ext_resource + 实例节点 |
| scene.create_node / delete_node | node_add / node_delete | V1 | |
| node.manage | node_rename / node_move / node_duplicate | V1 | 拆成语义明确的单工具 |
| node.get_property / set_property / get_property_list | node_get_properties / node_set_properties | V1 | 属性列表来自 API 缓存 |
| node.groups | node_groups | V1 | |
| node.set_script | node_set_script | V1 | |
| signal.list / manage | signal_list / signal_connect / signal_disconnect | V1 | .tscn 的 [connection] |
| signal.emit / node.call_method | — | 不做 | 需要活的场景树 |
| scene.open / close / spatial_map, editor.save_scene/refresh/wait_for_idle/set_lsp_status | — | 不做 | 编辑器状态 |
| node.collision_from_sprite | node_add_collision_from_texture | V2 | |
| 3d.create_camera/light/primitive/setup_environment | scene_add_*_preset | V2 | 预设节点/资源模板 |

## 资源 / Shader / Material(toolkit 基本没有,这是新增重点)
| toolkit | 新工具(草案) | 阶段 |
|---|---|---|
| resource.load / write / delete | resource_read / resource_write / resource_delete | V1 |
| procedural.edit_curve/gradient/noise | resource_create_curve / gradient / noise | V2 |
| (无) | shader_* / material_* 全套 | V1(优先) |

## 脚本
| toolkit | 新工具(草案) | 阶段 | 说明 |
|---|---|---|---|
| script.read / write / edit / delete | script_read / script_write / script_edit / script_delete | V1 | |
| script.check | script_check(基础静态)+ runtime_validate_project(完整) | V1 | 完整语法检查需 Godot |

## 运行 / 调试(Runtime Adapter)
| toolkit | 新工具(草案) | 阶段 | 说明 |
|---|---|---|---|
| game.start / stop | runtime_run_project / runtime_stop_project | V1 | 项目级运行队列 |
| editor.get_console, debugger.get_log | debug_get_output | V1 | 来自 CLI 进程输出 |
| execute.code | runtime_execute_script | V1 | 走 `--script` |
| editor.screenshot | runtime_capture_screenshot | V1(可选) | 依赖显示环境,无头下不可用 |
| debug.set_breakpoint/continue/state, playtest 输入注入 | — | 不做 | 需要与运行中的游戏交互 |
| classdb.get_info / search | classdb_get_class / classdb_search | V1 | 见上方更正 |

## 第二版领域(不做在第一版)
animation.* / animationtree.* → animation_*;theme.edit、control.set_layout → ui_*;tileset.*(11) / tilemap.* → tilemap_*;spriteframes.* → animation 或 asset;particles.create → particles_*;navigation.edit_polygon → navigation_*;path2d.edit_curve → node/resource;audiobus.* → audio_*;texture.generate / sound.generate → 暂缓(需要图像/音频编码)。

## godot-mcp 原有 14 个工具的去向
launch_editor / run_project / stop_project / get_debug_output / export_mesh_library / update_project_uids / get_uid(部分)→ Runtime 或 project 域;
get_godot_version → project_get_godot_version(V1,CLI);list_projects / get_project_info → project_*(纯文件);
create_scene / add_node / save_scene / load_sprite → scene_* / node_*(纯文件,save_scene 变为"写盘"语义)。
