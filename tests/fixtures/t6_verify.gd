extends SceneTree

# T6.5 真实引擎验证脚本(4.6.3 实测跑通)。
#
# 由 tests/sceneWriteTools.real.test.ts 拷进临时工程,以
#   --headless --path <tmp> --script res://t6_verify.gd -- --scene res://scenes/main.tscn --out res://t6_engine_saved.tscn
# 运行。所有断言行以 `T6RESULT ` 前缀打到 stdout,由 TS 侧解析比对;
# 任何 Godot 报错/警告都算失败(TS 侧扫 stdout+stderr)。
#
# 实测到的两条关键事实(决定了本脚本的检查时序):
#   1. --script 模式下由本脚本接管 SceneTree,get_root() 是 Window。
#   2. 场景的 [connection] 段在 PackedScene.instantiate() 期间就已建立,
#      因此**入树之前**就能用 get_signal_connection_list() 读到未触发的连接(避免
#      CONNECT_ONE_SHOT 触发后被自动断开而读不到 flags)。

var _scene_path := "res://scenes/main.tscn"
var _out_path := "res://t6_engine_saved.tscn"

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var i := 0
	while i < args.size():
		var a: String = args[i]
		if a == "--scene" and i + 1 < args.size():
			i += 1
			_scene_path = args[i]
		elif a == "--out" and i + 1 < args.size():
			i += 1
			_out_path = args[i]
		i += 1

	# script_create 生成的 .gd(无 .uid 旁挂)能否被加载
	var generated: Script = load("res://scripts/t6_generated.gd")
	print("T6RESULT load_script|res://scripts/t6_generated.gd|" + ("ok" if generated != null else "null"))

	var packed: PackedScene = load(_scene_path)
	if packed == null:
		push_error("T6_SCENE_LOAD_FAILED: " + _scene_path)
		quit(3)
		return

	var root: Node = packed.instantiate()

	# ① 入树之前:连接已建立且没有任何信号被触发过
	_print_tree(root, root)
	_print_connections(root, root)
	_print_instances(root, root)
	_print_scripts(root, root)

	# ② 入树 → ready 触发;若持久化的 [connection] 真的建立了,root.ready_calls 应为 1
	get_root().add_child(root)
	print("T6RESULT ready_calls_now|" + str(root.get("ready_calls")))
	await process_frame
	print("T6RESULT ready_calls|" + str(root.get("ready_calls")))
	print("T6RESULT group_is_in|" + str(root.get_node("Player").is_in_group("t6_a")))

	# ③ 让引擎按自己的写法 pack + save,供 TS 侧与我们写出的文本做 diff
	var out := PackedScene.new()
	var pack_err := out.pack(root)
	print("T6RESULT pack|" + str(pack_err))
	var save_err := ResourceSaver.save(out, _out_path)
	print("T6RESULT save|" + str(save_err))
	print("T6RESULT ok")
	quit(0)

# ────────────────────────────── 输出辅助 ──────────────────────────────

# 场景根为 ".",其余相对场景根(与 SceneService 的 nodePath 约定一致)。
func _rel(node: Node, scene_root: Node) -> String:
	if node == scene_root:
		return "."
	var rel: String = String(scene_root.get_path_to(node))
	return rel if rel != "" else "."

func _print_tree(node: Node, scene_root: Node) -> void:
	var names := PackedStringArray()
	for g in node.get_groups():
		names.append(str(g))
	print("T6RESULT tree|" + _rel(node, scene_root) + "|" + node.get_class() + "|" + ",".join(names))
	for child in node.get_children():
		_print_tree(child, scene_root)

func _print_connections(node: Node, scene_root: Node) -> void:
	for sig in node.get_signal_list():
		var sig_name: String = str(sig["name"])
		for conn in node.get_signal_connection_list(sig_name):
			var cb: Callable = conn["callable"]
			var target: Object = cb.get_object()
			var target_path: String = "?"
			if target is Node:
				target_path = _rel(target, scene_root)
			print("T6RESULT conn|" + _rel(node, scene_root) + "|" + sig_name + "|" + target_path + "|" + str(cb.get_method()) + "|" + str(conn["flags"]))
	for child in node.get_children():
		_print_connections(child, scene_root)

func _print_instances(node: Node, scene_root: Node) -> void:
	if node.scene_file_path != "":
		print("T6RESULT instance|" + _rel(node, scene_root) + "|" + node.scene_file_path + "|" + ("yes" if node.has_node("Marker") else "no"))
	for child in node.get_children():
		_print_instances(child, scene_root)

func _print_scripts(node: Node, scene_root: Node) -> void:
	var s: Script = node.get_script()
	if s != null:
		print("T6RESULT script|" + _rel(node, scene_root) + "|" + s.resource_path)
	for child in node.get_children():
		_print_scripts(child, scene_root)
